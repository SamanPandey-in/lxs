# OPERATIONS.md — running the LXS platform

Runbook for the hosted platform (API + worker + Postgres). The customer-side sensor stack is
covered in `infra/victim/` and the SDK docs. Written for an AWS host (EC2 with docker compose);
the ECS path is sketched in `scripts/deploy/deploy.sh` but not implemented.

| Piece | Where |
|---|---|
| API image | `images/api.Dockerfile` (one image; `ROLE=api\|worker\|all`) |
| Deploy workflow | `.github/workflows/deploy.yml` → `scripts/deploy/deploy.sh` |
| Metrics | `GET /metrics` (Prometheus text), `apps/api/src/plugins/metrics.ts` |
| Backups | `scripts/ops/backup.sh`, `scripts/ops/restore-test.sh` |
| Reference compose | `infra/platform/docker-compose.platform.yml` (local/dev; builds from source) |

---

## 1. Secrets

Never commit any of these. On a compose host keep them in `/opt/lxs/.env` (mode 600, owned by
the deploy user) or inject them from AWS Secrets Manager / SSM at boot. On ECS, reference them
from the task definition.

| Variable | Required | What it is | If lost or leaked |
|---|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string (includes the DB password) | Rotate the DB password, update `.env`, restart |
| `POSTGRES_PASSWORD` | compose only | Password for the bundled Postgres container | As above |
| `SESSION_SECRET` | yes (prod refuses the default) | Signs session cookies, ≥16 chars | Rotating logs every user out; do it on leak |
| `ENCRYPTION_KEY` | yes (prod refuses the default) | 32 bytes (base64 or 64 hex). Encrypts notification channel URLs and signing secrets | **Back it up separately from the DB dumps.** Without it, restored channel URLs cannot be decrypted. Rotate with `pnpm --filter @lxs/api db:reencrypt-channels` |
| `METRICS_TOKEN` | to expose `/metrics` in prod | Bearer token for the scraper, ≥16 chars | Rotate in `.env` and the Prometheus config |
| `RESEND_API_KEY` | if `MAIL_TRANSPORT=resend` | Transactional mail (verification, resets, invites) | Revoke in Resend, issue a new one |
| `SMTP_URL` | if `MAIL_TRANSPORT=smtp` | SMTP credentials | Rotate at the provider |
| `TURNSTILE_SECRET_KEY` | if `CAPTCHA_PROVIDER=turnstile` | Cloudflare Turnstile server key (`TURNSTILE_SITE_KEY` is public) | Rotate in Cloudflare |
| `LLM_API_KEY` | optional | Narrator/assessor provider key; without it incidents keep template summaries | Revoke at the provider |

GitHub (deploy workflow): `DEPLOY_SSH_KEY` and `DEPLOY_SSH_KNOWN_HOSTS` as **production
environment secrets**; `AWS_ROLE_ARN` as a variable (OIDC, no long-lived AWS keys). Non-secret
settings (`NODE_ENV=production`, `PUBLIC_URL`, `APP_URL`, `DASHBOARD_URL`, `CORS_ORIGINS`,
`COOKIE_SECURE=true`, `MAIL_FROM`, ...) live in the same `.env`; see `apps/api/src/env.ts`.

---

## 2. Deploy

### One-time host setup (EC2, docker compose)

1. Instance with Docker + the compose plugin, `curl`, and the AWS CLI if the image is in ECR.
   Give it an instance role with `ecr:GetAuthorizationToken` + pull on the repository, and
   `s3:PutObject`/`s3:ListBucket`/`s3:GetObject` on the backup prefix (section 4).
2. Create `/opt/lxs/` owned by the deploy user with:
   - `docker-compose.yml`: start from `infra/platform/docker-compose.platform.yml`, replace the
     api service's `build:` block with `image: ${LXS_API_IMAGE}`, set `NODE_ENV: production`,
     bind Postgres to loopback (or use RDS and drop the postgres service), and add
     `METRICS_TOKEN: ${METRICS_TOKEN:-}` to the api environment. Use the `proxy` profile (Caddy)
     for TLS.
   - `.env` with the secrets from section 1. `deploy.sh` maintains the `LXS_API_IMAGE=` line.
3. Add the deploy user's public key to `~/.ssh/authorized_keys`; put the private key in the
   GitHub `production` environment as `DEPLOY_SSH_KEY`, and the host key
   (`ssh-keyscan -H <host>`, checked against the console fingerprint) as `DEPLOY_SSH_KNOWN_HOSTS`.
4. In GitHub: create the `production` environment with **required reviewers** (this is the manual
   approval gate) and, optionally, restrict it to `deploy-*` tags. Set variables `DEPLOY_HOST`,
   `DEPLOY_USER`, `DEPLOY_PATH` (default `/opt/lxs`), and repository variables `API_IMAGE`
   (e.g. `<acct>.dkr.ecr.<region>.amazonaws.com/lxs-api`; default GHCR), `AWS_REGION`,
   `AWS_ROLE_ARN` (a role trusting `token.actions.githubusercontent.com` for this repo, allowed
   to push to that ECR repository).

### Shipping a release

```bash
git tag deploy-$(date -u +%Y%m%d).1 && git push origin --tags
```

or run **Deploy** manually from the Actions tab. The workflow:

1. builds `images/api.Dockerfile` and pushes `:sha-<commit>` (+ the tag name), pinned by digest;
2. waits for approval on the `production` environment;
3. runs `scripts/deploy/deploy.sh` over SSH: pin `LXS_API_IMAGE` in `.env`, `docker compose pull`,
   **migrations as a one-off** (`docker compose run --rm --no-deps api pnpm db:migrate`; on
   failure the previous pin is restored and the running service is not touched), then
   `docker compose up -d --no-deps api`, then waits for `/readyz`.

Migrations must stay backwards compatible with the previous release for the minute between the
migration and the restart (add columns/tables first, drop in a later release). The API also
applies pending migrations at boot; the one-off step makes a failing migration stop the deploy
instead of crash-looping the service.

### Rollback

Manual run of **Deploy** with `skip_build` checked and `image` set to the previous digest (it is
in the previous run's summary, and `deploy.sh` logs the previous pin). This redeploys the old
image; it does **not** roll back migrations. If a migration itself has to be undone, restore from
backup (section 4) or ship a forward fix.

### Dashboard

There is no dashboard Dockerfile yet, so the workflow does not build it. Run it with
`npm run build && npx next start` behind the same Caddy, or on a static/Node host, with
`LXS_API_URL` set at runtime (it reads `/api/config` per request; see `docs/PERFORMANCE.md` #2).
Add it to `deploy.yml` once `images/dashboard.Dockerfile` exists.

---

## 3. Metrics

`GET /metrics` on the API port. When `METRICS_TOKEN` is set it requires
`Authorization: Bearer <token>`; without a token it is open in development and **absent (404) in
production**. The route bypasses nothing else (global rate limit still applies).

| Metric | Type | Labels |
|---|---|---|
| `lxs_ingest_requests_total` | counter | `outcome` = accepted, quota_exceeded, error |
| `lxs_ingest_events_total` | counter | `outcome` = accepted, duplicate, rejected, throttled |
| `lxs_ingest_bytes_total` | counter | `outcome` |
| `lxs_queue_depth` | gauge (collected on scrape) | `queue`, `state` = queued, active |
| `lxs_detection_latency_seconds` | histogram | event `received_at` → incident written |
| `lxs_worker_job_duration_seconds` | histogram | `queue`, `outcome` = ok, error |
| `lxs_llm_calls_total` | counter | `provider`, `model`, `outcome` |
| `lxs_llm_tokens_total` | counter | `provider`, `model`, `direction` = input, output |
| `lxs_llm_cost_usd_total` | counter | `provider`, `model` (list-price estimate; 0 for unknown models) |
| `lxs_notification_deliveries_total` | counter | `channel_type`, `status` = ok, failed |
| `lxs_http_request_duration_seconds` | histogram | `method`, `route` (pattern), `status_code` |
| `lxs_process_*` | prom-client defaults | CPU, memory, event loop lag, GC |

Labels never carry project ids, IPs or URLs, so the endpoint exposes no tenant data.

Worker metrics are recorded in the process that runs the worker. With `ROLE=all` (the default
deployment) everything is on one endpoint. A `ROLE=worker` process starts no HTTP server, so its
job/LLM/notification metrics are not scrapeable yet; split roles need a metrics listener on the
worker first.

Prometheus scrape config (token in a file, not inline):

```yaml
scrape_configs:
  - job_name: lxs-api
    scheme: https
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/lxs-metrics-token
    static_configs:
      - targets: ['api.example.com']
```

Starter alerts: `rate(lxs_worker_job_duration_seconds_count{outcome="error"}[10m]) > 0`,
`lxs_queue_depth{queue="process-events",state="queued"} > 100` for 5 m,
`histogram_quantile(0.95, rate(lxs_detection_latency_seconds_bucket[10m])) > 30`,
`increase(lxs_notification_deliveries_total{status="failed"}[30m]) > 0`,
`increase(lxs_llm_cost_usd_total[1d]) > <budget>`.

Local check: `curl -s localhost:8080/metrics | grep ^lxs_`.

---

## 4. Backups (H6)

### What and where

`scripts/ops/backup.sh` runs `pg_dump -Fc` (custom format, compressed) to
`BACKUP_DIR/lxs-<UTC timestamp>.dump`, verifies the dump's table of contents, uploads it to
`BACKUP_S3_URI` (SSE-S3 by default, `BACKUP_S3_SSE=aws:kms` + `BACKUP_S3_KMS_KEY_ID` for KMS),
and prunes local copies older than `BACKUP_RETENTION_DAYS` (14). S3 retention belongs to the
bucket: enable versioning, block public access, and add a lifecycle rule (e.g. 35 days, or
Glacier after 30 / expire after 365). Use a `pg_dump` client at least as new as the server
(Postgres 16). The `pgboss` schema is included; it is safe to restore with the rest.

The dump contains encrypted notification channel URLs, password hashes and all event data.
Treat the bucket as sensitive, and keep `ENCRYPTION_KEY` in a different place (Secrets
Manager), or restored channels are unreadable.

### Schedule

cron (nightly 02:30 UTC, before the 03:00 retention purge), on the DB host or any host with
network access and `pg_dump`:

```cron
30 2 * * * lxs  set -a; . /opt/lxs/backup.env; set +a; /opt/lxs/scripts/ops/backup.sh >> /var/log/lxs-backup.log 2>&1
```

or a systemd timer:

```ini
# /etc/systemd/system/lxs-backup.service
[Unit]
Description=LXS nightly pg_dump
After=network-online.target

[Service]
Type=oneshot
User=lxs
EnvironmentFile=/opt/lxs/backup.env
ExecStart=/opt/lxs/scripts/ops/backup.sh

# /etc/systemd/system/lxs-backup.timer
[Unit]
Description=Run LXS backup nightly

[Timer]
OnCalendar=*-*-* 02:30:00 UTC
Persistent=true
RandomizedDelaySec=5m

[Install]
WantedBy=timers.target
```

`systemctl enable --now lxs-backup.timer`; check with `systemctl list-timers` and
`journalctl -u lxs-backup`. `backup.env` (mode 600) holds `DATABASE_URL`, `BACKUP_DIR`,
`BACKUP_S3_URI`. Alert on a non-zero exit (`OnFailure=` unit, or a cron wrapper) and on the
newest S3 object being older than 26 h.

If Postgres runs in the compose stack and the host has no `pg_dump`, run the script in a
client container: `docker run --rm --network <compose network> -v /opt/lxs:/opt/lxs
--env-file /opt/lxs/backup.env postgres:16 bash /opt/lxs/scripts/ops/backup.sh` (the image
has no AWS CLI; upload from the host or use an image that has both). On RDS, keep automated
snapshots/PITR on as well; these logical dumps are the portable, restore-tested copy.

### Restore test (monthly, and after every schema-heavy release)

```bash
ADMIN_DATABASE_URL=postgres://admin:...@scratch-host:5432/postgres \
BACKUP_S3_URI=s3://lxs-backups/prod/ MIN_EVENTS=1 \
  scripts/ops/restore-test.sh            # or: restore-test.sh /path/to/lxs-....dump
```

It restores the newest dump into a throwaway database `lxs_restore_test_<epoch>`, prints the
applied drizzle migrations and exact row counts per table, checks that migrations are recorded,
incidents reference existing projects and `events` has at least `MIN_EVENTS` rows, then drops the
database (also on failure). Run it against a scratch server, not production. Record the date,
dump name and restore time. Verified on 2026-11-23 against a scratch Postgres 16 container:
45,000 events, 9 migrations, restored in 4 s.

### Restoring for real

1. Stop writers: `docker compose stop api` (sensors keep buffering and retry on 503).
2. Fetch the dump: `aws s3 cp s3://lxs-backups/prod/lxs-<stamp>.dump /tmp/`.
3. Restore into a new database, then swap, so the broken one is kept for forensics:
   ```bash
   psql "$ADMIN_DATABASE_URL" -c 'create database lxs_restored'
   pg_restore --no-owner --no-privileges --exit-on-error -d "<url of lxs_restored>" /tmp/lxs-<stamp>.dump
   ```
   Point `DATABASE_URL` at `lxs_restored` (or rename databases while nothing is connected).
4. Make sure `.env` has the **same `ENCRYPTION_KEY`** the backup was taken with.
5. `docker compose up -d api`. Boot applies any newer migrations. Check `/readyz`, log in, open
   an incident, and send a test notification.
6. Events between the dump and the incident are lost unless sensors still buffer them; note the
   window in the incident report.

---

## 5. Not done yet

- ECS deploy target (`deploy.sh` exits with a TODO).
- Dashboard image and its deploy.
- A metrics listener for `ROLE=worker` processes.
- AWS resources themselves (backup bucket, Secrets Manager entries, WAF, status page): owner
  items, see `docs/IMPLEMENTATION-PLAN.md` H6.

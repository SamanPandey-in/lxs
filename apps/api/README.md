# @lxs/api

LXS platform API: Fastify 5 + TypeScript (ESM) + Drizzle ORM + PostgreSQL 16, pg-boss for jobs,
Postgres LISTEN/NOTIFY for SSE fan-out. One codebase, `ROLE=api|worker|all`.

Boot needs **only Postgres** (no LLM, no external auth, no other service).

## Run it

```bash
# 1. Postgres
docker compose -f infra/platform/docker-compose.platform.yml up -d postgres

# 2. Install (repo root) and configure
pnpm install
cp .env.example .env            # defaults work for local dev

# 3. Migrate + seed (demo user, project acme-shop, dev ingest key)
pnpm db:migrate
pnpm db:seed

# 4. Run
pnpm --filter @lxs/api dev        # tsx watch, http://localhost:8080
```

The API also applies migrations on boot, so step 3's `db:migrate` is optional. `db:seed` prints:

```
login      : demo@lxs.dev / demo1234
project    : acme-shop (<project uuid>)
ingest key : ds_dev_0000000000000000000000000000000000000000   (DEV ONLY)
```

Whole platform in Docker: `docker compose -f infra/platform/docker-compose.platform.yml up -d --build`
(add `--profile proxy` for Caddy on :80/:443).

Other scripts: `build` / `typecheck` (tsc), `db:generate` (drizzle-kit, after editing `src/db/schema.ts`), `start` (tsx, no watch).

## Layout

```
src/index.ts            boot: env -> migrate -> pg-boss -> SSE hub -> worker -> listen
src/app.ts              Fastify app + plugin/route registration
src/env.ts              zod-validated env (fails fast)
src/db/                 schema.ts (Drizzle), migrations/, migrate.ts, seed.ts
src/plugins/            error-handler, bearer-key (ingest keys), auth-session (cookie), rate-limit, sse
src/modules/            route modules (system, auth, ingest, agent, events, projects, incidents, response, insights, demo, notifications)
src/worker/             process-events.ts (the 8.4 algorithm), maintenance.ts, detection.ts (+ detection-fallback.ts)
src/jobs/queue.ts       pg-boss wrapper (falls back to in-process work if pg-boss cannot start)
```

Detection comes from `@lxs/detection` (`tagEvent`, `evaluateChain`); if that package cannot be imported the
worker uses `src/worker/detection-fallback.ts` (same signatures). `GET /v1/system` reports which one is active.

## Auth

* **Machine API** (`/v1/agent/*`, `/v1/ingest`): `Authorization: Bearer ds_<prefix>_<secret>`.
* **Dashboard API** (everything else under `/v1`): cookie `ds_session` from `POST /v1/auth/login`
  (HttpOnly, SameSite=Lax). Mutations check the `Origin` header against `CORS_ORIGINS`.
  `DEV_AUTH_BYPASS=true` makes anonymous requests act as the oldest user (dev only).
* Errors always look like `{"error":{"code","message","details?","request_id"}}`.

## P0 endpoints - curl

```bash
API=http://localhost:8080
KEY=ds_dev_0000000000000000000000000000000000000000
```

**Health**

```bash
curl $API/healthz
curl $API/readyz
```

**Register a sensor** (returns `sensor_id`, project salt, intervals)

```bash
curl -X POST $API/v1/agent/register \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"hostname":"victim-1","agent_version":"0.1.0","sdk_version":"0.1.0",
       "manifest":{"decoys":[
         {"decoy_key":"web-admin-admin","type":"web-admin","mount":"/admin"},
         {"decoy_key":"ssh-db-backup-01","type":"ssh","mount":"22","persona":"db-backup"}],
        "assets":[{"pattern":"/api/payments/*","name":"Payments API","criticality":"critical"}]}}'
```

**Heartbeat**

```bash
curl -X POST $API/v1/agent/heartbeat \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"sensor_id":"<sensor_id>","applied_policy_version":1,
       "decoys":[{"decoy_key":"ssh-db-backup-01","status":"online"}]}'
```

**Policy** (ETag; send `If-None-Match` to get `304`)

```bash
curl -i $API/v1/agent/policy -H "Authorization: Bearer $KEY"
curl -i $API/v1/agent/policy -H "Authorization: Bearer $KEY" -H 'If-None-Match: "pv-1-da39a3ee"'
```

**Ingest** (optionally `-H 'Content-Encoding: gzip'` with a gzipped body) -> `202 {accepted, duplicates, rejected}`

```bash
curl -X POST $API/v1/ingest \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"sensor_id":"<sensor_id>","events":[{
        "id":"01JC8Z4T7Q2W9F0X1M3N5P7R9S","schema_version":1,"timestamp":"2026-11-01T10:42:17.311Z",
        "sensor":"ssh","decoy_id":"ssh-db-backup-01","is_decoy":true,"src_ip":"203.0.113.66",
        "dst_service":"ssh:22","event_type":"command.exec","outcome":"success",
        "username":"admin","command":"cat /srv/exports/customer_data.csv"}]}'
```

Sending the same event `id` again returns `{"accepted":0,"duplicates":1}`. Invalid events are listed in `rejected`;
if none are valid the response is `422`.

**Self-test report**

```bash
curl -X POST $API/v1/agent/selftest-report \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"sensor_id":"<sensor_id>","passed":true,"checks":[{"name":"no-egress","passed":true}]}'
```

**Events** (session; cursor-paginated; filters: `incident, attacker, src_ip, event_type, is_decoy, simulated, since, until, q, order, limit`)

```bash
curl -c cj -X POST $API/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"demo@lxs.dev","password":"demo1234"}'

PID=<project uuid printed by db:seed>
curl -b cj "$API/v1/projects/$PID/events?limit=20&is_decoy=true"
curl -b cj "$API/v1/projects/$PID/events?limit=20&cursor=<next_cursor>"
```

## Trying the full pipeline without an agent

```bash
# Replay a scripted attack (targeted | opportunistic | noise) through the real ingest + detection path
curl -b cj -X POST $API/v1/projects/$PID/demo/replay -H 'content-type: application/json' -d '{"scenario":"targeted"}'

curl -b cj $API/v1/projects/$PID/overview
curl -b cj $API/v1/projects/$PID/incidents
curl -b cj $API/v1/incidents/<iid>
curl -b cj -X POST $API/v1/incidents/<iid>/actions -H 'content-type: application/json' \
     -d '{"type":"block_ip","params":{"duration_hours":24},"reason":"demo"}'   # bumps policy_version; agents pick it up on next poll
curl -N -b cj "$API/v1/stream?project=$PID"                                    # SSE
```

## Endpoint catalogue

| Method | Path | Auth |
|---|---|---|
| GET | `/healthz`, `/readyz` | none |
| POST | `/v1/auth/login`, `/v1/auth/signup`, `/v1/auth/logout`; GET `/v1/me` | - / session |
| POST | `/v1/agent/register`, `/v1/agent/heartbeat`, `/v1/agent/selftest-report` | ingest key |
| GET | `/v1/agent/policy` (ETag) | ingest key |
| POST | `/v1/ingest` (gzip ok) | ingest key |
| GET, POST | `/v1/projects` | session |
| GET, PATCH | `/v1/projects/:pid` | session / owner |
| GET | `/v1/projects/:pid/onboarding`, `/overview`, `/events`, `/incidents`, `/attackers`, `/attack-matrix`, `/decoys`, `/containment`, `/audit` | session |
| GET, POST | `/v1/projects/:pid/keys`; DELETE `/keys/:kid` | owner |
| GET, POST | `/v1/projects/:pid/blocklist`; DELETE `/blocklist/:bid` | session / analyst |
| GET | `/v1/projects/:pid/iocs?format=json\|csv\|stix&incident=` | analyst |
| GET, PATCH | `/v1/incidents/:iid` | session / analyst |
| GET | `/v1/incidents/:iid/events` | session |
| GET, POST | `/v1/incidents/:iid/notes` | session / analyst |
| POST | `/v1/incidents/:iid/actions` (`block_ip`, `unblock_ip`, `export_iocs`) | analyst |
| GET | `/v1/attackers/:aid` | session |
| GET, POST, DELETE | `/v1/projects/:pid/notification-channels[/:cid]`, POST `/:cid/test` (config only, no delivery) | owner |
| POST | `/v1/projects/:pid/demo/replay` | owner, demo projects |
| GET | `/v1/stream?project=:pid` (SSE) | session |
| GET | `/v1/system` | owner |

### SSE frames (`StreamEventName`)

`incident.new`, `incident.updated`, `incident.ai`, `event.new` (batch: `{total, events:[<=50 compact]}`),
`sensor.status`, `action.applied`, `heartbeat` (every 15 s, plus a `: keep-alive` comment). Missed
`incident.*` frames are replayed from a 1 000-frame in-memory ring on `Last-Event-ID`.

## Background jobs

`process-events` (per ingest request, 5 retries with backoff, advisory lock per `(project, src_ip)`),
`sweep-unprocessed` (1 min), `blocklist-expiry` (1 min, bumps `policy_version`), `auto-close-noise` (hourly),
`retention-purge` (03:00 UTC), sensor staleness (30 s timer). If pg-boss cannot start, ingest processes events
in-process and the schedulers fall back to timers.

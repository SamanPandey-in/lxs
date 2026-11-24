# DATA-HANDLING.md — what LXS keeps, why, and for how long

LXS is a hosted honeypot SOC. Customers point decoys and sensors at the internet, and LXS
stores what attackers do to them. That telemetry includes attacker IP addresses and, because
decoys present login prompts, **credentials attackers typed**. This page says what is
collected, how long it is kept, how it can be exported and deleted, and who else processes it.

Legal drafts built on this page: [legal/PRIVACY-DRAFT.md](legal/PRIVACY-DRAFT.md) and
[legal/TERMS-DRAFT.md](legal/TERMS-DRAFT.md) (both need legal review). Vulnerability
reports: [SECURITY.md](../SECURITY.md).

---

## 1. What is collected

| Data | From | Why | Where |
|---|---|---|---|
| Account: email, username, name, scrypt password hash | the customer at signup | sign-in, invites, password reset | `users` |
| Organization, members, roles, invites | the customer | tenancy and access control | `organizations`, `memberships`, `org_invites` |
| Project settings: allowlist CIDRs, retention, AI settings | the customer | detection and policy | `projects` |
| Ingest keys | generated | sensor authentication; only `sha256(key)` and a short prefix are stored | `api_keys` |
| Sensor and decoy metadata: hostname, versions, manifest, health | the agent | fleet health | `sensors`, `decoys` |
| **Decoy events**: source IP and port, timestamps, service, method/URL/user agent, commands typed, file hashes, usernames and passwords tried | decoys via the agent | detection, correlation, incident evidence | `events` (`fields`, and the original record in `raw`) |
| Attacker profiles: IP, counts, fingerprints, label | derived | correlation across events | `attackers` |
| Incidents, detections, notes, AI summaries | derived / analysts | the SOC workflow | `incidents`, `detections`, `incident_notes`, `ai_summaries` |
| Response actions and blocklist | analysts | blocking attackers at the sensor | `response_actions`, `blocklist_entries` |
| Alert channels: Slack/webhook URL and signing secret | the customer | alert delivery; AES-GCM encrypted with `ENCRYPTION_KEY` | `notification_channels` |
| Audit log: actor, action, target, IP, user agent | every change | accountability | `audit_logs` |

LXS does not collect data about the customer's real users: decoys only see traffic that
should never reach them. SDK middleware (`prod.*` telemetry) reports signals about real
assets (e.g. a honeytoken used against a real login) and is opt-in per deployment.

### Captured credentials

Decoys record what attackers type. At ingest (`packages/normalizer`):

- a password from the bundled common-credentials list (`data/wordlists/common-creds.txt`) is
  stored in clear (`password_clear`), because "root/admin" is not a secret and the detection
  rules need it;
- any other password is stored only as a mask (`a***n`) plus `sha256(project salt + password)`;
- empty passwords store nothing.

The original sensor record (`raw`) can also contain the typed password until it is dropped
(section 2).

## 2. Retention

Retention comes from the organization's **plan** (`apps/api/src/lib/plans.ts`). Plans are
configuration, not billing; an operator sets them with
`pnpm --filter @lxs/api db:set-plan set <org> <plan>`.

| Plan | Events | Original record (`raw`) | Projects | Active ingest keys |
|---|---|---|---|---|
| `free` (default) | `RETENTION_DAYS` (30) | `RAW_RETENTION_DAYS` (7) | `MAX_PROJECTS_PER_ORG` (5) | `MAX_KEYS_PER_ORG` (10) |
| `team` | 90 days | 14 days | 25 | 100 |
| `custom` | 365 days | 30 days | 1000 | 5000 |

- A project can keep events for less than its plan allows (`retention_days` in Settings),
  never more. The API refuses a longer value.
- The nightly `retention-purge` job (03:00 UTC, `apps/api/src/worker/maintenance.ts`) deletes
  events past retention and nulls `raw` past the raw window. Incidents, attackers and detections
  are kept with the project; their evidence links to deleted events simply stop resolving.
- Settings → Data shows the numbers that apply to the current project.

### Captured-credential hashing

The same nightly run rewrites every **processed** event older than `CREDENTIAL_HASH_DAYS`
(default 30, minimum 2):

- `password_clear`, `password_masked` and `password_sha256` are removed;
- `password_hash` = `sha256:<hex>` of `CREDENTIAL_PEPPER` + the password is added, with
  `password_length` and `password_common: true` when the password was in the common list.
  When only the salted digest was ever stored, the pepper is applied to that digest instead
  (`password_hash_of: "salted_sha256"`; no length);
- a top-level `raw.password` still present is replaced with the same hash;
- the username is kept.

`CREDENTIAL_PEPPER` is per deployment, at least 16 characters, required in production, and
must not be stored with the database backups. Losing it only means new hashes no longer match
old ones; nothing needs decrypting.

**Detection is unaffected.** Rules read `password_clear` (R06 "default/weak credentials" and
the "uncommon successful login" fact in `packages/detection`). Events are scored when they are
processed, and the correlator only reads back processed events from the previous 24 hours
(`INACTIVITY_MS` in `worker/process-events.ts`). The hashing job only touches processed events
at least 2 days old, so scoring of new chains never sees a hashed event and the golden tests
are unchanged. Old incidents keep the verdicts they were given. The dashboard shows a hashed
password as "(hashed)", and the IOC export emits `username:sha256:<hex>` for accepted common
credentials once hashed.

## 3. Export

`POST /v1/projects/:pid/export` (owner) queues a pg-boss job (`export-project`) that writes a
tar bundle:

```
manifest.json               format, project, per-table row counts and sha256, exclusions
tables/<table>.ndjson.gz    one JSON object per row, gzip
```

Tables: project, sensors, decoys, api_keys, attackers, incidents, detections, incident_notes,
ai_summaries, events, blocklist_entries, response_actions, honeytokens, notification_channels,
containment_reports, audit_logs. Rows stream from a Postgres cursor through gzip to disk; no
table is held in memory.

**Not exported:** the project password salt, ingest key hashes, honeytoken value hashes, and
the encrypted alert URLs and signing secrets. Captured credentials are exported as stored.

- `GET /v1/projects/:pid/exports` lists the last 20 (owner).
- `GET /v1/projects/:pid/exports/:eid/download` streams one (owner) for `EXPORT_TTL_HOURS`
  (24) after it is built; then it answers 410 and maintenance deletes the file.
- Five exports per project per day; one at a time.
- Requests, completions and downloads are in the audit log.
- Storage: `EXPORT_STORAGE=local` writes to `EXPORT_DIR` (default `./var/exports`; mount a
  volume in production and keep it out of public paths). `s3` is an interface stub: the
  dependency is not installed yet and the API refuses to boot with it.

## 4. Delete

### A project

`DELETE /v1/projects/:pid` (owner) with `{"confirm": "<project slug>"}`:

1. The project is hidden from every project query and route at once (404).
2. Its ingest keys are revoked, so ingest and agent calls are refused immediately.
3. It can be restored with `POST /v1/projects/:pid/restore` (owner) for
   `PROJECT_DELETE_GRACE_DAYS` (default 7). Revoked keys stay revoked; create a new one.
   Settings → Data shows a restore banner for deleted projects in orgs you own.
4. After the grace period the nightly job deletes its events in batches, its export files, and
   then the project row, which cascades to everything else under it. This is final; backups
   still hold it until they age out (see OPERATIONS.md section 4).

Delete, restore and purge are audited. A deleted project's slug stays reserved until it is
purged.

### An account

`DELETE /v1/me` with `{"password": "..."}`:

- refused (409 `E_LAST_OWNER`) while you are the only owner of an organization that has other
  members: make someone else an owner first;
- otherwise the user row, its tokens and its memberships are deleted; organizations where you
  were the only member are marked deleted, their projects go through the project soft-delete
  path above, and the organization row is purged once its projects are.

### Backups

Nightly `pg_dump` backups (OPERATIONS.md section 4) contain everything above. They are kept
for `BACKUP_RETENTION_DAYS` locally and per the bucket lifecycle rule in S3, so deleted data
disappears from backups only when those age out.

## 5. Sub-processors

| Service | When | What it receives |
|---|---|---|
| Hosting (e.g. AWS) | always | everything, encrypted at rest per the provider's defaults |
| LLM provider: Anthropic, OpenAI or Google (`LLM_PROVIDER`) | only with `LLM_API_KEY` set and AI enabled on the project | per-incident summaries of decoy events: event types, decoy ids, commands, URLs, rule reasons. Passwords and `pass=`/`token=`-style values are redacted (`worker/prompt.ts`, `worker/narrative.ts`); no account data |
| Email: Resend or an SMTP relay (`MAIL_TRANSPORT`) | account emails | recipient address and the message (verification, reset, invite links) |
| Cloudflare Turnstile (`CAPTCHA_PROVIDER=turnstile`) | signup and password reset | the captcha token and the client IP |
| Slack / customer webhooks | configured by the customer | incident alerts the customer routed there |

## 6. Security contact

Report vulnerabilities and data-handling concerns to **security@REPLACE-ME.example**
(placeholder; see [SECURITY.md](../SECURITY.md)).

## 7. Configuration summary

| Variable | Default | Meaning |
|---|---|---|
| `RETENTION_DAYS` | 30 | Event retention on the free plan |
| `RAW_RETENTION_DAYS` | 7 | `raw` retention on the free plan |
| `MAX_PROJECTS_PER_ORG`, `MAX_KEYS_PER_ORG` | 5, 10 | Free-plan caps |
| `CREDENTIAL_HASH_DAYS` | 30 (min 2) | Age at which captured passwords are hashed |
| `CREDENTIAL_PEPPER` | dev value; **required in production** | Pepper for those hashes |
| `PROJECT_DELETE_GRACE_DAYS` | 7 | Restore window before a hard purge |
| `EXPORT_STORAGE` | `local` | `s3` is not implemented yet |
| `EXPORT_DIR` | `./var/exports` | Where local bundles live |
| `EXPORT_S3_BUCKET`, `EXPORT_S3_PREFIX` | unset, `exports/` | For the future S3 adapter |
| `EXPORT_TTL_HOURS` | 24 | Download window |

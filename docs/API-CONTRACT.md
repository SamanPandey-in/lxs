# API-CONTRACT.md — frozen at Phase 0

One page. Everything mocks against this. `schema_version: 1` — **add fields, never remove them.**
Authoritative types live in `packages/schema/src/`; this page is the human-readable index.

## Base

`http://localhost:8080` in dev. All paths prefixed `/v1` except health probes.

## Auth, two kinds

| Kind | Header / mechanism | Used by | Scope |
|---|---|---|---|
| Ingest key | `Authorization: Bearer ds_<prefix>_<secret>` | agent, simulator, attacker-api safe mode | one project; ingest + agent routes only |
| Session | signed cookie | dashboard | one org, all read + analyst routes |

Dev seed key: `ds_dev_0000000000000000000000000000000000000000` (project `acme-shop`). Never in production.

## Error envelope (every non-2xx)

```json
{ "error": { "code": "invalid_event", "message": "…", "details": {}, "request_id": "01JC…" } }
```

## Sensor-facing routes (ingest key)

| Method | Path | Body → Response |
|---|---|---|
| POST | `/v1/agent/register` | `AgentRegister` → `{ sensor_id, policy_version }` |
| POST | `/v1/agent/heartbeat` | `AgentHeartbeat` → `{ ok, policy_version }` |
| GET | `/v1/agent/policy` | — → `AgentPolicy` (ETag; `304` when unchanged) |
| POST | `/v1/ingest` | `IngestBatch` → **`202`** `{ accepted, duplicates }` |
| POST | `/v1/agent/selftest-report` | `ContainmentReport` → `{ ok }` |

Ingest rules: validate → de-dup on `(project_id, event_uid)` → insert → enqueue → return `202`. **Never** block the sensor on processing. Duplicates are absorbed silently, not errors. Max 500 events per batch.

## Analyst-facing routes (session)

| Method | Path | Returns |
|---|---|---|
| GET | `/v1/projects/:pid/overview` | `Overview` |
| GET | `/v1/projects/:pid/events` | cursor page of `StoredEvent` |
| GET | `/v1/projects/:pid/incidents` | page of `IncidentSummary` (filter: status, label, severity) |
| GET / PATCH | `/v1/incidents/:iid` | `IncidentDetail` / status + assignee |
| GET | `/v1/incidents/:iid/events` | chain events |
| POST | `/v1/incidents/:iid/notes` | `{ body }` → note |
| POST | `/v1/incidents/:iid/actions` | `{ type: block_ip \| unblock_ip \| export_iocs, params }` |
| GET | `/v1/projects/:pid/attackers`, `/v1/attackers/:aid` | `AttackerProfile` |
| GET | `/v1/projects/:pid/attack-matrix` | heatmap cells |
| GET | `/v1/projects/:pid/decoys`, `/containment` | health + posture |
| GET / POST / DELETE | `/v1/projects/:pid/blocklist[/:bid]` | blocks |
| GET | `/v1/projects/:pid/iocs?format=json\|csv&incident=` | export |
| GET | `/v1/projects/:pid/audit` | audit trail |
| GET | `/v1/projects/:pid/onboarding` | checklist state |
| GET / POST / DELETE | `/v1/projects/:pid/keys[/:kid]` | key management (owner) |
| POST | `/v1/projects/:pid/demo/replay` | `{ scenario }` → replays canned events (demo projects only) |
| GET | `/v1/stream?project=:pid` | **SSE** |
| GET | `/healthz`, `/readyz` | liveness / readiness (no auth) |

## SSE frames on `/v1/stream`

Named events: `event.new` · `incident.new` · `incident.updated` · `incident.ai` · `sensor.status` · `action.applied` · `heartbeat`.
Heartbeat comment every 15 s. Client reconnects with backoff and refetches on reconnect — the stream is a nudge, not the source of truth.

## The one event

`DecoyEvent`, flat, in `packages/schema/src/event.ts`. The agent generates `id` (ULID) and it is the idempotency key. Server assigns `project_id`, `received_at`, `incident_id`, `attacker_id`, `stage`, `techniques`, `tags`, `processed_at`.

Required on every event: `id`, `schema_version`, `timestamp`, `sensor`, `is_decoy`, `src_ip`, `dst_service`, `event_type`.

## Detection contract (pure, in `packages/detection`)

```ts
tagEvent(event, ctx)      => { category, techniques, stage, ruleHints }
evaluateChain(events, ctx) => { detections, score, severity, label,
                                stagesReached, realAssetReached, honeytokenUsed }
```

No I/O, no clock reads except `ctx.now`, no randomness. Severity bands: Low <25 · Medium 25–49 · High 50–74 · Critical ≥75. Labels: `noise` · `opportunistic` · `targeted`.

**Floors are sticky and raise both severity and score.** A floor lifts the displayed
score into its band (Critical → 75, High → 50) so the two never contradict each other on
screen. The honest uncapped sum stays available as `rawScore` for the detections ledger.
Displayed score is capped at 100.

## Frozen numbers (locked by golden tests — changing a rule that breaks these fails CI)

| Scenario | Running score | End state |
|---|---|---|
| `ps-attacker` | 5 → 10 → 20 → 45 → 50 → 60 → 70 → floor | **Critical · Targeted** |
| `noise` | 5 + 5 + 3 + 10 | **23 · Low · Noise** |
| `opportunistic` | 5 + 10 + 25 + 5 + 5 + 15 | **65 · High · Opportunistic** |
| `honeytoken` | 65 raw, floored to **75** | **Critical · Targeted** |

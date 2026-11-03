# PROGRESS.md — where we are against the original plan

Measured against `BREAKDOWN.md` §11 (the ten phases) and `PERFORMANCE.md` (the five
performance items). Last updated 2026-10-31.

Everything marked **Done** below was verified by running it, not by reading the code.
Where something is partial, the gap is named.

---

## Headline

**The product works end to end.** A simulated attack chain goes decoy → agent/ingest →
detection → one correlated incident → dashboard → one-click block → agent policy, and the
documented scores reproduce exactly. 109 tests pass, typecheck is clean across 13
packages, lint passes, and the dashboard builds and serves from production.

**Two things are genuinely not built:** the LLM narrator (Phase 8) and real auth
(Phase 3b is a minimal users table, not Better Auth). **One thing cannot be proven on
this machine:** containment, because the host firewall rules are Linux-only.

---

## Phase status (BREAKDOWN §11)

| Phase | What it covers | State |
|---|---|---|
| **0** | Requirement validation, contract freeze | **Done** |
| **1** | Repo and development foundations | **Done** |
| **2** | Core backend, database, ingest | **Done** |
| **3** | Web decoy + middleware + agent — *the thin slice* | **Done** |
| 3b | Auth, projects, keys, onboarding | **Partial** — see gaps |
| **4** | Detection engine, incidents, attackers | **Done**, verified |
| 4b | SDK CLI generator | **Done** |
| **5** | SSH honeypot (Cowrie) | **Done** |
| **6** | Dashboard: feed, queue, hero | **Done** |
| **7** | Correlation, honeytokens, profiles | **Done** |
| 8 | Response, LLM narrator, notifications | **Partial** — response yes, LLM no |
| 9 | Containment hardening + selftest | **Partial** — built, unprovable here |
| 10 | Harden, polish, docs, deploy, rehearse | **Partial** — docs yes, rehearsal no |

### The critical path, which the plan says gates everything

`0 → 1 → 2 → 3 → 4 → 7 → 8 → 9 → 10`

Phases 0–7 are complete. The two highest-risk gates the plan called out — the **thin
slice** (3) and the **correlation moment** (7) — are both green and tested. The chain
breaks only at Phase 8's LLM and Phase 9's proof-on-Linux.

### Acceptance criteria (§11.7)

> *Developer's view:* `npm i lxs`, declare decoys, `npx lxs build`, `docker compose up`,
> and within a minute the dashboard shows the sensor healthy and `selftest` passes.

**Partly met.** The install → declare → build → up path works and was run end to end:
the generated compose starts, ds-web answers over its socket, Cowrie accepts
`deploy`/the leaked password, and the agent ships normalised events with the Bearer key.
`selftest` runs and reports honestly — **10/13 on Docker Desktop, with 3 real failures**,
because the SSH decoy genuinely does have outbound access there. That is the environment,
not the code, but the criterion is not met until it is run on Linux.

> *Analyst's view:* a targeted attack becomes one Critical incident with the kill chain,
> ATT&CK mapping, a point-by-point "Why?", and an AI summary; one click blocks the source
> and the attacker's next request is refused; IOCs export; noise is suppressed.

**Met except the AI summary.** Verified live: one incident, Critical, targeted, score 100,
all six stages, 12 techniques, 19 events correlated, the full per-rule "Why?" ledger,
block → `policy_version` bump → visible in `GET /v1/agent/policy`, IOC export as CSV, and
noise labelled and suppressed at 23/Low. The "AI summary" is a deterministic template
labelled **Template** on screen, not an LLM.

### Locked numbers, reproduced on a clean database

| Scenario | Result |
|---|---|
| `ps-attacker` | 5 → 10 → 20 → 45 → 50 → 60 → 70, then floor **Critical** (raw 170, clamped 100) |
| `noise` | **23 · Low · noise** |
| `opportunistic` | **65 · High · opportunistic** |
| `honeytoken` | raw 65, floored to **75 · Critical · targeted** |

---

## Performance work (PERFORMANCE.md)

| # | Item | State |
|---|---|---|
| 1 | Runtime config instead of build-time baking | **Done** |
| 2 | Demo serves a production build | **Done** |
| 3 | `prefetch={false}` on nav, rows, chips, matrix cells | **Done** |
| 4 | SSE-aware polling | **Done** |
| 5 | Coalesce worker jobs per attacker | **Not started** |

Measured effect of 1–4:

| Measure | before | after |
|---|---|---|
| Live feed page load | 2597 ms | **181 ms** |
| Decoys page load | 2049 ms | **142 ms** |
| Incident queue | 1337 ms | **126 ms** |
| Warm navigation | 600–770 ms | **67–143 ms** |
| RSC prefetches per load | 14 | **1–2** |
| Idle API calls per 75 s | ~44 | **3** |
| Time from attack to on-screen | — | **1.7 s** (via SSE) |

API read latency (p50 30 ms) and detection latency (~1 s) were already healthy and are
unchanged.

---

## What is actually left, in the order worth doing it

### 1. Prove containment on Linux — *the only blocking gap*

`infra/victim/ds-firewall.sh` installs the `DOCKER-USER` and `INPUT` drop rules, but
Docker Desktop runs containers in a VM where they cannot be applied from the host, so
`selftest` reports 10/13 with three honest failures. Until this is run on the Linux demo
host, **the containment claim cannot be made to judges**. Everything needed is written;
it needs a machine.

### 2. The LLM narrator (Phase 8)

Every incident currently gets a deterministic template summary with
`ai_status: 'fallback'`, and the hero screen labels it **Template**. The plan's design
holds — the LLM only explains, at incident level, asynchronously, never scores, never
acts, with a template fallback and prompt-injection defences. The fallback and the UI
states already exist, so this is the narrator itself plus caching by fingerprint.

### 3. Rehearse the demo, and record it

`docs/DEMO-SCRIPT.md` is written but has never been performed. The plan's own failure
playbook says to screen-record Beat 2 the night before. That has not been done, and it
is the cheapest insurance available.

### 4. Real auth (Phase 3b)

Currently a minimal users table plus a signed cookie, with `DEV_AUTH_BYPASS=true` in dev.
Fine for the demo, not for anything else. Better Auth with Postgres sessions is the plan.

### 5. Notifications (Phase 8)

Channel CRUD exists and stores webhook URLs AES-GCM encrypted, but `/test` only validates
config and sends nothing, and there is no `notify-incident` job.

### 6. Worker job coalescing (performance item 5)

The worker re-reads an attacker's full history on every ingest call — O(n²) in chain
length. Invisible today; will bite with long chains or a busy sensor. Fix is a debounce
or a pg-boss singleton key per `(project_id, attacker_id)`.

### 7. Smaller things

- **The PS04 problem-statement PDF is still not in the repo.** Every requirement traced
  here is second-hand via S4's matrix. Worth closing before judging.
- `CORS_ORIGINS` must be set properly for any real deployment — a host not on the list
  degrades the dashboard to demo data, and the only signal is a small badge.
- Prod telemetry tailing (`prod.firewall`, `prod.auth`) is not wired into the agent.
- The Redis decoy is rejected at `build` with `E_UNSUPPORTED` (it was always cut-first).
- Deploy is still manual; `.github/workflows/ci.yml` exists but nothing deploys.

---

## The cut list, if time runs short (BREAKDOWN §11.6)

In order: 4th decoy → geo/enrichment → Redis decoy → STIX export (keep JSON/CSV) → extra
personas.

**Never cut:** the thin slice, isolation + self-test, correlation with a real asset,
explainable scoring, the demo script. All five are built; the only one not provable here
is isolation.

# PROGRESS.md — where we are against the original plan

Measured against `BREAKDOWN.md` §11 (the ten phases), `PERFORMANCE.md` (the five
performance items) and `DEMO-RISK-AUDIT.md` (the thirteen pre-demo findings).
Last updated 2026-10-31, after the four-engineer hardening pass was merged.

Everything marked **Done** below was verified by running it, not by reading the code.
Where something is partial, the gap is named.

---

## Headline

**The product works end to end.** A simulated attack chain goes decoy → agent/ingest →
detection → one correlated incident → dashboard → one-click block → agent policy, and the
documented scores reproduce exactly. **276 tests pass** — 162 in the pnpm workspace, 111 in
`apps/dashboard`, 3 in `attacker-demo/attacker-api` — typecheck is clean across all 13
workspace packages, and the dashboard builds and serves from production.

**All 13 findings of the pre-demo risk audit are closed** (`DEMO-RISK-AUDIT.md`), split four
ways and merged: dashboard honesty, authentication, attacker-console controls, and API
robustness. See *Demo-risk hardening pass* below.

**The LLM narrator remains unbuilt** (Phase 8). Prototype authentication is implemented for
Phase 3b: email/password signup and login, JWT-backed HttpOnly sessions, projects and
project-scoped ingest keys. Email verification is intentionally omitted for the prototype.

Two things are **not** green:

- **Containment cannot be proven on this machine** — the host firewall rules are Linux-only.
- **`pnpm lint` fails** with 231 errors. Every one is a formatting diagnostic (CRLF line
  endings on a Windows checkout); Biome reports **no rule violations**, and the 51 warnings
  are pre-existing. Fixing it means reformatting 231 of 234 files, so it was deliberately
  left alone while four engineers had branches open. Worth doing in one commit now that
  they are all merged.

---

## Phase status (BREAKDOWN §11)

| Phase | What it covers | State |
|---|---|---|
| **0** | Requirement validation, contract freeze | **Done** |
| **1** | Repo and development foundations | **Done** |
| **2** | Core backend, database, ingest | **Done** |
| **3** | Web decoy + middleware + agent — *the thin slice* | **Done** |
| 3b | Prototype auth, projects, keys, onboarding | **Done** — production identity features remain out of scope |
| **4** | Detection engine, incidents, attackers | **Done**, verified |
| 4b | SDK CLI generator | **Done** |
| **5** | SSH honeypot (Cowrie) | **Done** |
| **6** | Dashboard: feed, queue, hero | **Done** |
| **7** | Correlation, honeytokens, profiles | **Done** |
| 8 | Response, LLM narrator, notifications | **Partial** — response yes, LLM no |
| 9 | Containment hardening + selftest | **Partial** — built, unprovable here |
| 10 | Harden, polish, docs, deploy, rehearse | **Partial** — docs and the audit-driven hardening pass yes, rehearsal and deploy no |

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
| `sqli` | **Medium · noise** — R05 once for SQLi and once for traversal, R03 for the sqlmap UA |

`sqli` and `honeytoken` are now first-class replays in `apps/api/src/modules/demo.ts`
rather than names that silently fell through to `targeted` (audit #13). `ps-use-case` and
`ps-attacker` are explicit aliases of `targeted`; anything else is rejected with a 422 that
lists the accepted names.

---

## Demo-risk hardening pass

`DEMO-RISK-AUDIT.md` ranked 13 code-level defects that could break or discredit the demo.
`DEMO-RISK-WORKSPLIT.md` divided them four ways by file ownership so the branches could not
collide. All four are merged to `main` and all 13 are closed.

| Engineer | Scope | Findings | State |
|---|---|---|---|
| **A** | Authentication, CSRF, tenant scoping | #6, #7, #9 | **Merged** |
| **B** | Dashboard honesty (no invented data, truthful containment UI) | #1, #2 | **Merged** |
| **C** | Attacker console controls and target handling | #3, #4, #5 | **Merged** |
| **D** | API robustness and demo correctness | #8, #10, #11, #12, #13 | **Merged** |

What each pass actually changed:

- **A — auth.** `DEV_AUTH_BYPASS` defaults to false and is refused unless development binds
  to loopback; the CSRF check no longer passes on a missing `Origin`; `/v1/system` counts are
  scoped to organizations the caller owns.
- **B — dashboard.** Pages no longer substitute mock data for a failed API call, no longer
  report all-clear or success on failure, and show a red status banner instead. Mock mode is
  opt-in behind `LXS_ALLOW_MOCK`.
- **C — attacker console.** `sendHttp` resolves the final URL *before* checking the allowlist,
  so an absolute `path` can no longer aim the attack box at any host on the network; `/run`,
  `/http`, `/ssh` and `/reset` require a control token; the service binds to 127.0.0.1 with
  CORS narrowed to the console origin; `/run` refuses a second concurrent run (409) and
  threads an `AbortSignal`; SSH session ids are unguessable and not caller-adoptable.
- **D — API robustness.** CIDR allowlist entries validate the prefix length per family, mask
  IPv4 host bits and name the offending entry by index; SSE connections are capped (50 per
  project, 500 total) with dead-socket reaping and self-terminating heartbeats, and
  `/v1/stream` is no longer exempt from rate limiting; IOC export survives an empty attacker
  label; gzip ingest enforces a 4× decompression ratio with a bounded in-flight gate that
  returns **429**, not 503, so the agent backs off instead of treating it as a server fault;
  replay scenarios resolve by name or fail loudly.

Verified end to end against real Postgres with the worker running: every scenario's verdict
matched its narration, `honeytoken` reaching Critical through R16's severity floor and `sqli`
staying Medium/noise. One integration break was found and fixed during the merge — C's new
control token was required by `attacker-api` but `scripts/demo.mjs` launched both attacker
processes without it, so `/health` reported healthy while every scenario click 401'd
(`ATTACKER_API_TOKEN` is now threaded through the launcher).

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

### 4. Production auth hardening (after prototype Phase 3b)

The prototype flow is implemented: username/email + password login, signup without email
verification, a standard HS256 JWT in an HttpOnly SameSite=Lax cookie, per-user session
revocation at logout, organization/project bootstrap, and project-scoped API-key creation and
revocation. `DEV_AUTH_BYPASS` defaults to false and is rejected unless development binds to
loopback. Cookie-authenticated mutations require an allowed `Origin`; protected reads propagate
401/403 and resource-level 404s rather than switching to mock data. `/v1/system` counts are
scoped to projects in organizations the caller owns. Password recovery, email verification, stronger deployment
secret/session management, and multi-user organization administration remain future work.

Validated on 2026-10-31: API typecheck; three JWT unit tests; dashboard production build; and
14 live HTTP assertions against local Postgres covering signup, initial and additional project
creation, project listing, key create/revoke, tenant-scoped system counts, CSRF Origin checks,
email/username login, invalid password, logout, and rejection of a copied JWT after logout.
A separate two-account check confirmed owner-level system counts exclude a project where the
same user has only analyst membership, while that project's owner can see its event count.

### 5. Notifications (Phase 8)

Channel CRUD exists and stores webhook URLs AES-GCM encrypted, but `/test` only validates
config and sends nothing, and there is no `notify-incident` job.

### 6. Worker job coalescing (performance item 5)

The worker re-reads an attacker's full history on every ingest call — O(n²) in chain
length. Invisible today; will bite with long chains or a busy sensor. Fix is a debounce
or a pg-boss singleton key per `(project_id, attacker_id)`.

### 7. Deception quality — what an attacker who suspects a honeypot would notice

The audit asked "what breaks the demo". A later pass asked the opposite question: given that
`/.env` and `/admin` are guessable patterns, what does an attacker probing them learn? The
architecture holds up better than expected — `ds-web` runs `network_mode: none` and is
reachable only over a unix socket, the SDK strips every client-supplied `x-ds-*` header
before setting the client IP itself, honeytokens and canary rows are randomly generated per
build, and the agent collapses >20 failed logins per minute per source into one counted
event. None of the following is a demo blocker; they are fingerprinting and evasion gaps.

Open:

- **All seven decoy templates share one `CSS` constant and one `page()` helper**, including
  the 404. A WordPress login and a phpMyAdmin login that render from the same stylesheet are
  one request away from being identified as the same fake.
- **`APP_KEY` in the `.env` bait decodes to "This is not a real key at all!!!"**
  (`apps/decoy-web/src/templates.ts`). `sqlDump` likewise carries a frozen
  `pg_dump version 14.9` banner.
- **No second-order assets.** `/wp-includes/`, `/wp-content/` and phpMyAdmin's `/themes/`
  all 404 identically, and canned responses answer in under a millisecond.
- **`trustProxy: true` returns the leftmost `X-Forwarded-For` hop**, which the client
  controls (`sdk/lxs/src/middleware/core.ts`). The CIDR-array form is correct; only the
  boolean shortcut is wrong. Anyone deploying behind a load balancer will reach for it.
- **`0.0.0.0/0` is still an accepted allowlist entry**, which silently disables all blocking
  for the project. `toCidr` handles `bits === 0` rather than rejecting it.
- **`bound()` clears the entire session/attempt map** at 5000 entries
  (`apps/decoy-web/src/server.ts`), so a source can reset every counter in the process. LRU
  eviction is the fix; the agent's flood collapser has the same pattern at 20,000.
- **Sessions are keyed on client IP**, and `acceptAfter` accepts *any* password on attempt N
  — both a tell and a way to make captured credential intel worthless.
- **Honeytokens cannot be attributed to a visitor.** R16 proves a leak happened but not who
  took it, because the same token value is served to everyone within a deployment.
- **Detection thresholds are readable in-repo** (R04's five failures in 60 s, the Noise
  suppression band), so an attacker who reads `packages/detection/src/rules.ts` can aim for
  a suppressed verdict. Jittering the thresholds per deployment is the mitigation.

### 8. Smaller things

- **`pnpm lint` fails on 231 formatting diagnostics** (CRLF). No rule violations. One
  `biome check --write` commit closes it, now that no engineer has a branch open.
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

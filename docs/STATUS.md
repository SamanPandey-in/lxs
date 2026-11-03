# STATUS.md — where the build actually stands

Updated as phases land. Honest about what is not done.

| Phase | What it covers | State |
|---|---|---|
| **0** | Requirement validation and contract freeze | **Done** |
| **1** | Repository and development foundations | **Done** |
| **2** | Core backend, database, ingest | **Done** |
| **3** | Web decoy + middleware + agent (the thin slice) | **Done** |
| 3b | Auth, projects, keys, onboarding | Partial: login/signup + cookie sessions + keys CRUD; not Better Auth |
| **4** | Detection engine, incidents, attackers | **Done**, verified end to end |
| 4b | SDK CLI generator | **Done** (`init`, `build`, `build --check`, `selftest`) |
| 5 | SSH honeypot (Cowrie) | **Done** (persona image builds, logs in, normalises) |
| 6 | Dashboard: feed, queue, hero | In progress |
| 7 | Correlation, honeytokens, profiles | **Done** (R15/R16 fire against the live pipeline) |
| 8 | Response, LLM narrator, notifications | Partial: block/unblock/IOC export work; **no LLM** (deterministic fallback) |
| 9 | Containment hardening + selftest | Partial: hardening + `selftest` done; **cannot pass on Docker Desktop** |
| 10 | Harden, polish, docs, deploy, rehearse | Docs done; deploy + rehearsal not |

## Phase 0 — contract freeze · DONE

- `packages/schema` holds the frozen `DecoyEvent` (`schema_version: 1`), the API DTOs,
  the agent policy types and the honeytoken types.
- Verified against zod 4.6.7: it parses the documented example event, applies the
  `count`/`simulated` defaults, and rejects malformed IPs.
- `docs/API-CONTRACT.md` is the one-page version everything mocks against.
- `docs/DEMO-SCRIPT.md` is the 5-minute judge demo, with a failure playbook.
- The decoy set is settled: web-admin, web-bait ×2, ssh. Honeytokens are data. Redis is
  cut-first.

## Phase 1 — foundations · DONE

- pnpm workspaces + Turborepo, strict `tsconfig.base.json`, Biome, changesets, CI.
- `pnpm dev` orchestrator boots Postgres, the API and the dashboard in one command
  (`pnpm dev:all` adds the attacker console).
- `apps/dashboard` and `attacker-demo/` are deliberately **outside** the pnpm workspace:
  they are plain-JS npm projects with no workspace imports, and keeping them out avoids
  a package-manager fight for no benefit.

## Phase 4 — detection engine · DONE, and verified

`packages/detection` implements R01–R19 as pure functions. 28/28 golden tests pass; I
re-ran them rather than take the number on trust.

The locked numbers reproduce exactly:

| Scenario | Result |
|---|---|
| `ps-attacker` | 5 → 10 → 20 → 45 → 50 → 60 → 70, then floor **Critical** (120 clamped to 100) |
| `noise` | **23 · Low · noise** |
| `opportunistic` | **65 · High · opportunistic** |
| `honeytoken` | R16 fires → **Critical · targeted** |

`packages/normalizer` (9/9 tests) and `apps/simulator` (6/6 tests) also pass, and the
simulator's 48 synthetic events all validate against the real zod schema.

### Decisions taken inside the engine, worth knowing

1. **A floor raises both severity and the displayed score.** *(Decided.)* A Critical
   floor lifts the score to 75, a High floor to 50, so the hero screen never reads
   "65 · CRITICAL". The honest uncapped sum stays available as `rawScore` for the
   detections ledger. The `ps-attacker` progression is unchanged.
2. **R13 human cadence** needs ≥3 shell/DB commands, a median gap ≥1.5 s, and *variable*
   gaps, so a metronome script does not read as human.
3. **A noise source that touches a real asset becomes opportunistic**, not noise. R15
   still only gives it +10 with no floor.
4. The `sqli` scenario scores **33** (Medium), not the 28 implied elsewhere, because it
   also trips the R02 sweep rule.

## Known gaps

- **Phase 3b auth is not built.** Everything runs on the seeded dev key
  `ds_dev_0000…`. Fine for the demo, not for anything else.
- **No LLM narrator yet** (Phase 8). The hero screen renders the AI card with a pending
  and a fallback state, so its absence does not break the demo.
- **Containment cannot be proven on this machine.** The host firewall rules in
  `infra/victim/ds-firewall.sh` are Linux-only; Docker Desktop runs containers in a VM
  where they cannot be applied. Development is unaffected; the containment *claim* needs
  the Linux demo VM.
- **The dashboard design system was hand-written from the documented tokens**, because
  the `Genesis_Prototype-sam-fix` / `api-client/` reference repo that `docs/frontend.md`
  says to copy is not on this machine. The tokens in §3 are complete, so the palette and
  density are faithful, but it is not a byte-for-byte copy of the reference.
- The PS04 problem-statement PDF is still not in the repo. Every requirement here is
  second-hand via S4's traceability matrix. Worth closing.

---

## End-to-end verification (run on this machine, not taken on trust)

The whole pipeline was driven live: Postgres → migrations → seed → API → simulator →
ingest → detection worker → incident → response.

```
GET  /healthz   {"status":"ok"}
GET  /readyz    {"status":"ready","role":"all","queue":"pg-boss"}
POST /v1/ingest 202 {"accepted":1,"duplicates":0,"rejected":[]}   (x19 events)
```

The `ps-attacker` scenario produced **one** incident, exactly as designed:

| Field | Value |
|---|---|
| severity / label | **critical** / **targeted** |
| score | **100** (raw 170, clamped) · floor critical |
| stages | all six: recon → initial_access → execution → discovery → collection → exfiltration |
| techniques | 12, incl. T1595, T1110.001, T1078.001, T1059.004, T1083, T1082, T1005, T1552.001 |
| real_asset_reached · honeytoken_used | true · true |
| events correlated | 19 into one incident |

The "Why is it Critical?" ledger renders every rule with its reason:

```
R15  +50   Targeted source touched real asset Payments API (critical)
R16  +50   Honeytoken used (ht-acme-api-key)
R06  +25   Logged in to ssh-db-backup-01 with default/weak credentials
R04  +10   5 failed logins within 60 s
R11  +10   Accessed decoy data / honeytoken file
R01   +5   Touched decoy ssh-db-backup-01
R02   +5   Sweep: 3 distinct decoys/paths within 60 s
R07   +5   Session ran 3 commands
R08   +5   Discovery command: ls
R08   +5   Discovery command: uname
R12   +0   Same source on 2 decoy types (ssh, web)      <- label signal, no points
R13   +0   Human cadence: variable gaps, median >= 1.5 s <- label signal, no points
R18   +0   Decoy data left the decoy                     <- tag only
```

Also verified live: the SSE stream connects and keeps alive; `block_ip` writes the
blocklist row, bumps `policy_version` to 5 and appears in `GET /v1/agent/policy` — which
is the pull-only path a sensor uses to enforce it; and IOC export returns well-formed CSV.

### Housekeeping before the demo

The database carries leftover test data from development (incidents #1–#3, from IPs
`203.0.113.165`, `203.0.113.201`, `198.51.100.7`). Re-seed or reset the demo project
before rehearsing, so the queue starts clean.

---

## Renamed to LXS

The product was renamed from its working name to **LXS** across the whole repo: package
scope `@lxs/*`, the npm package and CLI `lxs`, env vars `LXS_*`, the generated
`lxs.compose.yml` and `.lxs/` output directory, and all documentation. 850 substitutions
across 130 files, plus 5 path renames.

After the rename, re-verified from scratch: 109 tests pass, typecheck passes on 13
packages, the dashboard builds, and the full chain was re-run on a **clean database**,
reproducing the documented numbers exactly — `noise` **23 · Low · noise**, `ps-attacker`
**100 · Critical · targeted** with 19 events in one incident and all six stages.

Two names were deliberately left alone: the container/service prefix `ds-`
(`ds-web`, `ds-agent`, `ds_trap`, `br-ds-trap`) and the dev ingest key prefix `ds_dev_`.
They are internal identifiers, not product branding, and changing them would have
touched the firewall rules, the generated compose, and every doc example for no gain.

## One command brings the demo up

`pnpm demo` (`scripts/demo.mjs`) builds the images, starts Postgres, migrates, seeds,
boots the API, dashboard, shop app with decoys and the attacker console, and verifies
each step — including a thin-slice check that a decoy hit actually reaches the platform.
`pnpm demo:status` reports what is healthy; `pnpm demo:down` stops the containers.

Two bugs found by running it rather than just writing it: the Postgres container can come
up *healthy but with no host port binding* when a stale stack held 5432, and the readiness
probe was connecting as the wrong role. The script now checks the published port and
recreates the container once if it is missing.

## Lint policy

`pnpm lint` passes with **0 errors and 50 warnings**. Everything that could mask a defect
is still an error. The warnings are idioms this codebase uses deliberately —
`(map.set(k, v), v)` in hot paths, `any` in test fixtures, array-index keys in static
lists — plus a11y nits inside the copied design-system primitives.

Three suppressions are explicit and carry their reason in the code or config:

- `apps/decoy-web/src/server.ts` strips control characters from attacker input before
  logging. That is the point (§7.11), so `noControlCharactersInRegex` is suppressed there.
- The ATT&CK matrix is a CSS-grid heatmap; a real `<table>` would break the layout and the
  ARIA roles already convey the structure.
- `apps/dashboard/lib/hooks.js` holds generic fetch hooks whose dependency arrays come
  from the caller and can never be literals.

CSS is excluded from Biome because its parser does not yet understand Tailwind v4's
`@theme inline` / `@custom-variant` at-rules.

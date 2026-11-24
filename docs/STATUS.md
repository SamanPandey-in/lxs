# Status as of 2026-11-23

This is the single status page for LXS. It replaces the old `PROGRESS.md` and the previous
`STATUS.md`, which contradicted each other and the code. Every claim below was checked against the
code on 2026-11-23. Where a number comes from an earlier run and was not re-run for this page, it
says so.

The forward plan lives in `docs/IMPLEMENTATION-PLAN.md`. This page records what is true today.

---

## Headline

- **The product works end to end.** decoy → agent → ingest → detection → one correlated incident →
  dashboard → one-click block → agent policy. The documented scores reproduce exactly (golden tests).
- **The LLM narrator is built** (`apps/api/src/worker/narrator.ts`, `assess-incident.ts`,
  `apps/api/src/lib/llm.ts`). It is off unless `LLM_API_KEY` is set, and it has not yet been run
  against a real provider key. See [LLM narrator](#llm-narrator).
- **Redis and PostgreSQL decoys build.** The old `E_UNSUPPORTED` rejection is gone; the generated
  compose emits `decoy-redis` and `decoy-postgres` services.
- **Containment is built but not yet proven on Linux.** `selftest` has only run on Docker Desktop
  (10/13, three real failures, because the host firewall can't apply there). A scheduled selftest
  workflow for a self-hosted Linux runner now exists. See [Containment](#containment).
- **Phase 1 streams A–D are merged** (branch `phase-1`): alert delivery, identity and tenancy,
  sensor hardening, and this release plumbing. All unit tests pass (API 214, agent 33, SDK 32,
  decoy-web 23, dashboard 120), and alerts and identity were exercised end to end on a local Postgres.

---

## Phase status (BREAKDOWN §11)

| Phase | What it covers | State |
|---|---|---|
| **0** | Requirement validation, contract freeze | **Done** |
| **1** | Repo and development foundations | **Done** |
| **2** | Core backend, database, ingest | **Done** |
| **3** | Web decoy + middleware + agent (the thin slice) | **Done** |
| 3b | Auth, projects, keys, onboarding | **Prototype done**: signup, login, logout, `/v1/me`, JWT in an HttpOnly cookie, per-user session revocation, projects, project-scoped keys. Email verification, password reset, members/roles, per-org caps and an org kill switch: **built (Phase 1 B), DB/e2e unverified**. 2FA: not started |
| **4** | Detection engine, incidents, attackers | **Done**, golden-tested |
| 4b | SDK CLI generator | **Done** (`init`, `build`, `build --check`, `selftest [--report]`) |
| **5** | SSH honeypot (Cowrie) | **Done** |
| 5b | Redis and PostgreSQL decoys | **Done** (build, compose and normalise; commit `2aba504`) |
| **6** | Dashboard: feed, queue, hero | **Done** |
| **7** | Correlation, honeytokens, profiles | **Done** |
| 8 | Response, LLM narrator, notifications | Response **done**. LLM narrator **built, not yet run against a real provider**. Notifications: Slack and signed webhook delivery with retries, dedupe and send-time SSRF checks: **built (Phase 1 A), not yet sent to a real Slack** |
| 9 | Containment hardening + selftest | **Built; proof on Linux outstanding** (needs the owner's Linux host; workflow ready) |
| 10 | Harden, polish, docs, deploy, rehearse | Docs and the demo-risk pass done. Image release workflow written (untested). Platform deploy, metrics and backups not started |

---

## Phase 1 (merged, pending end-to-end verification)

| Stream | What changed | Still to verify |
|---|---|---|
| **A: Alerts** (G1) | `notify-incident` job; Slack and HMAC-signed webhooks; retries, dedupe and cooldown; SSRF check at send time; `ENCRYPTION_KEY` with key versioning (`db:reencrypt-channels`). See [ALERTS.md](ALERTS.md) | Verified locally 2026-11-23: migrations 0006–0008 on Postgres 16, a `ps-attacker` replay sent exactly one signed Critical (HMAC checked), a dead URL shows `failed` with the error. Still to do: a real Slack channel |
| **B: Identity and tenancy** (G4, H1) | Email verification, password reset, `Mailer` (console/resend), members and roles (viewer/analyst/owner), per-org caps, signup rate limit, optional Turnstile, org kill switch (`db:org-kill-switch`), cross-tenant test over every route | Verified locally 2026-11-23: signup → `E_EMAIL_UNVERIFIED` on key create → verify (single use) → key create; forgot (same answer for unknown emails) → reset → old session 401; kill switch blocks login with `E_ORG_DISABLED`. Still to do: real Resend/Turnstile, browser pass on the new pages; SMTP is a stub; TOTP 2FA not started |
| **C: Sensor hardening** (G6, G7) | `trustProxy: true` rejected (`E_TRUST_PROXY`; hop counts supported), `/0` rejected, LRU eviction, IP + cookie decoy sessions with per-session `acceptAfter`, `telemetry` option for prod firewall/auth tailers | End-to-end correlation of prod telemetry |
| **D: Truth and release plumbing** (G3, H2, G2 prep) | This page, the image release workflow, the scheduled selftest workflow | Both workflows have never run |

---|---|---|
| **A: Alerts** (G1) | `modules/notifications.ts` stores webhook URLs AES-GCM encrypted, but `/test` returns `delivered: false` ("stubbed in the MVP"). No notify job. The channel key is derived from `SESSION_SECRET` | `notify-incident` job, Slack and signed generic webhooks, retries, dedupe, SSRF checks at send time, a dedicated `ENCRYPTION_KEY` |
| **B: Identity and tenancy** (G4, H1) | `modules/auth.ts` has login, signup, logout and `me` only. `memberships.role` exists but there are no member routes | Email verification, password reset, a `Mailer`, members and roles, per-org caps, an admin kill switch, a cross-tenant test |
| **C: Sensor hardening** (G6, G7) | `trustProxy: true` trusts the leftmost `X-Forwarded-For` hop; `0.0.0.0/0` is accepted in `allowlist`; decoy-web and the agent flood collapser clear their maps when full; decoy sessions are keyed on client IP; `prod.firewall`/`prod.auth` tailers are not wired into the agent | Reject `trustProxy: true`, reject `/0`, LRU eviction, IP + cookie sessions with randomised `acceptAfter`, wire the prod tailers |
| **D: Truth and release plumbing** (G3, H2, G2 prep) | This page, the image release workflow, the scheduled selftest workflow | |

---

## Verified numbers

### Tests (pnpm workspace, 2026-11-23)

| Package | Tests |
|---|---|
| `apps/api` | 107 |
| `apps/agent` | 25 |
| `sdk/lxs` (`lxs`) | 22 |
| `apps/decoy-web` | 14 |
| `packages/detection` | 28 |
| `packages/normalizer` | 9 |
| `packages/schema` | 11 |
| `apps/simulator` | 6 |
| **Total** | **222, all passing** |

`apps/dashboard` and `attacker-demo/` are outside the pnpm workspace and have their own `npm test`.
They were not re-run for this page (the last recorded count, on 2026-10-31, was 111 dashboard tests
and 3 attacker-api tests).

### Lint

`pnpm lint` runs `biome check .`, which covers lint rules, formatting and import sorting.

- **Lint rules (`biome lint .`): 0 errors, 47 warnings.** The warnings are deliberate idioms
  (`(map.set(k, v), v)` in hot paths, `any` in test fixtures, array-index keys in static lists) and
  a11y nits in the copied design-system primitives.
- **`pnpm lint` on a clean LF checkout: 34 errors, all in `apps/dashboard`** (26 formatting, 8 import
  ordering), introduced by the UI revamp in commit `50d9f0d`. They are auto-fixable with
  `pnpm exec biome check --write apps/dashboard`. Until that lands, the `pnpm lint` step in
  `ci.yml` fails.
- **On a Windows checkout, `pnpm lint` shows about 246 more format errors.** They are all CRLF line
  endings written by `core.autocrlf=true`, not real diffs. The repository already has a
  `.gitattributes` with `* text=auto eol=lf` (added in `50d9f0d`), and every file in the index is LF
  (`git ls-files --eol` on a fresh checkout reports `i/lf w/lf` for all 344 files). A working copy
  checked out before that file existed keeps its CRLF files until they are rewritten. To fix it,
  commit or set aside local changes first, then run `git checkout-index --force --all`, which
  overwrites the working files from the index. A fresh clone or worktree is clean.

Three suppressions are explicit and give their reason in the code or config: the control-character
regex in `apps/decoy-web/src/server.ts` (it strips attacker input before logging), the ATT&CK matrix
CSS-grid heatmap (`<table>` would break the layout; ARIA roles carry the structure), and the generic
fetch hooks in `apps/dashboard/lib/hooks.js`. CSS is excluded from Biome because its parser does not
yet understand Tailwind v4's `@theme inline` / `@custom-variant` at-rules.

### Locked detection numbers

Golden tests in `packages/detection` lock these. Changing a rule that moves them fails CI on purpose.

| Scenario | Result |
|---|---|
| `ps-attacker` | 5 → 10 → 20 → 45 → 50 → 60 → 70, then floor **Critical** (raw 170, clamped 100) |
| `noise` | **23 · Low · noise** |
| `opportunistic` | **65 · High · opportunistic** |
| `honeytoken` | raw 65, R16 floor → **75 · Critical · targeted** |
| `sqli` | **Medium · noise** (R05 for SQLi and traversal, R03 for the sqlmap UA, R02 sweep) |

`sqli` and `honeytoken` are first-class replays in `apps/api/src/modules/demo.ts`. `ps-use-case` and
`ps-attacker` are aliases of `targeted`, and unknown names get a 422 listing the accepted ones.

Engine decisions worth knowing: a severity floor raises the displayed score too (Critical → 75,
High → 50), with the uncapped sum kept as `rawScore`. R13 "human cadence" needs ≥3 commands, a median
gap ≥1.5 s and variable gaps. A noise source that touches a real asset becomes opportunistic.

---

## LLM narrator

Built: `apps/api/src/lib/llm.ts` (provider adapter), `worker/narrator.ts` (incident summaries) and
`worker/assess-incident.ts` (assessment of uncovered activity). The LLM only explains: no tools are
ever passed, it never scores and never acts. Summaries are cached by fingerprint and prompt version,
debounced (`LLM_DEBOUNCE_SECONDS`, default 15) and capped per day (`LLM_DAILY_CAP`, default 200, plus
a per-project `aiDailyCap`). Any provider failure, or no key, gives the deterministic template, which
the dashboard labels **Template**. Keys starting with `mock-` are treated as "no key", so attacker
data never goes to a provider that would 401.

**Not done:** one narrator run against a real provider key (owner action, plan item G3).

### Default model IDs, checked against provider docs on 2026-11-23

| Provider (`LLM_PROVIDER`) | Default in `llm.ts` | What the provider's docs say | Verdict |
|---|---|---|---|
| `anthropic` (default) | `claude-opus-5-5` | Listed as a current model and the recommended starting point on the Claude models overview; retirement not before 2027-09-22 | **Valid** |
| `google` | `gemini-3.8-flash` | Listed as **Stable** and the newest Flash model on the Gemini models page; listed as supported by the Interactions API (`POST /v1beta/interactions`), which the adapter calls and which Google lists as generally available | **Valid** |
| `openai` (any OpenAI-compatible endpoint) | none; `LLM_MODEL` is required, otherwise the narrator stays off | No default to check. OpenAI's current list recommends `gpt-6.2-astra`, `gpt-6.2-sol` and `gpt-6-luna` | **N/A** (by design) |

Related findings, not code changes:

- The Anthropic adapter calls `client.beta.messages.create` with
  `output_config: { effort: 'low', format: { type: 'json_schema', ... } }` and, for models matching
  `SUPPORTS_FALLBACKS = /^claude-(opus-5|fable-5|sonnet-5-5)/`, the `server-side-fallback-2026-07-01`
  beta with `fallbacks: 'default'`. All of these are documented for `claude-opus-5-5`.
- **Possible mismatch:** Anthropic documents server-side `fallbacks` for `claude-fable-5-2`,
  `claude-fable-5-1`, `claude-opus-5-5`, `claude-opus-5` and `claude-sonnet-5-5`. The regex also
  matches plain `claude-fable-5`, which is not on that list. If someone sets `LLM_MODEL=claude-fable-5`,
  the request may get a 400 and fall back to the template. The default model is not affected.
- Google lists `gemini-2.5-flash` and `gemini-2.5-pro` as deprecated (rerouted on 2026-12-01). Nothing
  in the repo uses them.

Sources: <https://platform.claude.com/docs/en/about-claude/models/overview>,
<https://aistudio.google.com/docs/models> (formerly `ai.google.dev/gemini-api/docs/models`),
<https://aistudio.google.com/docs/interactions-overview>,
<https://developers.openai.com/api/docs/models>.

---

## Containment

What is built: web decoys run with `network_mode: none` and are reached over a Unix socket. Network
decoys (ssh, redis, postgres) sit on the `ds_trap` bridge (`br-ds-trap`) with outbound connections
dropped by `infra/victim/ds-firewall.sh` (`DOCKER-USER` + `INPUT`). Every decoy has a read-only root
filesystem, all capabilities dropped, `no-new-privileges`, a non-root user and memory/PID limits. The
control channel is pull-only.

What is proven: **nothing on Linux yet.** The only recorded run is on Docker Desktop: 10/13, with three
honest failures because Docker Desktop runs containers in a VM where host firewall rules can't
apply. That figure is from the original web + ssh decoy set; the six-decoy `acme-shop` example runs
more checks.

Next step (owner): register a self-hosted Linux runner and enable `.github/workflows/selftest.yml`,
or run the steps in `infra/victim/DEPLOY-EC2.md` by hand. See `docs/containment/README.md` for the
runner setup and what a passing result means. Passing outputs are stored as
`docs/containment/selftest-<date>.txt`.

---

## Images and release

The generated compose pulls `ghcr.io/lxs/{agent,decoy-web,cowrie-personas,decoy-redis,decoy-postgres}:<IMAGE_TAG>`,
where `IMAGE_TAG` is the SDK version (`sdk/lxs/src/version.ts`, today `0.1.0`). **None of these
images is published yet.** Until they are, build them locally with `bash infra/victim/build-images.sh`
(it uses the exact tags compose expects), or export `LXS_AGENT_IMAGE`, `LXS_WEB_IMAGE`,
`LXS_COWRIE_IMAGE`, `LXS_REDIS_IMAGE` and `LXS_POSTGRES_IMAGE`.

`.github/workflows/release-images.yml` (new, **not yet run**) builds all five for `linux/amd64` and
`linux/arm64` on a `v*` tag, checks that the tag matches the SDK version, pushes `<version>` and
`latest` to GHCR, signs each image with keyless cosign, and attaches SLSA provenance and an SBOM.
A manual run from a branch builds without pushing.

- **Namespace:** the workflow publishes to `IMAGE_NAMESPACE`, which defaults to
  `ghcr.io/<repository owner>`, but `compose.ts` defaults to `ghcr.io/lxs`. They must match: own the
  `lxs` GHCR namespace and set the repository variable `IMAGE_NAMESPACE=ghcr.io/lxs`, or change the
  compose default. The workflow warns when they differ.
- **arm64:** no blockers found. All base images are multi-arch (`node:22-alpine`,
  `gcr.io/distroless/nodejs22-debian12`, `python:3.12-alpine`, `postgres:16-alpine`, and
  `cowrie/cowrie:latest`, which publishes `linux/amd64` and `linux/arm64`), and no Dockerfile
  downloads an architecture-specific binary. The agent and decoy-web build stages now run on
  `$BUILDPLATFORM`, because their output is a single architecture-independent JS bundle, so pnpm and
  esbuild don't run under QEMU. If you pin Cowrie with `--build-arg COWRIE_IMAGE=...@sha256:`, pin
  the multi-arch index digest, not a per-architecture one.
- `infra/victim/DEPLOY-EC2.md` still says "use x86_64, the Cowrie/Postgres decoy images are not
  multi-arch". That is no longer accurate for the upstream bases. It is outside this stream's files
  and is left for its owner to update.

---

## Phase 2 (merged 2026-11-24)

| Stream | What shipped | Verified |
|---|---|---|
| **E: lxs.yaml + conformance** | `lxs.yaml` with a generated JSON Schema; `conformance/` SPEC.md + 80 vectors; 5 middleware security fixes (x-ds-* reached the app, non-canonical IP blocklist bypass, mapped CIDRs, lenient prefixes, absolute-form targets) | Node Express + Fastify 161/161 |
| **F: Go SDK** | `sdk/go`: net/http middleware (stdlib only) + chi, gin, echo adapters; `lxsyaml` loader; Go conformance runner; `go.yml` CI | 80/80 on every adapter, Windows and Linux. Middleware costs ~0.5 µs/request in Go, 2–11 µs in Node (Express overhead indistinguishable). No Go rewrite of the platform needed |
| **G: First run** | `lxs init --preset`, hosted endpoint default (placeholder URL), `lxs doctor` (10 checks), onboarding safe test hit, sample data load/clear (migration 0009) | Test hit alerts; sample data sends no alerts; clear removes only sample rows (local Postgres, 2026-11-24). Browser pass not done |
| **H: Worker + ops** | Coalesced worker, `/metrics`, deploy workflow, backup/restore scripts, OPERATIONS.md | Burst numbers measured; metrics scraped locally |

## Known gaps

| ID | Gap | Where it stands |
|---|---|---|
| G5 | Worker re-read per ingest | **Done (Phase 2 H):** one coalesced job per (project, source) with a 1 s debounce; 5,000-event burst went from 100 jobs / 24–54 s to 7–11 jobs / 5.5–9.8 s (see PERFORMANCE.md). Still a bounded 24 h window read per run, because the rules need the whole chain |
| G8 | Drizzle snapshots | **Done (Phase 0):** baseline at 0006; migrations now run to 0009 with no drift |
| G8 | Deploy, metrics, backups | **Built (Phase 2 H):** `/metrics` (Prometheus), gated `deploy.yml` (SSH target; ECS is a TODO), `scripts/ops/backup.sh` + `restore-test.sh` (both run against a scratch DB). Workflow never run; needs the secrets in OPERATIONS.md |
| G10 | No geo/ASN enrichment | Phase 4 |
| G6 (rest) | All seven web decoy templates share one stylesheet and `page()` helper; the `.env` bait's `APP_KEY` decodes to "This is not a real key at all!!!"; `sqlDump` has a fixed `pg_dump version 14.9` banner; no second-order assets (`/wp-includes/` etc. all 404 alike); canned responses come back in under a millisecond; one honeytoken value per deployment, so a leak can't be attributed to a visitor; detection thresholds are readable in the repo | Planned: Phase 3, stream L |
| | `CORS_ORIGINS` must be set for any real deployment. The API refuses cross-origin calls from a dashboard host that isn't listed | Configuration, documented |
| | The PS04 problem-statement PDF is not in the repo; requirements are traced second-hand via S4's matrix | Open |
| | `docs/DEMO-SCRIPT.md` has never been rehearsed or recorded | Open |

---

## History worth keeping

**Demo-risk hardening pass (2026-10-31).** All 13 findings in `DEMO-RISK-AUDIT.md` were closed in
four merged branches (`DEMO-RISK-WORKSPLIT.md`). Auth: `DEV_AUTH_BYPASS` defaults to false and is
refused unless development binds to loopback; CSRF no longer passes on a missing `Origin`;
`/v1/system` counts are scoped to owned orgs. Dashboard: no mock data substituted for a failed call;
mock mode is opt-in behind `LXS_ALLOW_MOCK`. Attacker console: the URL is resolved before the
allowlist check, a control token is required, it binds to 127.0.0.1, and it allows one run at a time.
API: per-family CIDR validation, SSE connection caps, a gzip ratio limit that returns 429, and replay
names that resolve or fail loudly.

**Performance (`PERFORMANCE.md`).** Runtime config, a production dashboard build, `prefetch={false}`
and SSE-aware polling took the live feed load from 2597 ms to 181 ms and idle API calls from about 44
to 3 per 75 s. Attack-to-screen is 1.7 s over SSE. Item 5 (worker coalescing) is G5 above.

**Rename.** The product was renamed to LXS (`@lxs/*`, `lxs` CLI, `LXS_*` env, `lxs.compose.yml`,
`.lxs/`). The internal container prefix `ds-` (`ds-web`, `ds-agent`, `ds_trap`, `br-ds-trap`) and the
dev key prefix `ds_dev_` were kept on purpose.

**Housekeeping.** `pnpm demo` builds the images, starts Postgres, migrates, seeds and boots
everything, with a thin-slice check. Before rehearsing, re-seed or reset the demo project so the
incident queue starts clean.

### Claims removed from the old pages (and why)

| Old claim | Source | Why removed |
|---|---|---|
| "The LLM narrator remains unbuilt" / "No LLM narrator yet" | PROGRESS, old STATUS | `narrator.ts`, `assess-incident.ts` and `llm.ts` exist and are wired into the worker |
| "`pnpm lint` fails with 231 errors" / "`pnpm lint` passes with 0 errors" | PROGRESS / old STATUS | Both wrong today; see [Lint](#lint) |
| "The Redis decoy is rejected at `build` with `E_UNSUPPORTED`" | PROGRESS | Fixed in `2aba504` |
| "Phase 3b auth is not built", "Phase 6 in progress" | old STATUS | Prototype auth and the dashboard are built |
| "276 tests" / "109 tests across 7 packages" | PROGRESS / README | Replaced by the 2026-11-23 counts above |

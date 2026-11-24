# LXS implementation plan (from the Gap Analysis and Roadmap)

Source: `LXS Gap Analysis and Roadmap.md` (23 Nov 2026), section 6 order (real adopters, hosted multi-tenant SOC on AWS, `lxs` on npm, Go early).
Checked against the code on branch `ui/design-system` on 23 Nov 2026.

## 1. What the guide says vs what the code says

| ID | Guide claim | Code today | Verdict |
|---|---|---|---|
| G1 | Alert delivery stubbed | `notifications.ts:148` returns `delivered: false` "stubbed in the MVP". No notify job in `jobs/queue.ts`. `safeUrl` checks the literal hostname only | **Confirmed** |
| G2 | Containment unproven (selftest 10/13 on Docker Desktop) | `selftest.ts` exists; proof needs a Linux host | **Confirmed, needs you** |
| G3 | Docs contradict code | `PROGRESS.md:24` "narrator remains unbuilt", `:31` "lint fails 231"; `STATUS.md:173` "lint passes 0 errors"; `narrator.ts`, `assess-incident.ts`, `llm.ts` exist | **Confirmed** |
| G4 | No reset / verification / 2FA / invites; channel key from `SESSION_SECRET` | `auth.ts` has only login, signup, logout, me. `memberships.role` exists, no member routes. `notifications.ts:14` derives the key from `SESSION_SECRET` | **Confirmed** |
| G5 | Worker re-reads full history (quadratic) | `process-events.ts:206-207` re-reads the chain per run, capped by `CHAIN_LIMIT` | **Partly true**: bounded, but still a re-read per ingest |
| G6 | trustProxy boolean, `/0` allowlist, map clear at 5k/20k, IP-keyed sessions, shared honeytoken | `config.ts:38` accepts `z.boolean()`; allowlist has no prefix-0 check; `decoy-web/server.ts:16` `MAX_TRACKED = 5000`; `agent/normalize.ts:533` `buckets.clear()` at 20k; `acceptAfter` fixed | **Confirmed** |
| G7 | `redis` rejected with `E_UNSUPPORTED` | No `E_UNSUPPORTED` left; `compose.ts:135` emits `decoy-redis`; config builds redis | **Stale, already fixed** (commit `2aba504`). Prod tailers (`prod.firewall`/`prod.auth`) are still not wired into the agent |
| G8 | Only `0000_snapshot.json` while migrations run to 0005; no deploy, metrics, backups | Confirmed: `migrations/meta` has only `0000_snapshot.json`. CI has `ci.yml` only | **Confirmed** |
| G10 | No enrichment | No geoip/asn code found | **Confirmed** |
| H2 | Images not pullable | Compose defaults to `ghcr.io/lxs/{agent,decoy-web,cowrie-personas,decoy-redis,decoy-postgres}`. Those must be published, and `ghcr.io/lxs` must be an org you own | **Confirmed, and the namespace needs checking** |

## 2. What agents can build vs what needs you

**Agents can implement and test locally:** G1 (with a local webhook receiver), G3 doc merge, G4 flows with a pluggable mailer (console transport in dev), H1 limits and kill switch, G5, G6, G7 prod tailers, G8 snapshot fix, metrics, deploy and image *workflows* (written, not run), backup scripts, H3 `lxs doctor` and init defaults, 3.1 first-run items, H5/G11 export and delete, H7 caps, digest, coverage score, auto-block, Go middleware plus a conformance suite, and most of section 3.

**Needs you (agents can prepare, not finish):**
- G2: run `selftest` on your Linux/EC2 host and commit the 13/13 output.
- G1 "done when": a real Slack webhook URL.
- G3: one narrator run with a real provider key; agents check model IDs against provider docs.
- H2/H4: GHCR org, npm name and publishing, signing keys, npm 2FA/provenance.
- G4/H1: an email provider (Resend/SMTP) key and a captcha provider key.
- H5: privacy policy and terms (agents draft; you or counsel approve).
- H6: AWS resources (secrets manager, WAF, backup bucket, status page).

## 3. Decisions (my defaults; tell me to change any)

1. **Go scope:** a Go SDK (middleware) for protected apps only. The platform and agent stay in Node. The CLI stays Node but reads a new language-neutral `lxs.yaml`. A Go CLI binary is deferred until the conformance suite exists.
2. **Access:** invite-only beta first, so H1 uses verified email + per-org caps + an admin kill switch, with captcha behind a flag.
3. **LLM:** keep the provider adapter; add a global daily cap (H7) with a conservative default.
4. **Mail:** a `Mailer` interface with `console` (dev) and `resend`/`smtp` transports picked by env.

## 4. How the parallel work runs

- Each agent works in its **own git worktree** on its own branch (`feat/<stream>`), owns a fixed set of files, and must not edit another stream's files. Shared files are listed with a single owner.
- **Migrations:** numbers are pre-assigned per stream to avoid journal clashes. Phase 0 fixes the drizzle snapshots first so `drizzle-kit generate` works.
- Every agent finishes with: `pnpm -w typecheck`, `pnpm -w lint`, and the package's tests green, plus new tests for its feature and a short report (files changed, tests added, anything blocked).
- I merge the branches in a fixed order at the end of each phase, re-run the full suite and the UI checks in Chrome (light/dark, 1440/390), then commit per stream (Conventional Commits, no AI trailers, `agents/` never committed).
- About 4 agents per phase, to respect the machine's memory limits (the dev server was killed twice for low memory).

## 5. Phases

### Phase 0: baseline (me, serial, before any agent starts)

1. Commit the pending dashboard contrast and refresh work (`style(dashboard): …`), excluding `agents/` and the `examples/acme-shop` line-ending changes.
2. **G8 snapshot fix:** regenerate drizzle snapshots 0001–0005 so `drizzle-kit generate` diffs against the real schema. Verify that generate produces an empty diff.
3. Run the full test suite and record the baseline (API, worker, SDK, agent, decoy-web, dashboard).
4. Pre-assign migration numbers: Phase 1 A = `0006`, B = `0007`. Phase 2 = `0008+` in merge order.

### Phase 1: before inviting outsiders (4 agents in parallel)

| Agent | Scope | Owns | Done when |
|---|---|---|---|
| **A: Alerts** (G1 + key half of G4) | `notify-incident` pg-boss job, enqueued on incident create and on severity step-up matching `min_severity`/`labels`. Slack + generic webhook formatters; HMAC-SHA256 signature header on generic. Retries with backoff; write `last_status`/`last_error`. Dedupe: one per incident per severity step, with a cooldown. Real `/test`. SSRF check at send time (DNS resolve, reject private/loopback/link-local/CGNAT, no redirects). Dedicated `ENCRYPTION_KEY` with a key-version byte plus a re-encrypt script (fall back to the legacy derivation for decrypt only). Settings shows channel health (red on failure). | `apps/api/src/modules/notifications.ts`, `lib/notify.ts`, `jobs/queue.ts`, new `worker/notify-incident.ts`, `env.ts` (`ENCRYPTION_KEY` only), migration `0006`, Settings → Notifications UI | `ps-attacker` replay sends exactly one Critical to a local test receiver within seconds; a failing URL shows red; tests cover dedupe, HMAC, SSRF via DNS |
| **B: Identity and tenancy** (G4 + H1) | Email verification (keys can't be created until verified), password reset (single-use, hashed, 30 min tokens), `Mailer` interface (console/resend/smtp). Members: invite by email, accept, list, change role, remove; enforce roles in `projectAccess` (viewer read-only, analyst no keys/settings). Per-org caps on projects and keys. Signup rate limit + captcha hook behind a flag. Admin org kill switch (disables ingest + login). A **cross-tenant test** hitting every route with another tenant's IDs. TOTP 2FA for owners is a stretch goal. Dashboard: verify banner, reset pages, Members tab. | `modules/auth.ts`, `modules/projects.ts` (member/key-cap routes), `plugins/auth-session.ts`, new `lib/mailer.ts`, `db/schema.ts` (users/memberships/invites/tokens), migration `0007`, `app/login`, `app/signup`, new reset/verify pages, Settings → Members | New user can't create a key until verified; reset works end to end via the console mailer; the cross-tenant test passes for every route |
| **C: Sensor hardening** (G6 top 4 + G7 tailers) | `trustProxy`: reject `true`, require a CIDR list or a hop count. Reject prefix length 0 in `allowlist`. LRU eviction instead of `.clear()` in decoy-web (`MAX_TRACKED`) and the agent flood collapser. Sessions keyed on IP + cookie, with `acceptAfter` randomised per session within a range. Wire `prod.firewall`/`prod.auth` tailers in the agent. Update `init` template and docs. | `sdk/lxs/src/config.ts`, `sdk/lxs/src/middleware/*`, `sdk/lxs/src/cli/init.ts`, `apps/decoy-web/src/*`, `apps/agent/src/*` | Unit tests for each fix; existing golden detection tests unchanged |
| **D: Truth and release plumbing** (G3 + H2 + G2 prep) | Merge `PROGRESS.md` + `STATUS.md` into one dated `docs/STATUS.md`, deleting stale claims (narrator, lint, redis). Check `llm.ts` default model IDs against provider docs and flag mismatches. GitHub workflow building multi-arch (amd64+arm64) images for all 5 decoy/agent images, tagged with the SDK version, signed with cosign (keyless), push gated on a release tag. A scheduled `selftest` workflow for a self-hosted Linux runner (disabled until you register one). README: fix the decoy list and image instructions. | `docs/`, `README.md`, `.github/workflows/` (new files only; `ci.yml` stays untouched), `images/*.Dockerfile` (multi-arch fixes only) | `docker buildx build --platform linux/amd64,linux/arm64` succeeds locally for each image (or the reason it can't is reported); docs have no contradictions |

**Merge order:** D → C → A → B (B last because it touches auth used everywhere).

**After the merge, I do:** full tests, the browser pass on Settings and Auth pages, and per-stream commits.

**Your out-of-band items for Phase 1:** run `selftest` on Linux; a Slack test webhook; an LLM key run; confirm the `ghcr.io/lxs` namespace.

### Phase 2: Next (4 agents)

| Agent | Scope | Done when |
|---|---|---|
| **E: Language-neutral config + conformance** | JSON Schema for `lxs.yaml` (generated from the zod schema so they can't drift). CLI accepts `lxs.yaml` or `decoy.config.ts`. A **conformance suite**: request/expected-behaviour vectors (decoy routing over the socket, `x-ds-*` stripping, client-IP derivation under trustProxy, blocklist enforcement), with a runner that the Node middleware passes. | The Node Express + Fastify middleware pass 100 % of the vectors |
| **F: Go SDK** (starts once E's vectors are frozen, about mid-phase) | `sdk/go`: `net/http` middleware plus chi, gin and echo adapters, policy file reader, Unix-socket proxy, a conformance runner in Go, and a middleware overhead benchmark (p50/p99 with and without, on a non-decoy route) for both Go and Node. | Go passes the same vectors; benchmark numbers recorded in `docs/PERFORMANCE.md` |
| **G: First run** (H3 + 3.1) | `lxs init` defaults `LXS_ENDPOINT` to the hosted URL and prompts for the key; `lxs doctor` (Docker, ports, compose, key validity, reachability, one fix hint each); `--preset shop|saas-api|wordpress`; onboarding "Trigger a safe test hit" button (reuse the demo replay endpoint, scoped to the user's project); clearly labelled sample-data mode. | A fresh account reaches a first incident from onboarding without the CLI |
| **H: Worker + ops** (G5 + G8 + H6 scripts) | pg-boss singleton key per `(project, attacker)` with debounce, incremental scoring from the last scored event; a 5,000-event burst test in `scripts/perf`. `/metrics` (Prometheus: ingest rate, queue depth, detection latency, LLM calls/cost, notify failures). Deploy workflow (build, push, migrate, restart) with a manual approval environment. Nightly `pg_dump` script + documented restore test. | Golden scores unchanged; burst test time recorded; metrics scrape works locally |

**Your items:** AWS secrets manager, WAF, backup bucket and status page (H6); npm name and provenance (H4).

### Phase 3: Then (3–4 agents)

- **I: Data handling (H5 + G11):** project export (JSON bundle) and delete endpoints, hash captured passwords after N days, default retention per plan, a data-handling page and a security contact. Legal drafts are marked "needs review".
- **J: Retention features:** weekly digest (email/Slack), coverage score + recommendations, "noise you did not have to read" counter, milestones.
- **K: Response:** auto-block policy (Critical + targeted → 24 h, one-click undo, audited), allowlist helper from observed traffic, block from Slack (interactive button; needs a Slack app you create), H7 global and per-plan LLM caps with a meter in Settings.
- **L: Deception quality (rest of G6):** per-visitor honeytokens with a platform mapping and a "which token leaked where" view, per-template CSS/markup, realistic 404s, plausible per-build bait values and banners, static second-order assets, response jitter, per-deployment threshold jitter.

### Phase 4: Later (pick per need)

Geo/ASN enrichment (offline DB) and "wrong label" feedback (G10); Cowrie session replay; "Ask this incident" (explain-only); attacker clustering; assignment and SLA timers; rule explorer and threshold tuning preview; SIEM export (syslog/CEF); more decoy templates and the canary token kit; PagerDuty/Teams/Discord/email channels; ticket creation; Cloudflare/AWS WAF blocklist push; shareable incident report; Python/other middleware off the conformance suite. The open dashboard items from `apps/dashboard/docs/UI-REVIEW.md` (URL filter state, palette "Add block", Playwright visual regression) also go here.

## 6. Risks

- **Auth changes (B) can lock out the demo user.** Seed marks `demo@lxs.dev` verified; the migration backfills existing users as verified.
- **ENCRYPTION_KEY rollout (A)** must not break existing channels: decrypt tries the versioned key, then the legacy derivation; the re-encrypt script migrates rows.
- **trustProxy `true` rejection (C) is a breaking SDK change.** Ship it with a clear error message and a changeset (minor bump plus a migration note).
- **Detection numbers:** any stream touching the worker or agent must keep the golden tests unchanged.

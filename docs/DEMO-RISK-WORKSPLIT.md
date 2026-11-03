# Demo Risk Audit — 4-way work split

Companion to [DEMO-RISK-AUDIT.md](./DEMO-RISK-AUDIT.md). Findings are referred to by their
number there (#1 … #13).

The split is built around **file ownership**, so four people can work at the same time without
touching each other's files. All platform authentication and authorization work is with one
engineer (**A**). Nobody edits a file they do not own; the two shared-file cases and the one
real ordering dependency are called out at the bottom.

---

## Ownership at a glance

| Eng | Area | Findings | Files owned exclusively |
|-----|------|----------|-------------------------|
| **A** | Auth & access control | #6, #9, #7 | `apps/api/src/plugins/auth-session.ts`, `apps/api/src/plugins/bearer-key.ts`, `apps/api/src/app.ts`, `apps/api/src/env.ts`, `apps/api/src/modules/auth.ts`, `apps/api/src/modules/system.ts`, `.env.example`, `infra/platform/docker-compose.platform.yml`, **new** `apps/dashboard/app/login/page.js`, **new** `apps/dashboard/lib/auth.js` |
| **B** | Dashboard data integrity | #1, #2 | `apps/dashboard/lib/core.js`, `lib/config.js`, `lib/mock.js`, `lib/sse.js` |
| **C** | attacker-demo hardening | #3, #4, #5 | all of `attacker-demo/` |
| **D** | API robustness & demo correctness | #8, #10, #11, #12, #13 | `apps/api/src/modules/projects.ts`, `modules/response.ts`, `modules/ingest.ts`, `modules/demo.ts`, `apps/api/src/plugins/sse.ts`, `apps/api/src/plugins/rate-limit.ts` |

Note that #13 is deliberately assigned **server-side only** (D, in `demo.ts`) even though it also
shows up in B's and C's files. Fixing it in the API means neither of them has to touch anything —
see D's section.

---

## Engineer A — Auth & access control

Findings **#6** (`DEV_AUTH_BYPASS` default), **#9** (CSRF `Origin` check), **#7** (`/v1/system`
tenant leak). Highest risk per line of code in the whole list, and the one area where a careless
fix makes the demo worse rather than better.

### Start here: the demo has no login

`apps/dashboard` contains **no authentication UI** — there is no `/login` route, and no reference
to `/v1/auth/login`, `/v1/auth/signup` or `/v1/me` anywhere in it. The dashboard functions solely
because `DEV_AUTH_BYPASS=true` (`.env.example:42`) makes every cookie-less request act as the
seeded owner (`auth-session.ts:64`).

So **do not simply set `DEV_AUTH_BYPASS=false`.** If you do, every dashboard call returns 401, and
because of finding #1 a 401 makes the dashboard fall back to `lib/mock.js` — it will look fully
populated and be entirely fabricated, with only a small badge to say so. The failure is silent,
which is the worst available outcome for a demo.

Pick one of two routes and say which in the PR:

- **Gate it (recommended for the demo).** Keep the bypass, but make `env.ts` refuse to load it
  unless `NODE_ENV === 'development'` **and** `HOST` is a loopback address. Flip the
  `.env.example` default to `false` with a comment explaining the loopback requirement, and bind
  `HOST=127.0.0.1` for the demo. This closes "anyone on the venue network is an owner" without
  needing any UI.
- **Add a minimal login.** A `/login` page posting to `/v1/auth/login` with the seeded
  `demo@lxs.dev / demo1234`, plus a `/v1/me` check on boot. Put the page at
  `apps/dashboard/app/login/page.js` and the fetch helper in a **new** `apps/dashboard/lib/auth.js`
  — both new files, so B's work on `lib/core.js` is unaffected.

### The rest

- **#9** — `auth-session.ts:78` only rejects a bad `Origin` when the header is *present*; a request
  with no `Origin` passes the CSRF check entirely. Require the header on mutations. While you are
  in there: `isAllowedOrigin` (`:49`) honours a literal `*` in `CORS_ORIGINS`, which with
  `credentials: true` in `app.ts:34` is a combination worth removing.
- **#7** — `system.ts:32` counts `events`, `incidents` and online `sensors` with no `org_id` or
  `project_id` filter, so any owner sees global totals. Scope it to the caller's orgs. This is why
  the System page can disagree with the project view in front of an audience.
- Worth a look while you own this area (not in the audit as separate findings): the ingest-key
  cache in `bearer-key.ts:29` means a revoked key keeps working for up to 60 s, and
  `/v1/system` advertises `auth: { dev_bypass: true }` (`system.ts:47`).

**Verify:** with the gate in place, `curl` the API from a second machine on the same network and
confirm `POST /v1/projects/:pid/blocklist` returns 401 rather than succeeding. Confirm a mutation
with no `Origin` header is rejected. Confirm `/v1/system` counts match a single project.

---

## Engineer B — Dashboard data integrity

Findings **#1** (reads fall back to mock) and **#2** (mutations fake success). Only two items, but
they are the two that make a working system look broken on stage, and the fix needs judgment
across roughly 25 endpoints rather than a one-line change.

- **#2 first, it is the smaller and more urgent one.** In `lib/core.js`, `action` (`:209`),
  `addBlock` (`:229`), `unblock` (`:231`), `note` (`:210`) and `replay` (`:243`) all route through
  `call()`, which substitutes a mock success envelope on failure. Go through every `api.*` member,
  classify it read or mutate, and give mutations a path that throws instead — `strict()` already
  exists and `bulkResolveNoise` (`:200`) already uses it, so follow that shape.
- **#1** — raise the blanket `timeout = 2500` in `raw()` (`:39`) to something per-endpoint; the
  aggregates (`overview`, `attack-matrix`, `iocs`, `containment`) need several seconds on a loaded
  demo laptop. Then remove 401 and 403 from `shouldFallback` (`:84`): those are auth and permission
  states, not outages, and they deserve a visible "session expired" / "not permitted" state.
  Reconsider the 8-second `downUntil` latch (`:108`) — one slow aggregate currently drags every
  other panel into mock mode with it.
- Make demo mode **loud**. `setDemo(true)` currently drives a small badge; when the dashboard is
  serving fabricated data it should be unmistakable at a glance from across a room.

**Coordination:** your #1 fix is what makes A's work safe to test — until 401 stops silently
falling back to mock, A cannot tell whether a bypass gate is working or whether the dashboard is
quietly lying. **Land #1 and #2 before A flips any default.** Expect to start seeing real 401s
once A's change is in; that is the fix working, not a regression.

**Verify:** stop the API and confirm mutations surface an error instead of a fake success. Point
the dashboard at the API with `DEV_AUTH_BYPASS=false` and confirm you get an auth state rather
than a populated-looking mock dashboard. Throttle one aggregate endpoint and confirm the other
panels stay live.

---

## Engineer C — attacker-demo hardening

Findings **#3** (allowlist bypass / SSRF), **#4** (concurrent runs), **#5** (SSH session
hijack and leak). Self-contained: you own the whole `attacker-demo/` tree and nothing you touch
is touched by anyone else. The most code of the four, all in one package.

- **#3** — `http-attacker.js:40` builds `new URL(path, TARGET_APP_URL)` *after*
  `checkAllowed(TARGET_APP_URL)` has already passed, so an absolute `path` silently replaces the
  target host and the allowlist never sees the host actually hit. Resolve the final URL first,
  then `checkAllowed(url.hostname)`; reject any `path` that is not root-relative. Do the same for
  the SSH guard, which checks only the env host (`ssh-attacker.js:74`). Also bind the service to
  `127.0.0.1` and narrow `app.use(cors())` (`server.js:42`) from wildcard.
- **#5** — `newSessionId()` (`ssh-attacker.js:17`) is `Date.now()` in base-36, and `sshAction`
  writes whatever `sessionId` the caller sends straight into the map (`:93`), so a session can be
  guessed or clobbered. Use `randomBytes`, and never accept a caller-supplied id for a *new*
  session. Sessions opened through `POST /ssh` are never closed — add an idle sweep so leaked
  ssh2 clients stop accumulating against Cowrie's connection limit.
- **#4** — `POST /run` (`server.js:68`) has no concurrency guard and no abort handling: when the
  presenter clicks a second scenario the browser aborts but the server keeps sending real SSH and
  HTTP for the rest of the run. Refuse a second run with a 409 while one is active, key the
  `sessions` map per run so two runs cannot tear down each other's client
  (`run-scenario.js:174`), and watch `req.on('aborted')` to stop the loop.

**One cross-area note:** putting a shared token on `/run`, `/http`, `/ssh` and `/reset` is part of
#3's fix, and it is also authentication. Take the env-var name and middleware shape from **A** so
there is one convention across the two services — a ten-minute conversation, not a blocker. Write
the code yourself in `attacker-demo/`.

**Verify:** `POST /http` with `path: "http://example.com/"` must be refused, not forwarded. Two
overlapping `/run` calls must not produce `no active session` steps. A run aborted from the
browser must stop server-side, which you can see in the honeypot's event stream going quiet.

---

## Engineer D — API robustness & demo correctness

Findings **#13**, **#11**, **#8**, **#10**, **#12**. Five items, each small, no overlap with the
other three. Start with #13 — it is the only one on the demo's critical path.

- **#13 (do this first)** — `demo.ts:180` silently coerces `ps-use-case` and `ps-attacker` to
  `targeted`, and `sqli` / `honeytoken` are not in the enum at all (`:158`), so safe mode's replay
  **422s and plays nothing** while the attacker console animates synthetic steps over an empty
  dashboard. That is the documented mid-demo fallback failing hardest. **Fix it entirely in
  `demo.ts`:** accept every id the two clients actually send, map each to a real entry in
  `SCENARIOS` (`:36`), and reject genuinely unknown ids with a clear error instead of quietly
  substituting `targeted`. Doing it server-side means B's `core.js:243` and C's `safe-mode.js:32`
  need no change — confirm with them that the ids you accept match what they send, then keep the
  fix on your side of the line.
- **#11** — `response.ts:221` does `a.label[0]!.toUpperCase()`, which throws on an empty label and
  500s both the IOC export and the incident Export button. `charAt(0)` plus a fallback.
- **#8** — `projects.ts:18` validates the IP but not the CIDR mask, so `10.0.0.0/999` passes Zod
  and then fails in Postgres as an opaque 422 with no field name. Validate the prefix length by
  family. The allowlist is on the demo path via `assertBlockable` (`response.ts:23`).
- **#10** — `sse.ts:106` binds cleanup only to `req.raw` `'close'` and `res` `'error'`, so a client
  that vanishes otherwise leaves a 15-second interval writing forever and stays in the hub's
  client set; `/v1/stream` is exempt from rate limiting (`rate-limit.ts:29`), so nothing caps the
  connection count. Check `res.destroyed` before writing, and cap connections per project.
- **#12** — `ingest.ts:180` permits 8× decompression (16 MB per request at the default body
  limit) with nothing bounding concurrency. Lower the multiplier.

**Shared-file note:** if #10 or #12 wants a new env var, that is `env.ts` and `.env.example`, both
owned by **A**. Prefer a module-level constant in your own file; if it genuinely needs to be
configurable, send A the one-line schema addition rather than editing those files yourself.

**Verify:** run through each replay id from both clients and confirm events land. Export IOCs on an
incident whose attacker label is empty. Save an allowlist with a bad mask and confirm the error
names the field. Open and kill SSE clients and watch `hub.connections` on the System page return
to zero.

---

## Rules that keep this parallel

1. **Do not edit a file you do not own.** The table above is the authority. Need a change in
   someone else's file, send them the diff.
2. **Two shared-file cases**, both resolved in favour of A: `env.ts` / `.env.example` (A owns; D
   requests additions) and `app.ts` (A owns; D's plugin changes stay inside `sse.ts` and
   `rate-limit.ts`).
3. **One hard ordering dependency: B's #1 and #2 land before A changes any auth default.** With
   the mock fallback still swallowing 401s, A's gate cannot be verified — the dashboard will look
   healthy either way.
4. **One design hand-off:** A gives C the shared-token convention for attacker-api before C
   finishes #3.
5. **#13 stays server-side.** D confirms the accepted scenario ids with B and C, then fixes it in
   `demo.ts` alone. Nobody else touches it.

### Suggested merge order

`B(#2, #1)` → `A(#6, #9, #7)` → `D(#13, #11, #8)` → `C(#3, #5, #4)` → `D(#10, #12)`

B and A are the critical path and gate the first rehearsal. C and D can work the whole time in
parallel; only their merges are ordered, not their work.

### Before the first rehearsal

The four items that make a working system look broken or let the room interfere with it:
**#2** (fake block success), **#1** (fabricated data), **#6** (open API), **#13** (dead safe-mode
replay). Everything else can land after a first clean run-through.

---

## Not covered by this split

Two gaps from the audit's own caveats, unowned and worth a decision:

- Nothing here was **reproduced at runtime** — every finding is from reading the code. The first
  rehearsal is the real test, and a finding may turn out to be unreachable in practice.
- **Dependency versions and the Cowrie / Docker containment posture** were not audited. For a demo
  on an untrusted network that could matter more than several items above. Assign it to whoever
  finishes first.

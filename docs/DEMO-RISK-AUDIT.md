# Demo Risk Audit — code-level vulnerabilities in the current build

Audited 2026-10-31 against the tree as it stands. Scope: code that can break, falsify, or
hijack the **live demo** (`apps/api`, `apps/dashboard`, `apps/decoy-web`, `attacker-demo`).
Every item below is a real code path in this repo, with file and line.

Ordered by how badly it can hurt the demo, not by CVSS.

---

## 1. The dashboard silently replaces real data with invented data — HIGH

**Where:** `apps/dashboard/lib/core.js:39` (`raw`), `:82` (`shouldFallback`), `:97` (`call`)

```js
async function raw(path, { method = "GET", body, timeout = 2500 } = {})   // every call, 2.5 s
...
if (err.status >= 500 || err.status === 401 || err.status === 403) return true;   // -> mock
...
downUntil = Date.now() + 8000;   // whole dashboard in mock mode for 8 s
```

Any of these flips the UI to `lib/mock.js`: a network blip, **any 5xx**, an **expired or
missing session (401)**, an **insufficient-role 403**, most 404s, or **any request that takes
longer than 2500 ms**. One such failure sets `downUntil`, so *all* subsequent calls return
mock data for the next 8 seconds, and `setDemo(true)` latches the demo badge.

**Why it wrecks the demo:** the heavy endpoints are exactly the ones on screen. `buildIocs`
(`apps/api/src/modules/response.ts:201`) scans up to 5 000 events, `overview` and
`attack-matrix` run multi-table aggregates. On a laptop running Postgres + API + two Next
apps, 2.5 s is easy to exceed. When it does, the dashboard shows **fabricated incidents,
attackers and ATT&CK cells** while the attacker console is showing real traffic. The numbers
on the two screens stop agreeing, and the first thing a judge does is compare them.

**Fix direction:** raise the timeout per-endpoint, drop 401/403 from `shouldFallback`
(those are auth bugs, not outages — show a login/permission state), and make mock mode an
explicit, visible switch rather than an automatic one.

---

## 2. Containment actions report success while doing nothing — HIGH

**Where:** `apps/dashboard/lib/core.js:209` (`action`), `:229` (`addBlock`), `:231` (`unblock`),
`:243` (`replay`)

```js
action: (iid, body) =>
  call(`/v1/incidents/${e(iid)}/actions`, { method: "POST", body }, () => mock.action(iid, body)),
addBlock: (pid = PROJECT, body) =>
  call(`/v1/projects/${e(pid)}/blocklist`, { method: "POST", body }, () => mock.addBlock(body)),
```

Mutations go through the same fallback as reads. `blockIp`
(`apps/api/src/modules/response.ts:46`) runs a transaction with four writes plus a
policy-version bump; if it exceeds the 2.5 s client timeout, or the session has expired
(401), or the user is only a `viewer` (403), the browser **aborts and calls the mock**, which
returns a success envelope.

**Why it wrecks the demo:** this is the climax of the script — *block the attacker, show the
attacker console getting refused*. The dashboard will say "blocked", a blocklist row will
appear in the UI, and then the attacker console will keep getting HTTP 200s from the decoy,
because no blocklist row was ever written and `policy_version` never changed, so the agent
never pulls a new policy. It reads on stage as "the product's containment does not work."

**Fix direction:** never fall back on a mutation. Let it throw and surface the real error.

---

## 3. `attacker-api` can be pointed at any host on the network (SSRF past the allowlist) — HIGH

**Where:** `attacker-demo/attacker-api/src/http-attacker.js:28`, `:40`;
`attacker-demo/attacker-api/src/server.js:105`

```js
const guard = checkAllowed(TARGET_APP_URL);   // checks the CONFIGURED target...
...
const url = new URL(path, TARGET_APP_URL);    // ...then lets `path` replace it entirely
```

`checkAllowed` validates the env-configured `TARGET_APP_URL`, but the host actually requested
comes from `new URL(path, TARGET_APP_URL)`. An absolute `path` wins over the base: a request
with `path: "http://169.254.169.254/latest/meta-data/"` or `"http://10.0.0.5:8080/"` sends a
real HTTP request to that host and returns up to 2 000 bytes of the response body
(`http-attacker.js:74`). The allowlist in `allowlist.js` is never consulted for it.

Compounding it: `POST /http`, `POST /ssh`, `POST /run` and `POST /reset` have **no auth at
all** and the service runs `app.use(cors())` (`server.js:42`) — wildcard origin. Any web page
open in the presenter's browser can drive the attack box.

**Why it wrecks the demo:** on a venue or jury network this turns the demo prop into a
general-purpose request forwarder and response reader against the local subnet. Even without
malice, a scenario JSON with an absolute URL in `path` silently attacks the wrong host while
the console cheerfully prints `REAL ASSET TOUCHED` — a result that has nothing to do with the
decoy being demonstrated.

**Fix direction:** resolve the final URL first, then `checkAllowed(url.hostname)`; reject any
`path` that is not a root-relative path; bind the service to `127.0.0.1` and put a shared
token on the mutating routes.

---

## 4. Two overlapping scenario runs corrupt each other — MEDIUM-HIGH

**Where:** `attacker-demo/attacker-api/src/server.js:68`;
`run-scenario.js:50`, `:174`; `ssh-attacker.js:14`

`POST /run` has no concurrency guard and no abort handling. The browser aborts its fetch when
the presenter clicks a second scenario (`attacker-web/app/page.js:103`), but the server loop
does not stop: it keeps sleeping through its pacing ranges and **keeps sending real SSH and
HTTP** to the honeypot for the rest of the scenario, writing frames into a dead socket.

Worse, `sessions` in `ssh-attacker.js:14` is module-level and shared. Two concurrent runs
interleave on it, and the first run's `closeSession(sessionId)` (`run-scenario.js:174`) tears
down the ssh2 client the second run is still using.

**Why it wrecks the demo:** clicking a second scenario (or re-clicking because the first looked
slow — the normal demo reflex) produces steps that fail with `no active session — connect/login
first`, and events from the abandoned run keep landing in the honeypot timeline the presenter
is about to open. The incident the dashboard builds is a blend of two attacks.

**Fix direction:** refuse a second `/run` while one is active (409), key sessions per run, and
watch `req.on('aborted')` / `res.destroyed` to stop the loop.

---

## 5. Unauthenticated SSH sessions with predictable, caller-chosen ids — MEDIUM

**Where:** `attacker-demo/attacker-api/src/ssh-attacker.js:17`, `:93`; `server.js:120`

```js
function newSessionId() { return `s_${Date.now().toString(36)}${counter.toString(36)}`; }
...
const id = sessionId || newSessionId();
sessions.set(id, { client, connected: true, username });
```

`POST /ssh` is unauthenticated and accepts a caller-supplied `sessionId`, which is written
straight into the session map. So anyone who can reach port 6060 can (a) **run commands in the
presenter's live SSH session** by passing its id, which is a timestamp in base-36 and trivially
guessable, or (b) **clobber** an entry by connecting with that same id, so the presenter's next
step runs on a different client. Sessions opened via `/ssh` are also never closed —
`closeSession` is only called from `runScenario` — so ssh2 clients leak until `/reset`.

**Why it wrecks the demo:** the manual SSH console is a hands-on part of the pitch. Someone on
the same network can inject commands into it, and the leaked clients eventually exhaust the
Cowrie honeypot's connection limit so later demos get connection errors that look like the
honeypot crashed.

---

## 6. `DEV_AUTH_BYPASS=true` ships as the default, and it removes all API auth — HIGH

**Where:** `.env.example:42`; `apps/api/src/plugins/auth-session.ts:64`

```ts
if (env.DEV_AUTH_BYPASS) {
  // Dev convenience: anonymous requests act as the oldest user.
  const [u] = await db.select(...).from(users).orderBy(asc(users.createdAt)).limit(1);
  return u ?? null;
}
```

With this on, **a request with no cookie is treated as the seeded owner**. Everything behind
`requireSession` becomes open to anyone who can reach the port — and `HOST` defaults to
`0.0.0.0` (`env.ts:11`): block/unblock IPs (`response.ts:487`, `:498`), patch incident status,
`POST /demo/replay`, project settings and allowlist (`projects.ts`), API-key rotation, and the
`/v1/stream` feed. `.env.example` sets it to `true`; the compose file defaults it to `false`
(`infra/platform/docker-compose.platform.yml:48`), so whether the demo is exposed depends on
which path was used to start it. Note it is also advertised: `/v1/system` returns
`auth: { dev_bypass: true }` (`system.ts:47`).

**Why it wrecks the demo:** on a shared venue network, a spectator with the API URL can block
the attacker IP, fire a replay, or archive the project while the presenter is mid-sentence.
It is also the single most likely question from a security-savvy judge, and the answer
"authentication is off" is a bad one to give at a honeypot demo.

**Fix direction:** make `DEV_AUTH_BYPASS` refuse to load unless `NODE_ENV === 'development'`
*and* `HOST` is loopback, and set it to `false` in `.env.example`.

---

## 7. `/v1/system` counts leak across tenants — LOW-MEDIUM

**Where:** `apps/api/src/modules/system.ts:32`

```sql
select (select count(*) from events) ::int as events,
       (select count(*) from incidents)::int as incidents,
       (select count(*) from sensors where status = 'online')::int as sensors_online
```

No `project_id` or `org_id` filter. Any user who owns *any* org sees global totals.

**Why it matters for the demo:** the System page will show event and incident counts that do
not match the project the rest of the UI is scoped to — e.g. leftovers from yesterday's
rehearsal project. It invites "why do these numbers disagree?" at the worst moment.

---

## 8. Project allowlist accepts a CIDR prefix that Postgres then rejects — LOW

**Where:** `apps/api/src/modules/projects.ts:18`

```ts
return mask === undefined ? `${addr}/${fam === 4 ? 32 : 128}` : `${addr}/${mask}`;
```

The address is validated with `isIP`, the **mask is not**. `10.0.0.0/999` and `10.0.0.0/abc`
pass Zod, then fail on insert into the `cidr[]` column (`schema.ts:75`). The error handler maps
Postgres `22P02` to a generic `invalid_value` / "A value has an invalid format"
(`plugins/error-handler.ts:42`) with no field name.

**Why it matters for the demo:** saving the allowlist on the Settings page fails with an
unexplained error and no indication of which entry is wrong. The allowlist is also what makes
the "we don't block our own scanners" story work (`response.ts:23` `assertBlockable`), so this
is on the demo path.

---

## 9. CSRF check passes when the `Origin` header is absent — LOW

**Where:** `apps/api/src/plugins/auth-session.ts:78`

```ts
const origin = req.headers.origin;
if (origin && !isAllowedOrigin(origin)) throw forbidden(...);
```

A mutation with no `Origin` header is never checked. The real protection today is
`sameSite: 'lax'` on the cookie (`:32`), and with item 6 active no cookie is needed at all.
`isAllowedOrigin` also honours a literal `*` in `CORS_ORIGINS` (`:49`).

---

## 10. SSE connections are uncapped and their heartbeats outlive dead clients — LOW

**Where:** `apps/api/src/plugins/sse.ts:106`; `apps/api/src/plugins/rate-limit.ts:29`

Cleanup is bound only to `req.raw` `'close'` and `res` `'error'`. A client that vanishes
without firing either leaves a 15-second `setInterval` writing forever and stays in the hub's
`clients` set, so the project keeps fanning frames out to it. `/v1/stream` is explicitly
exempt from rate limiting, so nothing caps how many such connections exist.

**Why it matters for the demo:** the dashboard reconnects with exponential backoff
(`lib/sse.js:68`) and the presenter reloads the page repeatedly during setup. Over a long
session these accumulate, and `hub.connections` — shown on the System page — drifts upward
with no attached viewers.

---

## 11. IOC export throws on an empty attacker label — LOW

**Where:** `apps/api/src/modules/response.ts:221`

```ts
context: `${a.label[0]!.toUpperCase()}${a.label.slice(1)}...`
```

`attackers.label` is `notNull default 'noise'` but is **not constrained to be non-empty**, and
the worker writes `verdict.label` through unchecked (`worker/process-events.ts:289`). An empty
string makes this a `TypeError`, which the error handler turns into a 500 for both
`GET /v1/projects/:pid/iocs` and the incident Export action.

**Why it matters for the demo:** the IOC export is a closing beat of the script, and it would
fail with a bare 500 rather than degrading. One-character fix (`a.label.charAt(0)`).

---

## 12. Gzip ingest allows 8× body amplification — LOW

**Where:** `apps/api/src/modules/ingest.ts:180`

```ts
buf = await gunzipAsync(body, { maxOutputLength: env.MAX_BODY_BYTES * 8 });
```

16 MB decompressed per request at the default 2 MB body limit, against a per-key limit of
1200 requests/min (`.env.example:46`). Nothing bounds concurrent decompression.

**Why it matters for the demo:** a misconfigured or chatty agent can push API memory hard
during the run, and the resulting slow responses feed straight into items 1 and 2.

---

## 13. The dashboard's named scenario button does not run that scenario — demo-consistency bug

**Where:** `apps/api/src/modules/demo.ts:158`, `:180`

```ts
scenario: z.enum(['targeted', 'opportunistic', 'noise', 'ps-use-case', 'ps-attacker'])
...
const scenario = requestedScenario === 'opportunistic' || requestedScenario === 'noise'
  ? requestedScenario
  : 'targeted';
```

`ps-use-case` and `ps-attacker` are accepted and then silently coerced to `targeted` — there is
no entry for either in `SCENARIOS` (`:36`). The dashboard's replay button sends
`{ scenario: "ps-use-case" }` (`apps/dashboard/lib/core.js:243`) and the attacker console's safe
mode sends `{ scenarioId: ... }` for whichever scenario was clicked
(`attacker-demo/attacker-api/src/safe-mode.js:32`), including `sqli` and `honeytoken`, which
are not in the enum at all and therefore **422 the replay outright**.

**Why it matters for the demo:** the response echoes `scenario: "targeted"` while the button
says something else, so the audit entry and the incident don't match the narration. In safe
mode — the documented "flip to safe mid-demo" fallback — picking the SQLi or honeytoken
scenario kicks off no replay at all; `triggerReplay` swallows the failure by design
(`safe-mode.js:36`) and the console animates synthetic steps over an empty platform. The
dashboard stays blank while the attacker screen looks busy.

---

## Suggested order of work before the demo

| # | Item | Effort |
|---|------|--------|
| 2 | Stop mutations falling back to mock | small |
| 1 | Per-endpoint timeouts; drop 401/403 from fallback | small |
| 6 | `DEV_AUTH_BYPASS=false` in `.env.example`, gate on loopback | small |
| 13 | Map `ps-*` / `sqli` / `honeytoken` to real scenarios or reject loudly | small |
| 3 | Resolve-then-allowlist in `http-attacker.js`; bind to loopback | small |
| 11, 8 | `charAt(0)`; validate the CIDR mask | trivial |
| 4, 5 | Per-run SSH sessions, `/run` concurrency guard, abort handling | medium |
| 7, 9, 10, 12 | Scope `/v1/system`, require `Origin`, cap SSE, cap gunzip | medium |

Items 1, 2 and 13 are the ones that make a working system look broken on stage. Items 3, 5 and
6 are the ones that let someone in the room interfere with it.

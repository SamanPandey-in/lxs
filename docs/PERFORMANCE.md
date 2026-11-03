# PERFORMANCE.md — why it feels slow, and the plan

Measured on 2026-10-31 against the running stack (Windows 11, Docker Desktop, Postgres 16
in a container, API and dashboard on the host). Every number below came from a probe
run on this machine, not from an estimate.

---

## The headline

**The backend is not slow. The dashboard is being served in development mode.**

| Layer | Measured | Verdict |
|---|---|---|
| API reads (9 endpoints) | p50 **30 ms**, p95 **< 51 ms** | Fine |
| `POST /v1/ingest` | **63–85 ms** for a 4–12 event batch | Fine |
| Detection, ingest → incident visible | **1.09 s** for a 12-event burst | Fine |
| Dashboard, **dev mode** (`next dev`) | TTFB **128–1896 ms**, wall **658–2597 ms** | **This is the problem** |
| Dashboard, **production build** | TTFB **14–66 ms**, wall **124–292 ms** | 5–20× faster |

`pnpm demo` and `pnpm dev` both start the dashboard with `next dev`, which compiles each
route on first visit. Clicking into a screen the session has not opened yet costs one to
two and a half seconds, every time. That is almost certainly what "too slow" means.

### Per-route, dev vs production

| Route | dev wall | prod wall |
|---|---|---|
| Overview | 710 ms | 292 ms |
| Incident queue | 1337 ms | 143 ms |
| Incident hero | 1067 ms | 163 ms |
| Live feed | **2597 ms** | 134 ms |
| Decoys | **2049 ms** | 126 ms |
| Attackers | 1395 ms | 124 ms |

Warm client-side navigation: **~600–770 ms** in dev, **~14–78 ms** in production.

---

## The findings, ranked

### 1. The demo serves the dashboard from the dev server — *the whole problem, nearly*

`scripts/demo.mjs` and `scripts/dev.mjs` run `npm run dev`. Next.js then compiles each
route the first time it is visited. During a judged demo, every screen you open for the
first time pays that cost in front of the audience.

**Fixed by:** `demo.mjs` now runs `npm run build` and then `next start` by default.
`pnpm demo --dev` keeps `next dev` for when you are actually editing the dashboard.

**Status: done.** See the before/after table at the end.

---

### 2. The production build silently fell back to demo data — two causes, one fixed diagnosis

I first reported this as "the build bakes the mock project id". That was half right, and
the half that was wrong matters, so here is the corrected version.

**What actually caused the fallback I measured:** `CORS_ORIGINS` defaulted to
`localhost:3000,localhost:5173`. I was measuring the production build on `:3010`, so the
browser's `GET /v1/projects` was blocked by CORS, project discovery failed, and
`resolveProject()` returned the mock id. The dashboard then showed a "Demo data" badge
while the real database sat there holding the live incident. **Any host or port not on
that list degrades to demo data silently** — that is the real bug, and it would have bitten
the first real deployment.

**What was also true, and is a genuine latent bug:** `NEXT_PUBLIC_*` is inlined at
**build** time. `demo.mjs` passed the API URL as a runtime env to `npm run dev`, which only
worked because dev recompiles with that env present. A production image built once and
deployed anywhere would carry the build machine's API URL.

**Fixed by:**
- `app/api/config/route.js` — a `force-dynamic` route evaluated per request, returning
  `{ apiUrl, projectId }` from server-side env. One build now runs against any host.
- `lib/config.js` — fetches it once on boot; build-time values survive only as the
  pre-boot default. `lib/core.js` uses a `coreUrl()` getter instead of a `CORE` constant.
- `CORS_ORIGINS` default now includes `:3010`, and the demo passes `LXS_API_URL` /
  `LXS_PROJECT_ID` as runtime env.

**Status: done.** `/api/config` returns the live project UUID, the dashboard calls the real
project, and the badge reads **Live** rather than *Demo data*.

---

### 3. The store polls a full refetch every 7 s *while SSE is connected*

`lib/store.js` runs `bootstrap()` on a 7-second interval regardless of stream state:

```js
setInterval(() => {
  if (document.visibilityState !== "hidden") bootstrap();
}, 7000);
```

`bootstrap()` is four requests — `overview`, `incidents?limit=200`, `events?limit=200`,
`decoys`. The events payload alone was **19 kB** with only ~30 events in the database; on
a busy project it is the largest response the dashboard fetches, and it is being pulled
every seven seconds per open tab.

On top of that, six pages add their own polls: blocklist 4 s, audit 6 s, decoys 6 s,
system 6 s, attackers 7 s, containment 10 s. Open the attackers page and you are making
five requests every seven seconds for data the SSE stream is already pushing.

The stream works — it connects, it keeps alive, and `event.new` / `incident.updated`
frames carry what the screens need. The polling is belt-and-braces that was never removed.

**Fixed by:**
- `lib/store.js` now polls on a cadence that follows the connection: **60 s** while the
  stream is live, **7 s** when it is down, and **nothing at all** while the tab is hidden
  (coming back into view reconciles immediately rather than waiting out the interval).
- `bootstrap()` split into a full `pull({withEvents:true})` and a light `reconcile()`.
  The periodic reconcile fetches overview + incidents + decoys and **skips the ~19 kB
  events payload**, because the stream already pushes events. The full pull now happens
  only on first load and **after a reconnect**, where frames were genuinely missed.
- All connection-state changes route through one `setConn()`, which is what drives the
  cadence and triggers the catch-up pull.
- Pages that fetch their own endpoints (blocklist, audit, attackers, decoys, containment,
  system) no longer poll on 4–10 s. The store exposes a `rev` counter it bumps whenever a
  frame invalidates that kind of data; `usePolling` refetches on that push and otherwise
  falls back to a 30 s safety poll while live. Their original interval is still used when
  the stream is down.

**Status: done.** Idle traffic on the Overview went from **~44 API calls per 75 s to 3**,
and the largest payload left the steady state entirely.

---

### 4. Every navigation fires ~14 route prefetches

Next.js `<Link>` prefetches by default. The sidebar links to 11 routes, and the queue
links to incident detail pages, so a single page load triggers ~14 extra `?_rsc=`
requests — I counted 13–14 on every route.

In production each is small and cached. In dev each one can **trigger a compile** of the
route it points at, which is part of why dev feels so bad.

**Fixed by:** `prefetch={false}` on the sidebar nav, table rows (`RouteLink`, the incident
queue row link), ATT&CK chips, every ATT&CK matrix cell, the blocklist links and the
Overview's incident rows. Prefetch is kept on the primary call-to-action buttons, which
are the links an analyst actually clicks next.

**Status: done.** RSC prefetches per page load fell from **14 to 1–2**.

---

### 5. The worker re-evaluates the whole chain once per ingest call

A 12-event burst in **one** POST settles in 1.09 s. The same 12 events delivered as 12
separate POSTs (what the simulator does at realistic pacing, and what a real agent does)
create 12 jobs, and each one re-reads that attacker's entire event history and re-runs
`evaluateChain` over all of it. The work is O(n²) in chain length. This is what made a
drip-fed 19-event scenario take ~10 s to settle earlier.

It is not hurting the demo today — `pg-boss` runs with `batchSize: 4` and the chains are
short. It will hurt with a long-running attacker or a busy sensor.

**Fix.** Coalesce per attacker: a debounce window (~500 ms) or a pg-boss singleton key per
`(project_id, attacker_id)` so bursts collapse into one evaluation.

**Effort:** ~1.5 hours. **Gain:** removes the quadratic; keeps burst latency ~1 s as chains
grow.

---

### 6. The ~30 ms floor on every API call — leave it alone

Every endpoint, including ones returning an empty body, costs ~20–30 ms. It is **not**
auth: `bearer-key.ts` already caches key lookups with a TTL, and the pool is `max: 10`.
It is almost entirely Docker Desktop's network hop to the Postgres container on Windows.

On a Linux host, or with Postgres on the same host, this largely disappears. 30 ms is well
inside budget for a SOC dashboard.

**Do not optimise this.** It would be effort spent on the one layer the measurements say
is healthy.

---

## The plan, in order

| # | Change | Status |
|---|---|---|
| 1 | Runtime config instead of build-time baking (#2) | **Done** |
| 2 | Demo serves a production build (#1) | **Done** |
| 3 | `prefetch={false}` on nav, rows, chips, matrix cells (#4) | **Done** |
| 4 | SSE-aware polling (#3) | **Done** |
| 5 | Coalesce worker jobs per attacker (#5) | Not started — ~1.5 h |

---

## Results of items 1–3

Same machine, same probes, production build vs the dev server the demo used to start.

| Route | before (dev) | after (prod) | faster by |
|---|---|---|---|
| Overview | 710 ms | **250 ms** | 2.8× |
| Incident queue | 1337 ms | **126 ms** | 10.6× |
| Incident hero | 1067 ms | **239 ms** | 4.5× |
| Live feed | 2597 ms | **181 ms** | 14.3× |
| Attackers | 1395 ms | **139 ms** | 10.0× |
| ATT&CK matrix | 658 ms | **125 ms** | 5.3× |
| Decoys | 2049 ms | **142 ms** | 14.4× |
| Audit | 754 ms | **161 ms** | 4.7× |

Warm client-side navigation: **~600–770 ms → ~67–143 ms**.
RSC prefetches per page load: **14 → 1–2**.
API and detection latency unchanged, as expected — they were never the problem
(`/v1/ingest` 116 ms, ingest → incident visible 994 ms).

Tests (109), typecheck (13 packages) and lint all still pass.

## Results of item 4

| Measure | before | after |
|---|---|---|
| Idle API calls, Overview, 75 s | ~44 | **3** (one reconcile at the 60 s mark) |
| Events payload (~19 kB) in steady state | every 7 s | **never** — only on load and reconnect |
| Per-page polls while live | 4–10 s | push-driven, 30 s safety net |
| Polling while the tab is hidden | continued | **stopped** |

**Liveness was the risk, and it holds.** With the slow poll in place, a fresh attack chain
is on screen **1.7 s** after ingest — that is the stream doing its job, not the poll.

Two earlier runs of that test reported a failure; both were faults in the test harness,
not the product. The first watched for a source IP that the burst script never used, and
the second watched the incident queue, which defaults to the Targeted tab while the burst
produces an opportunistic incident. Worth recording, because a test that lies about a
regression is worse than no test.

### What is left

Only item 5. The worker still re-reads an attacker's full history on every ingest call,
which is O(n²) in chain length. It is invisible today and will not be felt until chains
get long or a sensor gets busy.

## How to re-measure

The probes used here are reproducible:

```bash
node scripts/perf/api.mjs <project-id>     # endpoint p50/p95 + detection latency
node scripts/perf/web.mjs <base-url> <id>  # per-route TTFB / DOM-ready / wall
node scripts/perf/burst.mjs <project-id>   # ingest -> settled score
```

Re-run them after each change and record the numbers here. A performance claim without a
before and after is a guess.

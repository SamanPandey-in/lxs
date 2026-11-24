# scripts/perf — the probes behind docs/PERFORMANCE.md

Reproducible measurements. A performance claim without a before and after is a guess.

```bash
# 1. API read latency (p50/p95) + ingest -> incident-visible latency
node scripts/perf/api.mjs <project-id>

# 2. Per-route TTFB / DOM-ready / wall time, cold and warm, in a real browser
node scripts/perf/web.mjs http://localhost:3000 <incident-id>

# 3. The demo's most visible latency: a burst of events -> settled score
node scripts/perf/burst.mjs <project-id>
```

```bash
# 4. G5 burst: a 5,000-event single-attacker chain as 100 POSTs of 50; drain time, job count,
#    worker busy time (needs the API's DATABASE_URL, read-only)
node scripts/perf/chain5k.mjs --project <project-id> --db "$DATABASE_URL"   [--api http://localhost:8080] [--events 5000] [--batch 50] [--metrics-token <token>]
```

`chain5k.mjs` reads `events` for its own random source IP and `pgboss.job`/`pgboss.archive` rows
for the project; it writes only through `/v1/ingest`. Use a throwaway project or a scratch
database (a `postgres:16-alpine` container on another port, migrated and seeded with
`pnpm --filter @lxs/api db:migrate` / `db:seed`), never production. To compare two builds, run
each API against the same scratch DB on a spare port and point `--api` at it.

Get the project id from `pnpm db:seed`, or:

```bash
curl -s -H "Authorization: Bearer ds_dev_0000000000000000000000000000000000000000" \
  http://localhost:8080/v1/projects
```

`web.mjs` needs `puppeteer-core` and a local Chrome. It is not a workspace dependency —
install it ad hoc when you need it:

```bash
npm i -g puppeteer-core   # or run it from a scratch directory
```

**Measure the production build, not the dev server.** `next dev` compiles routes on
demand and is 5–20× slower; benchmarking it tells you nothing about what you ship.

```bash
cd apps/dashboard && npm run build && npx next start -p 3010
node scripts/perf/web.mjs http://localhost:3010 <incident-id>
```

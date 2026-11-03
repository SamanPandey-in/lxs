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

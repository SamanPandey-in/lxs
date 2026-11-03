# tests/e2e

Scenario-driven end-to-end tests. Two layers:

| File | Runs | Asserts |
|---|---|---|
| `scenarios.ts` | — | The locked expectations from BREAKDOWN §12.3 |
| `scenarios.test.ts` | `pnpm test:api` | Drives the simulator against a live API and checks the resulting incident |
| `*.spec.ts` | `pnpm test` (Playwright) | The dashboard renders the resulting incident correctly |

## Running

```bash
pnpm platform:up && pnpm db:migrate && pnpm db:seed
pnpm dev                       # API :8080, dashboard :3000
pnpm --filter @lxs/e2e test:api
pnpm --filter @lxs/e2e test
```

## Why the numbers are hard-coded

The demo narrates "5 → 10 → 20 → 45 → 50 → 60 → 70, then Critical" out loud. If a rule
change moves those numbers, the demo script is wrong and nobody notices until a judge is
watching. So the numbers live here as a locked fixture: change a rule, and CI tells you
which story you just broke.

# LXS SOC dashboard

Analyst-facing web app (Next.js 15 App Router, JavaScript, React 19, Tailwind v4, lucide-react, next-themes, sonner, recharts).
This is a **standalone npm project**, deliberately excluded from the pnpm workspace.

## Run

```bash
cd apps/dashboard
npm install
npm run dev                  # http://localhost:3000
npm run build && npm start   # production check
```

The dashboard shows real data or a visible failure. If the API is unreachable, slow, or refuses
the session, a red banner says so, pages show an error or their last good data, and actions
report the real error.

Set `LXS_ALLOW_MOCK=1` to work without an API. During an outage, reads then fall back to the
built-in dataset in `lib/mock.js` under a full-width red **MOCK DATA** banner, with a simulated
live stream. Real data returns as soon as the API does. 401 and 403 never fall back, and neither
does any action: block, unblock, status changes and replay always go to the real API.

## Config (optional, `.env.local`)

| Variable | Default | Meaning |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:8080` | Platform API base URL (`/v1/...`, SSE at `/v1/stream?project=`) |
| `NEXT_PUBLIC_PROJECT_ID` | auto | Project id. If unset, the dashboard calls `GET /v1/projects` (API runs with `DEV_AUTH_BYPASS=true` in dev) and picks `acme-shop`, else the first project |
| `LXS_ALLOW_MOCK` | off | `1` allows mock reads during an API outage (see above). Read at runtime by `/api/config` |

Requests use `credentials: 'include'` (session cookie); the API must allow the dashboard origin via CORS.

## Demo path

1. `/` Overview: 4 severity tiles, open targeted incidents, live feed, sensor health.
2. `/incidents`, then open **#7** (Critical, Targeted): kill chain, "Why is this critical?" ledger
   (5, 10, 20, 45, 50, 60, 70, then floor Critical), timeline, AI summary, **Block source** (confirm, toast, audit row).
3. `/attack`, `/decoys` (containment PASS 10/10), `/blocklist`, `/audit`, `/onboarding`.

Routes: `/`, `/feed`, `/incidents`, `/incidents/[id]`, `/attackers`, `/attackers/[id]`, `/attack`, `/decoys`, `/blocklist`,
`/audit`, `/settings`, `/system`, `/onboarding`.

Layout: `app/` pages, `components/` (Shell, ui, workspace, charts, killchain), `lib/` (core fetch client with opt-in mock reads,
sse, store, hooks, labels, nav, toast, utils, mock).

## Design system

`app/globals.css` is the Genesis `api-client` stylesheet copied wholesale (tokens, utilities, responsive rules) plus the four
`--sev-*` severity aliases. `components/ui/` (shadcn / Base UI primitives), `Shell.jsx` and `ui.jsx` are copied and re-skinned.
LXS-only styling lives in `app/lxs.css` (new or `ds-` prefixed class names only; the reference sheet is not modified).

## Severity floors

A severity floor raises the displayed score to the band floor (Critical 75, High 50), so score and severity never contradict.
The hero ledger shows "65 raw points -> score raised to 75 by the CRITICAL floor" when that happens.

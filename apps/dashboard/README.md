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

No API needed. When the platform API is unreachable (network error, 5xx, 401/403, unknown project) the dashboard falls back
to the built-in dataset in `lib/mock.js` and shows a **Demo data** badge in the topbar. A simulated live stream adds a decoy
event every few seconds. When the API is up, real data wins (re-checked every few seconds).

## Config (optional, `.env.local`)

| Variable | Default | Meaning |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:8080` | Platform API base URL (`/v1/...`, SSE at `/v1/stream?project=`) |
| `NEXT_PUBLIC_PROJECT_ID` | auto | Project id. If unset, the dashboard calls `GET /v1/projects` (API runs with `DEV_AUTH_BYPASS=true` in dev) and picks `acme-shop`, else the first project; with no API it uses the demo project |

Requests use `credentials: 'include'` (session cookie); the API must allow the dashboard origin via CORS.

## Demo path

1. `/` Overview: 4 severity tiles, open targeted incidents, live feed, sensor health.
2. `/incidents`, then open **#7** (Critical, Targeted): kill chain, "Why is this critical?" ledger
   (5, 10, 20, 45, 50, 60, 70, then floor Critical), timeline, AI summary, **Block source** (confirm, toast, audit row).
3. `/attack`, `/decoys` (containment PASS 10/10), `/blocklist`, `/audit`, `/onboarding`.

Routes: `/`, `/feed`, `/incidents`, `/incidents/[id]`, `/attackers`, `/attackers/[id]`, `/attack`, `/decoys`, `/blocklist`,
`/audit`, `/settings`, `/system`, `/onboarding`.

Layout: `app/` pages, `components/` (Shell, ui, workspace, charts, killchain), `lib/` (core fetch client with mock fallback,
sse, store, hooks, labels, nav, toast, utils, mock).

## Design system

`app/globals.css` is the Genesis `api-client` stylesheet copied wholesale (tokens, utilities, responsive rules) plus the four
`--sev-*` severity aliases. `components/ui/` (shadcn / Base UI primitives), `Shell.jsx` and `ui.jsx` are copied and re-skinned.
LXS-only styling lives in `app/lxs.css` (new or `ds-` prefixed class names only; the reference sheet is not modified).

## Severity floors

A severity floor raises the displayed score to the band floor (Critical 75, High 50), so score and severity never contradict.
The hero ledger shows "65 raw points -> score raised to 75 by the CRITICAL floor" when that happens.

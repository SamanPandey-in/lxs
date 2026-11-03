# frontend.md — LXS SOC Dashboard (frontend build guide)

### How to build the dashboard front end, reusing the Genesis / "healr" design system

| | |
|---|---|
| Scope | **Dashboard only.** The analyst-facing SOC web app (diagram `WEB`, steps 6–8). The attacker demo app has its own two docs (`attackerFRONTEND.md`, `attacker.md`). |
| Design source | The `api-client/` app inside `Genesis_Prototype-sam-fix` ("healr" core dashboard). We keep its tokens, shell, component vocabulary and page grammar; we swap the domain from "API healing" to "honeypot SOC". |
| Audience | Whoever owns P4 (dashboard + story) and anyone building a screen. |
| Stack decision | **Match the source: Next.js (App Router, JS), React 19, Tailwind v4, shadcn (base-nova style) on Base UI, lucide-react, next-themes, sonner.** This overrides the `React + Vite` line in BREAKDOWN §4 for the dashboard, for one reason: we already have a finished, battle-tested implementation of this exact design in the Genesis repo, and copying it is hours, not days. See §12 for how this sits next to the BREAKDOWN. |

The golden rule of this guide: **you are not inventing a look. You are re-skinning healr.** Every time you reach for a style decision, open the matching file in `api-client/` first and copy its shape. The analyst-facing polish is already solved there.

---

## Table of contents

1. [What we are copying, in plain words](#1-what-we-are-copying-in-plain-words)
2. [Stack and dependencies](#2-stack-and-dependencies)
3. [The design tokens (copy these verbatim)](#3-the-design-tokens-copy-these-verbatim)
4. [Global stylesheet and utility classes](#4-global-stylesheet-and-utility-classes)
5. [The app shell (sidebar + topbar + theme)](#5-the-app-shell-sidebar--topbar--theme)
6. [The shared component vocabulary](#6-the-shared-component-vocabulary)
7. [The data layer (SSE store + fetch client + hooks)](#7-the-data-layer-sse-store--fetch-client--hooks)
8. [Domain language map (healr → LXS)](#8-domain-language-map-healr--lxs)
9. [Page-by-page build guide](#9-page-by-page-build-guide)
10. [The hero: Incident detail screen](#10-the-hero-incident-detail-screen)
11. [Folder structure](#11-folder-structure)
12. [Relationship to BREAKDOWN.md, and the drift from the PDF](#12-relationship-to-breakdownmd-and-the-drift-from-the-pdf)
13. [Build order and definition of done](#13-build-order-and-definition-of-done)

---

## 1. What we are copying, in plain words

Think of the Genesis dashboard as a fully furnished apartment. We like the apartment: the wall colour, the light switches, the way the rooms connect. We are not rebuilding it. We are moving in and changing what is *on* the walls — the healr app showed "API calls healed", ours shows "attacks caught". The furniture (cards, tables, pills, drawers), the wiring (the live event store), and the paint (the colour tokens) all stay.

Concretely, four things come across almost unchanged:

1. **The tokens** — one block of CSS variables for light and dark (§3). It is a calm, teal-accented SOC theme. Keep it.
2. **The shell** — a 224px left sidebar with grouped nav, a sticky 48px topbar with breadcrumb + live-connection pill + theme toggle, a scrollable page area (§5).
3. **The component kit** — `PageHeader`, `Card`, `StatTile`, `Pill`, `EmptyState`, `Drawer`, `Modal`, `Tabs`, filter bar, native tables, timeline, chain blocks (§6). These already exist in `components/ui.jsx` and `components/workspace.jsx`.
4. **The live data layer** — an external store fed by SSE with reconnect/replay, plus `useAsync`/`usePolling` hooks and a thin fetch client (§7). Our events are different; the machinery is identical.

What changes is only the domain: entities, event types, severities, the hero screen. That is §8–§10.

---

## 2. Stack and dependencies

Copy `api-client/package.json`'s dependency set. The versions below are what Genesis shipped with; pin whatever is current at build time and keep the same libraries.

| Dependency | Role | Notes |
|---|---|---|
| `next` | App Router, JS (no TS in the UI, matching source) | `next dev -p 3000` |
| `react`, `react-dom` | React 19 | |
| `tailwindcss` + `@tailwindcss/postcss` | Tailwind v4 (CSS-first config, no `tailwind.config.js`) | configured entirely in `globals.css` via `@theme inline` |
| `shadcn` + `@base-ui/react` | component primitives (style `base-nova`, Base UI under the hood, **not** Radix) | `components.json` below |
| `class-variance-authority`, `cn` | variant + class merge | `lib/utils.js` re-exports `cn` from the `cn` package |
| `lucide-react` | icons | one icon system everywhere |
| `next-themes` | light/dark with `class` attribute | `ThemeProvider` in `layout.js` |
| `sonner` | toasts | `<Toaster position="bottom-right" richColors />` in the shell |
| `tw-animate-css` | animation utilities | imported in `globals.css` |

`components.json` (copy from source, change nothing except maybe the name):

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "base-nova",
  "rsc": true,
  "tsx": false,
  "tailwind": { "config": "", "css": "app/globals.css", "baseColor": "neutral", "cssVariables": true, "prefix": "" },
  "iconLibrary": "lucide",
  "aliases": { "components": "@/components", "utils": "@/lib/utils", "ui": "@/components/ui", "lib": "@/lib", "hooks": "@/hooks" },
  "menuColor": "default", "menuAccent": "subtle"
}
```

`jsconfig.json`, `postcss.config.mjs` and `next.config.js`: copy verbatim from `api-client/`. The `@/*` path alias and the `@tailwindcss/postcss` plugin are all that matter.

Pull the whole `components/ui/` folder across unchanged — `button.jsx`, `badge.jsx`, `card.jsx`, `dialog.jsx`, `sheet.jsx`, `table.jsx`, `tabs.jsx`, `select.jsx`, `input.jsx`, `textarea.jsx`, `switch.jsx`, `tooltip.jsx`, `skeleton.jsx`, `sonner.jsx`, `scroll-area.jsx`, `separator.jsx`, `label.jsx`, `alert.jsx`, `dropdown-menu.jsx`. They are generic shadcn/Base-UI primitives with no healr-specific logic, so they drop straight in.

---

## 3. The design tokens (copy these verbatim)

This is the heart of the look. Paste this at the top of `app/globals.css`, unchanged. It is a neutral-grey canvas with a single teal brand accent and a set of **named semantic status colours** — and those status colours are exactly what a SOC dashboard needs, because they already encode a "good → bad" scale we can map onto severity.

```css
:root {
  color-scheme: light;
  --background: #f7f8fa; --foreground: #17191c; --card: #ffffff; --card-foreground: #17191c; --popover: #ffffff; --popover-foreground: #17191c;
  --primary: #087e75; --primary-foreground: #ffffff; --secondary: #eef1f3; --secondary-foreground: #202428; --muted: #f0f2f4; --muted-foreground: #626b73;
  --accent: #e8f3f1; --accent-foreground: #086c65; --destructive: #c43d42; --border: #e1e5e8; --input: #d8dee2; --ring: #168c82;
  --chart-1: #168c82; --chart-2: #5793c9; --chart-3: #d49a38; --chart-4: #7d8994; --chart-5: #bd6267;
  --radius: .5rem;
  --sidebar: #ffffff; --sidebar-foreground: #30373d; --sidebar-primary: #087e75; --sidebar-primary-foreground: #fff; --sidebar-accent: #eef5f4; --sidebar-accent-foreground: #086c65; --sidebar-border: #e6e9eb; --sidebar-ring: #168c82;
  --surface: #fff; --surface-2: #f6f8f9; --surface-3: #eef1f3; --border-strong: #d5dce0; --text: #17191c; --text-dim: #626b73; --text-faint: #89929a;
  --brand: #087e75; --link: #1769aa;
  /* status scale — reused for severity (see §8.4) */
  --ok: #23845d; --ok-muted: #e5f3eb; --healed: #087e75; --rejected: #547da3; --halted: #697783; --halted-muted: #edf0f2; --drift: #94610d; --cache: #16818c; --bad: #c43d42; --bad-muted: #fae9e9;
}
.dark {
  color-scheme: dark;
  --background: #101214; --foreground: #e8ebed; --card: #171a1d; --card-foreground: #e8ebed; --popover: #1b1e21; --popover-foreground: #e8ebed;
  --primary: #55b7aa; --primary-foreground: #09211e; --secondary: #24292d; --secondary-foreground: #e8ebed; --muted: #222629; --muted-foreground: #a0a9af;
  --accent: #202e2c; --accent-foreground: #9de1d7; --destructive: #e16b70; --border: #2d3337; --input: #394146; --ring: #55b7aa;
  --chart-1: #55b7aa; --chart-2: #77a9d2; --chart-3: #dfb361; --chart-4: #8e9aa2; --chart-5: #d17d82;
  --sidebar: #15181a; --sidebar-foreground: #d6dbde; --sidebar-primary: #55b7aa; --sidebar-primary-foreground: #09211e; --sidebar-accent: #202e2c; --sidebar-accent-foreground: #9de1d7; --sidebar-border: #292f33; --sidebar-ring: #55b7aa;
  --surface: #15181a; --surface-2: #1b1f22; --surface-3: #22272a; --border-strong: #394146; --text: #e8ebed; --text-dim: #a0a9af; --text-faint: #778188;
  --brand: #55b7aa; --link: #83b8e5;
  --ok: #56b78a; --ok-muted: #19382a; --healed: #55b7aa; --rejected: #83b8e5; --halted: #a2adb5; --halted-muted: #2b3236; --drift: #dfb361; --cache: #5cbcc4; --bad: #e16b70; --bad-muted: #3b2224;
}
```

Then the `@theme inline` block that maps those variables to Tailwind utilities — copy it verbatim from `api-client/app/globals.css` (the `--color-*`, `--font-*`, `--radius-*` lines). It is what makes `bg-background`, `text-foreground`, `border-border`, `text-muted-foreground`, etc. resolve to the tokens above.

**Fonts:** Inter for sans, SFMono for mono, as in the source `@theme` block. Body is **13px** with `line-height: 1.5` — this small base size is deliberate and is a big part of why the dashboard feels dense and professional. Do not bump it.

**One addition for us.** The source has `--ok --healed --rejected --halted --drift --cache --bad`. We add four severity aliases so severity has first-class names (put these inside both `:root` and `.dark`, pointing at existing colours so dark mode is free):

```css
/* in :root */   --sev-critical: var(--bad);   --sev-high: var(--drift);   --sev-medium: var(--rejected); --sev-low: var(--halted);
/* in .dark */   --sev-critical: var(--bad);   --sev-high: var(--drift);   --sev-medium: var(--rejected); --sev-low: var(--halted);
```

Rationale: critical = red (`--bad`), high = amber (`--drift`), medium = blue-grey (`--rejected`), low/noise = grey (`--halted`). This reuses the existing palette so there is no new colour to tune, and it reads correctly at a glance. Also add them to the `@theme inline` block as `--color-sev-critical: var(--sev-critical);` etc. so `text-sev-critical` works.

---

## 4. Global stylesheet and utility classes

After the tokens, copy the rest of `api-client/app/globals.css` wholesale. It is ~240 lines of hand-written, responsive, token-driven utility classes that the pages lean on heavily. The ones you will use constantly:

| Class | What it does | Used by |
|---|---|---|
| `.shell`, `.sidebar`, `.brand`, `.brand-mark`, `.nav-group`, `.nav-item`, `.sidebar-foot` | the whole left-rail + grid layout (224px + 1fr), with responsive collapse at 980px and a horizontal scroller at 680px | shell (§5) |
| `.main`, `.topbar`, `.crumbs`, `.page`, `.page-head` | top bar and page frame; `.page` is `max-width:1440px` centred with 28px padding | shell, every page |
| `.overview-grid`, `.overview-metrics` | the Overview's 1.65fr/1fr split and 4-up metric row | Overview (§9.1) |
| `.pill` + `.pill[data-tone='…']` | the status chip; tones: `ok live healed rejected halted drift cache bad` | everywhere |
| `.chip`, `.chip[data-op='…']` | small mono chips (we reuse for ATT&CK IDs) | incident, attacker |
| `.stat`-style via `StatTile` + `.tile-label/.tile-value/.tile-hint` | metric tiles | Overview, metrics |
| `.feed`, `.event`, `.event-dot` | the live activity feed rows | Overview, Live feed |
| `.resource-row`, `.resource-primary`, `.resource-meta` | list rows (we reuse for the decoy list) | Overview, Decoys |
| `.health-row`, `.health-dot.is-live/.is-offline/.is-pending` | service/sensor health rows | Overview, Containment |
| `.native-table`, `.table-scroll`, `.interactive-row`, `.table-link`, `.table-sub` | the dense data tables | Incidents, Attackers, Audit, Blocklist |
| `.filter-bar`, `.filter-field`, `.filter-search` | filter controls above tables | every list page |
| `.detail-stack`, `.detail-grid`, `.detail-section`, `.reason-box`, `.plain-list`, `.timeline` | the drawer/detail interior | Incident detail, Attacker profile, drawers |
| `.chain`, `.block`, `.chain-segment`, `.chain-block`, `.chain-link` | the horizontal "blocks" row — **this is our kill-chain and attack-chain visual** | Incident detail (§10) |
| `.section-card-head`, `.audit-summary-grid`, `.verify-banner` | section cards and the audit summary strip | Audit, Containment |
| `.empty`, `.empty-icon`, `.page-state`, `.page-error`, `.status-banner` | empty / loading / error / connection states | every page |

The stylesheet already includes all responsive breakpoints (980 / 680 / 380px) and `prefers-reduced-motion`. Do not rewrite these; they are tuned.

---

## 5. The app shell (sidebar + topbar + theme)

Copy `components/Shell.jsx` and `lib/nav.js`, then change two things: the brand, and the nav.

**`layout.js`** (verbatim shape, rename metadata):

```jsx
import './globals.css';
import Shell from '../components/Shell';
import { ThemeProvider } from 'next-themes';

export const metadata = { title: 'LXS', description: 'Deception-driven SOC dashboard powered by a honeypot network' };

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <Shell>{children}</Shell>
        </ThemeProvider>
      </body>
    </html>
  );
}
```

**`components/Shell.jsx`** — keep the structure exactly: a `.shell` grid, an `<aside class="sidebar">` with brand + grouped nav + a footer line, and a `.main` column with a sticky topbar (breadcrumb, spacer, a status chip, the live-connection pill, the theme toggle). Change:

- Brand mark letter `h` → `d`; brand label `healr` → `LXS`.
- The topbar's healr-specific `chain head <HashChip>` slot → our own small status: the per-project severity summary ("2 critical · 1 high"), or leave it empty for v1.
- The sidebar footer `{apis.length} APIs connected` → `{decoys.length} decoys · {sensorsOnline} online`.
- `<Connection conn={conn} />` stays as-is: it maps the store's connection state to a `Pill` (`live → "Live"`, `reconnecting → "Reconnecting"`, `offline → "Core offline"`). Perfect for us; rename "Core offline" → "Platform offline".

**`lib/nav.js`** — replace the healr groups with ours (same `{ group, items:[{href,label,icon}] }` shape, same lucide icons):

```js
import { LayoutDashboard, Radio, ShieldAlert, Users, Grid3x3, Boxes, Ban, ScrollText, Settings, Cpu } from 'lucide-react';
export const NAV = [
  { group: 'Monitor', items: [
    { href: '/', label: 'Overview', icon: LayoutDashboard },
    { href: '/feed', label: 'Live feed', icon: Radio },
    { href: '/incidents', label: 'Incidents', icon: ShieldAlert },
    { href: '/attackers', label: 'Attackers', icon: Users },
    { href: '/attack', label: 'ATT&CK matrix', icon: Grid3x3 },
  ] },
  { group: 'Defense', items: [
    { href: '/decoys', label: 'Decoys & containment', icon: Boxes },
    { href: '/blocklist', label: 'Blocklist', icon: Ban },
  ] },
  { group: 'Trust', items: [{ href: '/audit', label: 'Audit log', icon: ScrollText }] },
  { group: 'System', items: [
    { href: '/settings', label: 'Settings', icon: Settings },
    { href: '/system', label: 'System', icon: Cpu },
  ] },
];
```

The `active()` logic, breadcrumb derivation, and responsive collapse in `Shell.jsx` all keep working unchanged because they only read `NAV`.

---

## 6. The shared component vocabulary

These come from `components/ui.jsx` and `components/workspace.jsx`. Copy both files; most components need no change, a few get renamed props. Build every page out of these — do not write bespoke markup when one of these fits.

| Component | From | Use it for | Change needed |
|---|---|---|---|
| `PageHeader({title, purpose, actions})` | ui.jsx | top of every page | none |
| `Card({title, right, children, flush})` | ui.jsx | every panel; `flush` for tables | none |
| `StatTile({label, value, hint, tone, icon})` | ui.jsx | metric tiles (tone drives colour via `var(--${tone})`) | none — pass `tone="bad"` for critical counts, etc. |
| `Pill({tone, children, icon})` | ui.jsx | status chips | none; tones already cover severity if we pass `sev-critical` etc. (add those to the `.pill[data-tone]` CSS list) |
| `EmptyState({icon, title, children, action})` | ui.jsx | empty screens | none |
| `PageLoading`, `PageError`, `ErrorState` | ui.jsx | loading/error | reword copy ("healr core" → "platform") |
| `CodeBlock`, `Field`, `Skeleton` | ui.jsx | payload display, forms | none |
| `HashChip({hash})` | ui.jsx | copyable short hash — reuse for **honeytoken ids, file hashes, IOC values** | none |
| `Drawer({open, onClose, title})` | ui.jsx | right-side detail drawer (Base UI Sheet) | none |
| `Modal({open, onClose, title, actions, wide})` | ui.jsx | confirm dialogs (Block source, Unblock) | none |
| `Tabs({tabs, value, onChange})` | ui.jsx | the Incident-queue label tabs (Targeted/Opportunistic/Noise/Resolved) | none |
| `SectionCard({title, detail, action})` | workspace.jsx | titled section with a right-aligned action | none |
| `FilterSelect`, `TextFilter` | workspace.jsx | the filter bar on list pages | none |
| `RelativeTime`, `RouteLink`, `stamp()`, `duration()` | workspace.jsx | time + link helpers | none |
| `CallsTable` / `CallDrawer` / `RecordTable` / `RecordDrawer` | workspace.jsx | **templates** for our `IncidentsTable`/`IncidentDrawer` and `AuditTable`/`AuditDrawer` | rename + reshape fields (§9) |
| `StackedBars`, `Legend` | charts.jsx | small inline SVG bar chart | re-key to our severities (§9) |

The pattern to internalise from `workspace.jsx`: **a table + a drawer per entity.** `CallsTable` renders dense rows; clicking a row opens `CallDrawer`, a `Drawer` full of `.detail-grid`, `.detail-section`, `.reason-box`, `.timeline`, `.plain-list`, and a `<pre class="code">` dump at the bottom. Our Incident and Attacker screens are the same pattern with different fields. Study `CallDrawer` once; then you can build all our drawers.

**Status → tone mapping we reuse.** healr's `OUTCOME`/`OpChip`/`describeOp` in `lib/labels.js` is the exact pattern for our label/severity/rule vocabulary. Replace its contents (§8) but keep the shape: a frozen object mapping a code to `{tone, label, hint}`, consumed by a small `Pill`/`OutcomePill`-style component.

---

## 7. The data layer (SSE store + fetch client + hooks)

This is the part most worth copying exactly, because live updates with reconnect are fiddly and Genesis already got it right.

**`lib/core.js` → our fetch client.** Copy the `CoreError`, `raw()`, `strict()` helpers verbatim (they never throw on HTTP status, only on network failure; `strict` throws on non-2xx; `raw` is used where you want the body even on 4xx). Replace the `api = {…}` object's endpoints with ours, pointing at the platform's `/v1` API (BREAKDOWN §8.6):

```js
export const CORE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
export const PROJECT = process.env.NEXT_PUBLIC_PROJECT_ID; // dev convenience; in prod it comes from the session/route

export const api = {
  overview:   (pid) => strict(CORE, `/v1/projects/${e(pid)}/overview`),
  incidents:  (pid, q = '') => strict(CORE, `/v1/projects/${e(pid)}/incidents${q}`),
  incident:   (iid) => strict(CORE, `/v1/incidents/${e(iid)}`),
  incidentEvents: (iid) => strict(CORE, `/v1/incidents/${e(iid)}/events`),
  patchIncident: (iid, body) => strict(CORE, `/v1/incidents/${e(iid)}`, { method: 'PATCH', body }),
  action:     (iid, body) => strict(CORE, `/v1/incidents/${e(iid)}/actions`, { method: 'POST', body }),
  note:       (iid, body) => strict(CORE, `/v1/incidents/${e(iid)}/notes`, { method: 'POST', body }),
  attackers:  (pid, q = '') => strict(CORE, `/v1/projects/${e(pid)}/attackers${q}`),
  attacker:   (aid) => strict(CORE, `/v1/attackers/${e(aid)}`),
  events:     (pid, q = '') => strict(CORE, `/v1/projects/${e(pid)}/events${q}`),
  attackMatrix: (pid) => strict(CORE, `/v1/projects/${e(pid)}/attack-matrix`),
  decoys:     (pid) => strict(CORE, `/v1/projects/${e(pid)}/decoys`),
  containment:(pid) => strict(CORE, `/v1/projects/${e(pid)}/containment`),
  blocklist:  (pid) => strict(CORE, `/v1/projects/${e(pid)}/blocklist`),
  unblock:    (pid, bid) => strict(CORE, `/v1/projects/${e(pid)}/blocklist/${e(bid)}`, { method: 'DELETE' }),
  audit:      (pid, q = '') => strict(CORE, `/v1/projects/${e(pid)}/audit${q}`),
  iocsUrl:    (pid, iid, fmt) => `${CORE}/v1/projects/${e(pid)}/iocs?incident=${e(iid)}&format=${fmt}`,
  replay:     (pid, body) => strict(CORE, `/v1/projects/${e(pid)}/demo/replay`, { method: 'POST', body }),
  system:     () => strict(CORE, '/v1/system'),
};
```

Note: the dashboard talks to the platform with the **session cookie** (same-origin via a Next rewrite, or `credentials: 'include'`), never an ingest key. Add `credentials: 'include'` to the `fetch` call in `raw()`.

**`lib/sse.js` → our stream client.** Copy it verbatim. It already does: open an `EventSource` with a `?since=<cursor>`, reconnect with exponential backoff capped at 8s, resume from the last id, handle a `reset` event. Our stream (BREAKDOWN §8.8) uses named SSE events (`incident.upserted`, `event.batch`, etc.), so extend the `open()` function to also `addEventListener` for each of our event names, or have the server send them as default `message` frames with a `t` field (simplest: keep the healr pattern where every frame is a JSON object with a `type`, and the store switches on it).

**`lib/store.js` → our live store.** Copy the whole external-store pattern (`useSyncExternalStore`, the batching `flush()` every 120ms, the `REFRESH_ON` set that triggers a REST refresh, the decimal cursor helpers, the 5s poll + SSE combo). Change the shape of `s` (the state) and what `flush()` folds:

```js
const s = {
  conn: 'connecting', bootstrapped: false, error: null, lastId: '0',
  overview: null,                 // counts, ratios, sensor health
  incidents: new Map(),           // incidentId -> incident summary
  incidentOrder: [],              // newest-activity first
  events: [],                     // live feed, newest first, capped
  decoys: [],                     // health strip
};
const REFRESH_ON = new Set(['incident.ai_ready', 'action.updated', 'decoy.health', 'onboarding.updated']);
```

In `flush()`, instead of folding `callId` events into calls, upsert `incident.upserted` messages into `s.incidents` and re-sort `incidentOrder`, and unshift `event.batch` items into `s.events` (capped). Everything else — cursor bookkeeping, reconnect, publish — stays.

**`lib/hooks.js` → copy verbatim.** `useAsync(fn, deps)` and `usePolling(fn, ms, deps)` are exactly what the non-streaming pages (Attacker profile, Audit, Decoys, Settings) use. `useNow()` keeps "5s ago" labels honest.

**`lib/toast.js` → copy verbatim.** `toast(msg, kind)` over sonner.

The net result: `Overview`, `Live feed` and `Incidents` read live from `useStore()`; everything else uses `usePolling`/`useAsync` against `api`. That is precisely the split Genesis used (Overview/Traffic from the store, Audit/Metrics via polling).

---

## 8. Domain language map (healr → LXS)

Everything visual stays; only the words and the status vocabulary change. This table is the single source of truth for the rename.

### 8.1 Entities

| healr | LXS |
|---|---|
| API / tool | Decoy / sensor |
| Call (events sharing a `callId`) | Incident (events sharing an attacker, grouped into one attack chain) |
| Call event | Decoy event |
| Audit record (hash-chained heal decisions) | Audit log entry (actions: block, unblock, resolve…) |
| Patch / heal op | Detection (rule hit with points + reason) |
| Adapter version | Policy version |
| Provider (Gemini) health | LLM narrator health + sensor health |

### 8.2 The outcome vocabulary → severity + label

healr's `OUTCOME` object (7 outcomes with tone/label/hint) becomes two small vocabularies. Keep the exact shape so `Pill`/`OutcomePill` work unchanged.

```js
// lib/labels.js
export const SEVERITY = {
  critical: { tone: 'bad',      label: 'Critical', hint: 'Reached a real asset or used a honeytoken' },
  high:     { tone: 'drift',    label: 'High',     hint: 'Got in and executed; needs review within the hour' },
  medium:   { tone: 'rejected', label: 'Medium',   hint: 'Suspicious; batch review' },
  low:      { tone: 'halted',   label: 'Low',      hint: 'Low-impact decoy touch' },
};
export const LABEL = {
  targeted:      { tone: 'bad',    label: 'Targeted',      hint: 'Human-paced, cross-sensor, or reached a real asset' },
  opportunistic: { tone: 'drift',  label: 'Opportunistic', hint: 'Got in with common creds, scripted' },
  noise:         { tone: 'halted', label: 'Noise',         hint: 'Scanners and bots; auto-suppressed' },
};
export const INCIDENT_STATUS = {
  open: { tone: 'drift', label: 'Open' }, acknowledged: { tone: 'cache', label: 'Acknowledged' },
  resolved: { tone: 'ok', label: 'Resolved' }, false_positive: { tone: 'halted', label: 'False positive' },
};
```

### 8.3 Event-type labels (replaces `EVENT_LABEL`)

```js
export const EVENT_LABEL = {
  'connection.open': 'Connection opened', 'auth.attempt': 'Login attempt', 'command.exec': 'Command run',
  'http.request': 'Decoy page hit', 'file.download': 'Decoy data accessed', 'honeytoken.read': 'Honeytoken file read',
  'honeytoken.use': 'Honeytoken USED', 'asset.access': 'Real asset touched', 'asset.blocked': 'Blocked request',
  'proxy.attempt': 'Tunnelling attempt', 'prod.firewall': 'Firewall log', 'prod.auth': 'Auth log',
};
```

### 8.4 Severity colour (already set in §3)

critical → `--bad` (red) · high → `--drift` (amber) · medium → `--rejected` (blue-grey) · low/noise → `--halted` (grey). This is just the healr status scale re-labelled, so dark mode and contrast are already handled.

### 8.5 Rule → human sentence (replaces `describeOp`)

Mirror `describeOp(op)`: a `switch` that turns a detection's `rule_id` + fields into a sentence for the "Why?" panel. The backend already returns `reason` strings per detection (BREAKDOWN §7.6 / §8.5 `detections.reason`), so the simplest version just renders `detection.reason`; keep a `describeRule(id)` fallback for tooltips on the rule id chips.

---

## 9. Page-by-page build guide

Each page below names the healr page to copy, the data source, and what to render. Build them with the §6 components only.

### 9.1 Overview (`app/page.js`) — copy from healr `app/page.js`

The source Overview is a near-perfect template: a `.section-label` eyebrow + `<h1>` + right-side action in the head, a 4-up `.overview-metrics` row of `Metric`/`StatTile` tiles, then an `.overview-grid` (1.65fr / 1fr) with two panels on the left and a stack of small cards on the right.

Map it:

| healr Overview element | LXS Overview element | Source data |
|---|---|---|
| 4 metric tiles (API calls / Passed / Healed / Halts) | 4 severity tiles: **Critical**, **High**, **Noise suppressed**, **Decoys online** — pass `tone="bad"` / `"drift"` / `"halted"` / `"ok"` | `useStore().overview` |
| "Registered APIs" panel (`.resource-row` list) | "Open targeted incidents" panel — top 5 targeted incidents as rows linking to the hero | `overview.topIncidents` |
| "Recent activity" feed (`.feed` / `.event`) | "Live feed" preview — last 30 decoy events with a severity dot | `useStore().events.slice(0,30)` |
| "Service health" (`.health-row`) | "Sensor health" — one `.health-row` per decoy + one for the platform connection + one for the LLM narrator | `overview.decoys`, `conn`, `overview.llm` |
| "At a glance" counters | "At a glance" — noise-vs-targeted ratio, median time-to-acknowledge, total events today | `overview` |

The top metric row **is the "answer in 3 seconds"** that both S1 and S4 insist on. Lead with it. The eyebrow reads `DECEPTION / SOC OVERVIEW`.

### 9.2 Live feed (`app/feed/page.js`) — copy from healr `app/traffic/page.js`

healr Traffic = a `status-banner` (connection state + count) + a `SectionCard` holding a `filter-bar` + `CallsTable` + `CallDrawer`. Ours:

- Status banner: connection state + "N events loaded".
- Filters: decoy (`FilterSelect`), event type, source IP search (`TextFilter`), and a "hide simulated" toggle.
- Table: rows of `time · source IP · decoy · event type · severity chip of its incident`. Reuse the `.native-table` + `.interactive-row` pattern. Clicking a row opens the **incident** it belongs to (navigate to `/incidents/:id`), not a per-event drawer, because the incident is the useful unit.
- Reads straight from `useStore()` (live), exactly like Traffic reads from the store.

### 9.3 Incident queue (`app/incidents/page.js`) — copy `CallsTable` pattern + `Tabs`

The prioritised triage list. Use the shared `Tabs` component for the four queues: **Targeted · Opportunistic · Noise (count) · Resolved**. Under the tabs, a `.native-table`:

| Column | Content |
|---|---|
| Severity | `Pill` tone from `SEVERITY` |
| Score | `.num` 0–100 |
| Source | IP, mono |
| Kill-chain | a compact 6-dot mini-bar (filled dots = stages reached), built from `.chain` scaled down, or six `<span>` dots coloured by stage |
| ATT&CK | up to 4 `.chip` technique ids, "+N" overflow |
| AI | one-line `ai.summary` (dim, truncated) |
| Last activity | `RelativeTime` |
| Status | `Pill` from `INCIDENT_STATUS` |

Row click → `/incidents/:id`. Noise tab shows a bulk "Resolve all noise" action in the `SectionCard` head. Live-updating from `useStore().incidents`; re-sort on `incident.upserted`.

### 9.4 Attacker profile list + detail (`app/attackers/page.js`, `app/attackers/[id]/page.js`)

- **List:** `usePolling(() => api.attackers(pid), 7000)` → `.native-table` of `source IP · label · score · decoys touched · real assets touched · last seen`. Row click opens a `Drawer` (like `CallDrawer`) **or** navigates to a full page — for the hackathon a `Drawer` is enough.
- **Detail (drawer):** reuse the `CallDrawer` interior grammar: `.detail-grid` for facts (first/last seen, sessions, client banner, cadence bot/human), `.detail-section` blocks for techniques, credentials tried (masked), commands, files, and linked incidents, and a `.plain-list` for each. Add a **Block / Unblock** button (opens the `Modal` confirm from §9.6).

### 9.5 ATT&CK matrix (`app/attack/page.js`)

A grid of tactic columns × technique cells, each cell coloured by count in range (reuse `--chart-*` or a single-hue ramp of `--brand`). Build it as a plain CSS grid of small cards; clicking a cell navigates to `/incidents?technique=Txxxx`. Data from `api.attackMatrix(pid)`. This is an `E2` essential, not a thin-slice blocker — build after the hero works.

### 9.6 Decoys & containment (`app/decoys/page.js`) — copy `audit` summary + `health-row` patterns

Two parts:
- **Containment proof** (top): a `verify-banner`-style strip reading the last `selftest` — green "Containment: PASS (10/10)" or red with the failing check — plus `audit-summary-grid` tiles (network mode, read-only, caps dropped, last run time). Copy the `.verify-banner` and `.audit-summary-grid` classes.
- **Sensor list:** one `.health-row` per decoy: `health-dot is-live/is-offline/is-pending` + name + type/persona + last event + last heartbeat, with a `Pill` for status. Data from `api.decoys(pid)` + `api.containment(pid)`, live-patched by `decoy.health` stream events.

### 9.7 Blocklist (`app/blocklist/page.js`)

`.native-table`: `IP · reason · source incident · created by · expires · applied-on-sensors`. An **Unblock** button per row opens the `Modal` confirm ("Unblock 203.0.113.66 in Acme Shop?"). A manual "Add block" via `Modal` with an IP `Field`. `usePolling(() => api.blocklist(pid), 5000)`.

### 9.8 Audit log (`app/audit/page.js`) — copy healr `app/audit/page.js` almost whole

healr's Audit page is the closest match of all: filter bar + summary grid + a `RecordTable`/`RecordDrawer`. Keep the layout; change columns to `time · actor · action · target · metadata`, drop the hash-chain verify button (we are not hash-chaining actions in MVP — if time allows, keep it; the backend audit is append-only but not Merkle-chained). Export CSV reuses the blob-download pattern already in the healr audit page (`exportRecords`).

### 9.9 Settings (`app/settings/page.js`) — copy healr `app/settings/page.js`

Sections as `SectionCard`s: **Ingest keys** (list with prefix/created/last-used + "Create key" `Modal` showing the key once + revoke), **Notifications** (webhook list + test), **Allowlist** (CIDR textarea), **Retention** (number `Field`), **AI narration** (a `switch`), **Credential capture mode**. Reuse the `.settings-grid`, `.switch-field`, `.policy-switch` classes already in `globals.css`.

### 9.10 System (`app/system/page.js`, owner only) — copy healr `app/metrics/page.js`

healr's Metrics page gives us the chart + stat-tile layout for free. Show: ingest rate, job-queue depth, failed jobs (with a retry button), LLM success rate + latency, agents and versions (with "outdated" badges), stream connections. Use `StatTile` + `StackedBars` (re-keyed to events/min or ingest/min).

### 9.11 Onboarding wizard (`app/onboarding/page.js` or an Overview empty-state)

Before the first sensor connects, Overview shows an onboarding `EmptyState` → a wizard: a checklist mirroring diagram steps 0–5, each with a `CodeBlock` of the exact command and a live tick driven by `onboarding.updated` stream events, plus a **"Run simulation"** button that calls `api.replay(pid, {scenario})`. This is the same "guided empty state" healr uses, scaled up.

---

## 10. The hero: Incident detail screen (`app/incidents/[id]/page.js`)

This is the one screen judges remember, and it has **no direct healr equivalent** — it is new, but built entirely from existing parts. It is the PS use case on one screen (BREAKDOWN §6.4). Layout top to bottom:

**Header strip.** `severity Pill` + score + `label Pill` + source IP + first/last seen. Reuse the `.detail-title` flex row.

**Kill-chain bar.** Six stages (Recon → Initial Access → Execution → Discovery → Collection → Exfiltration) rendered with the **`.chain` + `.chain-segment` + `.chain-block` + `.chain-link`** classes already in `globals.css` (healr uses them for the heal chain on tool pages). Each stage block is lit if reached. Below it, two badges — **"REAL ASSET REACHED: Payments API"** and **"HONEYTOKEN USED"** — as `Pill tone="bad"`, shown only when true. Under that, a row of ATT&CK `.chip` ids with `title` tooltips.

**Two-column body** (`.detail-grid`-style split, or a simple CSS `grid-template-columns: 1fr 1fr`):
- **Left — Timeline.** A `.timeline` list, one `<li>` per key event: time · source · short description (from `EVENT_LABEL`). The event that triggered the critical floor is marked with a red dot (`--dot: var(--bad)` via the `.timeline li::before` variable).
- **Right — "Why critical?".** A `.plain-list` or a small table of `detection.reason` lines with their points, exactly like healr's "Why healr stopped" `reason-box` but additive: `+5 touched a decoy · +25 default credentials worked · +40 targeted source reached a real asset → CRITICAL`. Each line links to its evidence event(s).

**AI summary band.** A `reason-box`-styled block (reuse `.reason-box`): the labelled AI summary ("AI-generated" or a "Template" `Pill` on fallback), then the action buttons as a row: **Block source · 24 h** (opens `Modal` confirm) · **Export IOCs ▾** (dropdown → JSON/CSV/STIX, downloads via the blob pattern) · **Acknowledge** · **Resolve ▾** · **Mark false positive**. Clicking Block calls `api.action(iid, {type:'block_ip', params:{ip, duration_hours:24}})`; on success, toast "Block applied — attacker's next request will be refused" and the action flips to "Applied" when the stream reports it.

Data: `api.incident(iid)` for the shell + `api.incidentEvents(iid)` for the timeline; subscribe to `useStore()` for `incident.ai_ready` / `action.updated` patches to this incident.

ASCII reference (same as BREAKDOWN §6.4) — build it to look like this:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ INCIDENT #7  ● CRITICAL 100   TARGETED   203.0.113.66   first 10:41 · last 10:43│
│ Recon ━ Initial Access ━ Execution ━ Discovery ━ Collection ━ Exfiltration      │
│   ✔          ✔              ✔           ✔            ✔            ·             │
│ [REAL ASSET REACHED: Payments API]  [HONEYTOKEN USED: acme_live_…3f]           │
│ T1595.003  T1110.001  T1078.001  T1059.004  T1083  T1005  T1552.001            │
├──────────────────────────────────┬─────────────────────────────────────────────┤
│ Timeline                         │ Why critical?                               │
│ 10:41:02 web  GET /admin, /.env  │ +5  touched a decoy (R01)                   │
│ 10:41:52 ssh  admin / ***** ✔    │ +25 default credentials worked (R06)        │
│ 10:42:17 ssh  $ cat customer_…   │ +10 decoy data accessed (R11)               │
│ 10:43:10 app  GET /api/payments  │ +40 targeted source reached a real asset →  │
│                                  │     CRITICAL (R15)                          │
├──────────────────────────────────┴─────────────────────────────────────────────┤
│ AI summary — A human-paced attacker logged into a decoy backup server with…    │
│ [ Block source · 24h ]  [ Export IOCs ▾ ]  [ Acknowledge ]  [ Resolve ▾ ]      │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

## 11. Folder structure

Mirror `api-client/` exactly:

```
dashboard/
├── package.json  jsconfig.json  next.config.js  postcss.config.mjs  components.json
├── app/
│   ├── globals.css              # §3 tokens + §4 utilities (copied) + our 4 severity vars
│   ├── layout.js                # §5
│   ├── page.js                  # Overview (§9.1)
│   ├── feed/page.js             # Live feed (§9.2)
│   ├── incidents/page.js        # Queue (§9.3)
│   ├── incidents/[id]/page.js   # Hero (§10)
│   ├── attackers/page.js        # (§9.4)
│   ├── attack/page.js           # ATT&CK matrix (§9.5)
│   ├── decoys/page.js           # Decoys & containment (§9.6)
│   ├── blocklist/page.js        # (§9.7)
│   ├── audit/page.js            # (§9.8)
│   ├── settings/page.js         # (§9.9)
│   └── system/page.js           # (§9.10)
├── components/
│   ├── Shell.jsx                # §5 (copied + rebranded)
│   ├── ui.jsx                   # §6 (copied, copy reworded)
│   ├── workspace.jsx            # §6 (IncidentsTable/Drawer, AuditTable/Drawer)
│   ├── charts.jsx               # §6 (re-keyed)
│   ├── killchain.jsx            # NEW — the 6-stage bar used by queue + hero
│   └── ui/                      # the whole shadcn/Base-UI primitive folder, copied unchanged
└── lib/
    ├── core.js                  # §7 fetch client (our endpoints)
    ├── sse.js                   # §7 (copied verbatim)
    ├── store.js                 # §7 (reshaped state)
    ├── hooks.js                 # §7 (copied verbatim)
    ├── labels.js                # §8 (our SEVERITY/LABEL/EVENT_LABEL/describeRule)
    ├── nav.js                   # §5 (our nav)
    ├── toast.js                 # §7 (copied verbatim)
    └── utils.js                 # `export { cn } from "cn"` (copied verbatim)
```

---

## 12. Relationship to BREAKDOWN.md, and the drift from the PDF

**Versus BREAKDOWN §4 (stack).** BREAKDOWN recommends `React + Vite` for the dashboard. **This guide overrides that to Next.js (App Router, JS)** for the dashboard app only, because we are copying a finished Next.js implementation. The platform API, SDK, agent and decoys are unaffected. Net cost of the override: none — the dashboard is a static SPA either way, Next just happens to be the framework our reference is written in. If the team would rather stay on Vite, every token, class and component here ports directly (they are plain CSS + plain React); only the file-based routing and `next-themes` wiring change. Pick one and move on; do not spend hackathon hours porting.

**Versus BREAKDOWN §6 (dashboard spec).** This guide *implements* §6. The screen list, the "first screen is the answer", the label-tabs, the "Why?" panel, the hero wireframe — all identical. Where they appear to differ, BREAKDOWN is the spec and this is the build recipe.

**The PDF drift (LXS_End_to_End_Report).** The uploaded PDF (an earlier analysis) specifies the UI as `React + Vite + Tailwind, xterm.js replay, Leaflet map`, a dark SOC theme, and a hero attack-chain screen. Reasoned reconciliation:
- *React + Tailwind + dark SOC theme + hero screen* — **kept**, that is exactly what this is. The theme supports light and dark via `next-themes`; default to dark for the demo (`defaultTheme="dark"` if you prefer, though the source ships `system`).
- *Vite → Next* — **changed**, for the copy-the-reference reason above.
- *xterm.js session replay* — **deferred to Advanced (BREAKDOWN A4).** It needs Cowrie ttylogs → asciicast wiring that is not on the MVP critical path. If P4 has spare time after the hero and queue work, it is a high-impact "wow" add; until then, the timeline in the hero screen carries the "watch the attacker" story.
- *Leaflet geo map* — **cut**, consistent with both S1 and S4 cut lists (keep the text country label from enrichment if it lands). A map on simulated lab IPs adds little and costs layout time.

Everything else the PDF says about the dashboard (Overview counts, incident hero, ATT&CK heatmap, containment panel, audit, "Run simulation" empty state, one-click actions, tooltips on ATT&CK ids) is reflected above.

---

## 13. Build order and definition of done

Mirror the healr build order (shell first, then live feed, then the hero), so you always have something on screen.

| Step | Deliver | Done when |
|---|---|---|
| F0 | Copy tokens, `globals.css`, `components/ui/`, shell, data layer; rebrand | App boots, dark/light toggle works, sidebar + topbar render, connection pill shows "Platform offline" until the API is up |
| F1 | Live feed wired to the real SSE stream | `curl`-ing a decoy makes a row appear on `/feed` in < 1 s (the thin-slice exit test) |
| F2 | Incident queue with label tabs + severity pills | A simulated attack shows up as an incident, correctly labelled and coloured |
| F3 | **Incident hero** (§10) | The PS scenario shows the kill-chain lighting up, "Why critical?" factors, and the two badges; **Block source** button calls the action API and toasts success |
| F4 | Overview (counts + feed + sensor health) | Top bar reads "N critical · N high · N noise suppressed" and updates live |
| F5 | Attackers, Decoys & containment, Blocklist, Audit, Settings | Each renders real data via polling; containment panel shows the `selftest` result |
| F6 | ATT&CK matrix, System, onboarding wizard, polish | Empty states, tooltips on every ATT&CK id, "Run simulation" button |

A screen is "done" when it is built only from §6 components, uses only §3 tokens (no hard-coded hex), renders a sensible empty/loading/error state, and reads from the §7 data layer. If you wrote a raw `<div style={{color:'#...'}}>`, you skipped a token — fix it.

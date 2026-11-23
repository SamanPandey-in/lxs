# LXS Dashboard — UI/UX Review & Fix Strategy

Reviewed 2026-11-22 in Chrome (1366×543 viewport, plus 390 px mobile frames), light and dark theme,
against the full local stack (`pnpm demo`: Postgres, API, agent, decoys, attacker console) with real seeded incidents.

> The target design system this plan moves toward lives in [`agents/ui/`](../../../agents/ui/README.md)
> (tokens, components, layout templates, patterns, accessibility, agent workflow). §7 maps each fix to
> the industry guideline behind it. Full source list: [`agents/ui/references.md`](../../../agents/ui/references.md).

**Baseline audit** (`agents/ui/tools/ui-audit.js` on `/incidents`, 1366 px, light): **FAIL 7/10**.
10 font sizes (9.5 to 26 px), 9 weights (400 to 750), 30 text nodes under 12 px, control heights 26/28/30/32,
links with 17–21 px hit areas. Target: PASS on every page.

---

## 0. Setup problems hit on the way (fix these too)

| # | Problem | Fix |
|---|---|---|
| S1 ✅ fixed | `pnpm demo` fails with `could not log in as demo@lxs.dev (HTTP 401)` when the Postgres volume predates the `demo-analyst` username. `seed.ts` only inserts the user if missing, so the old username (`user-0389ffde`) survives, while `demo.mjs` logs in by username. | Make `demo.mjs` log in with `DEMO_EMAIL` (always unique), or have the seed upsert `username`. Workaround used: `LXS_DEMO_USERNAME=demo@lxs.dev pnpm demo`. |
| S2 ✅ fixed | On Windows, first `pnpm demo` fails at `'lxs' is not recognized` — the `lxs` bin in `examples/acme-shop` is not linked because `sdk/lxs/dist` didn't exist at install time. | In `demo.mjs`, run `pnpm install --offline` after the build step (or invoke `node ../../sdk/lxs/dist/cli.js` directly). |
| S3 | Dashboard with no API shows only a bare line "Could not verify your session…" even though `LXS_ALLOW_MOCK=1` exists — mock mode never gets past the session gate. | Let the session gate fall through to mock mode when `allowMock` is on, or document it. |

---

## 1. Root causes (why it looks "off" everywhere)

1. **No type scale.** CSS uses **21 distinct px font sizes** (9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 15, 16, 17, 18, 21, 23, 25, 26, 30, 38) plus clamp(38–68 px) on the landing page. A single page (`/incidents`) renders **10 sizes**. Body base is **13 px**; **30 text elements on /incidents are under 12 px** (ATT&CK chips 9.5 px, nav group labels 10 px).
2. **No weight scale.** **19 distinct font weights** (400, 500, 540, 550, 560, 570, 580, 600, 620, 650, 700, 720, 750…). Values like 540/570/620 snap to the nearest real weight anyway, so hierarchy is accidental.
3. **The font is never loaded.** `--font-sans: Inter, …` but there is no `next/font` or stylesheet. Users without Inter installed get Segoe UI/system — different metrics, different look per machine. Mono is `SFMono-Regular, Consolas` — Consolas on Windows, which renders noticeably smaller than the sans.
4. **Three competing component systems.** `globals.css` (copied wholesale from another project "Genesis"), `lxs.css` (1,832 lines, 42 `ds-*` classes, 11 media queries layered on top), and shadcn/Base UI in `components/ui/`. Usage: **39 `.btn` class buttons + 34 raw `<button>` vs 9 shadcn `<Button>`**; **5 raw `<select>` vs 0 shadcn `<Select>`**; **2 raw `<table>` vs 10 shadcn `<Table>`**; **155 inline `style={{}}`**. Result: 3 button heights (26/28/30 px) on one page, inconsistent radii, paddings and focus rings.
5. **Layout patches instead of a layout system.** `globals.css` contains dozens of `min-width:0` / `overflow-wrap:anywhere` override rules targeting `[data-slot]` — symptoms of grids that were never designed for their content.

---

## 2. Global / shell issues

| # | Issue | Where | Severity |
|---|---|---|---|
| G1 | Body text 13 px, meta text 10–11 px — too small for a dashboard people stare at for hours. | everywhere | High |
| G2 | Sidebar is `position:sticky; height:100vh` with no own scroll. On a 543 px-tall viewport its content is 682 px: bottom items (Settings, System, Onboarding, footer) are clipped and the white sidebar background ends mid-screen when the page scrolls. | `.sidebar` | High |
| G3 | Severity counts shown twice: topbar ("6 critical 0 high 0 noise suppressed") and Overview header ("6 critical │ 0 high │ 0 noise…"). | topbar + `/dashboard` | Med |
| G4 | Count mismatch confuses: sidebar badge "Incidents 6", tabs "Targeted 1 · Opportunistic 7 · Noise 1". Nothing explains what 6 counts. | sidebar vs `/incidents` | Med |
| G5 | Full-page blank "Checking your session…" on every hard navigation (3 s+). No shell, no skeleton. | `Shell.jsx` | High |
| G6 | Decorative eyebrow on every page ("— MONITOR / TRIAGE", "— SYSTEM / OWNER") duplicates the breadcrumb in the topbar and the sidebar group. Adds noise, pushes content down. | `PageHeader` | Low |
| G7 | Page titles 23 px/620 vs card titles 12–13 px/600: titles too far apart from the content scale, card titles barely distinguishable from body. | all | Med |
| G8 | Card headers: title 12 px + subtitle 10–11 px + 16 px padding + border → big empty band above every table; filters sit in a separate grey band below. Three stacked bands before data. | Feed, Attackers, Audit, Blocklist | Med |
| G9 | Search inputs: the search icon overlaps the placeholder text ("Filter…" renders as "⌕lter…"). | `/incidents`, `/feed`, `/attackers`, `/audit` | High (looks broken) |
| G10 | Native `<select>` elements next to styled inputs — different height, arrow and radius than every other control. | Feed, Attackers, Audit, ATT&CK | Med |
| G11 | Pill/badge overload: severity, label, status, reason, decoy type, cadence and tech IDs all use near-identical bordered pills, so nothing stands out. | Incidents, detail, Attackers | Med |

## 3. Page-by-page issues

### Landing `/` & Auth `/login`, `/signup`
- L1 Hero is indented to x≈296 while logo/nav sit at x≈136 — two left edges.
- L2 Hero headline 68 px next to 10 px footer text and 12 px nav link — extreme jump in scale.
- L3 Login card: "← Back to home" and the "WELCOME BACK" eyebrow render on the same line, glued together ("Back to homeWELCOME BACK").
- L4 Field labels 11 px, error/help text 11 px, inputs 39 px tall while app inputs are 32 px.

### Overview `/dashboard`
- O1 Critical hero card is ~1050 px wide with text in the left 460 px; the rest is empty gradient.
- O2 "3 more need attention" rows: title on the left, kill-chain bars pinned to the far right (~450 px gap) — eye can't connect them.
- O3 Header stat row (6 critical │ 0 high │ …) leaves a dangling "│" separator when it wraps (visible at mobile width).
- O4 "5 routine incidents" collapsed row mixes a large number with small grey text, reads like a footnote.

### Incident queue `/incidents`
- I1 Tabs are stretched evenly across the full card width (Targeted at x 360, Resolved at x 1130) — they read as unrelated labels, not a tab bar.
- I2 Incident cell: 9.5 px mono IP followed by pills that wrap to a second line; row height jumps per row.
- I3 ATT&CK column shows 4 chips + "+8" at 9.5 px — unreadable and wraps.
- I4 Severity uses a solid red badge, Status uses an outlined beige pill, Label uses an outlined red pill — three badge styles in one row.
- I5 Only 1 incident in the default tab while 6 are critical — the default tab hides most of the work.

### Incident detail `/incidents/[id]`
- D1 The sticky action bar (Block source / Export / Acknowledge / Resolve) overlaps the headers of the two cards below it while scrolling — card titles are hidden behind it.
- D2 Timeline: every one-line value (`ssh:22`, `GET /admin → 200`) sits in its own full-width grey code box; page is ~2,960 px tall. One event row contains a horizontal scrollbar.
- D3 Two columns (Timeline / Score ledger) have very different heights → large empty area under the timeline.
- D4 AI summary — the most useful thing for an analyst — is at the very bottom, below ~2,500 px.
- D5 Kill-chain: 6 cards each with ✓ + "Reached" repeated — the colour already says it.
- D6 "REAL ASSET REACHED" / "HONEYTOKEN USED" are uppercase outlined boxes that look like buttons but aren't clickable.
- D7 Score "100/100" at 38 px is the largest text on the page, larger than the incident title.
- D8 Status pills ("Critical", "Targeted", "Open") wrap under the eyebrow on narrower widths.

### Live feed `/feed`
- F1 Filter labels ("Decoy", "Event type") at ~9.5 px above controls.
- F2 Table columns: Incident column pinned far right, large dead space in the middle; Detail column truncates commands without tooltip.
- F3 Streaming banner (green full-width box) takes a whole row for one status line — should be a small indicator in the card header.

### Attackers `/attackers`
- A1 Numeric columns (Events, Sessions) are not right-aligned or tabular; headers right-ish, values left-ish.
- A2 "Opportunistic" label and "bot" cadence pills use the same amber style — different meanings, same look.
- A3 "Real assets: none" in faint grey vs values elsewhere — inconsistent empty-value convention (none / — / 0).

### ATT&CK matrix `/attack`
- M1 Tactic columns are not in MITRE kill-chain order (Discovery before Credential Access and Execution last).
- M2 "CREDENTIAL ACCESS" header wraps to two lines → header row heights differ, cells misalign.
- M3 Cell text (technique ID + name) is 10–11 px and wraps into 3 lines in narrow columns.
- M4 Legend gradient "fewer hits → more hits" floats in the header with no numbers.

### Decoys `/decoys`
- C1 Amber "Containment: NOT RUN" banner shows above an empty state "No decoys registered" — warning + empty state both say the same thing.
- C2 Empty state instruction text with inline code is cut off/low contrast.

### Blocklist `/blocklist`
- B1 Two identical "Add block" CTAs (header + empty state) — fine for empty, but the header one should be secondary when the empty state is shown.

### Audit `/audit`
- U1 KPI tiles colour their zeros: "0 Blocks" is red, "0 Entries" teal — zero should be neutral; red reads as an alarm.
- U2 KPI tiles have a left accent border that the System page tiles also use but Overview doesn't — inconsistent stat-tile component.

### Settings `/settings`
- T1 Ingest-key table squeezed into half width: name wraps ("dev-ingest-key / (seed)"), prefix truncated ("ds_dev_00000.."), dates wrap to two lines; "scope: ingest" at ~9 px.
- T2 "Saved" disabled button is pale teal with white text — fails contrast, looks like a broken primary button.
- T3 Two cards side by side with unequal heights.

### System `/system`
- Y1 "LLM success 0%" shown in teal while the LLM is "not configured" — misleading metric; should be "—" / "Not configured".
- Y2 "Ingest volume, last 24 h" chart renders an empty dashed plot with no empty-state message.
- Y3 "v0.1.0" and "up 0d 0h" as pills in the header action slot — status metadata styled like buttons.

### Onboarding `/onboarding`
- N1 "Step 3 of 6 is next" next to "4 of 6 complete" — contradictory progress.
- N2 Each completed step shows a "Done" badge **and** "Done" as its description.
- N3 Checklist rows ~86 px tall with lots of padding for one line of content.

## 4. Responsive (390 px)
- R1 Sidebar becomes a horizontally scrolling strip with a visible scrollbar; plus topbar = ~110 px of permanent chrome out of ~520 px.
- R2 `/incidents` shows **three nested horizontal scrollbars** (nav, tabs, table).
- R3 Table cells clip pills ("Rea…") instead of stacking to a card list.
- R4 Kill-chain stage cards on the detail page shrink to unreadable widths instead of becoming a vertical stepper.

## 5. Theme
- H1 `defaultTheme="dark"` but `enableSystem` makes it light on most machines; the first visit is inconsistent with the intended SOC look.
- H2 Dark mode is generally fine, but tinted pill backgrounds (e.g. Critical salmon) are much brighter than surrounding surfaces and dominate the page.

---

## 6. Fix strategy

Do it in this order — each phase removes a root cause, so later page fixes stay small.

### Phase 1 — Foundations (1 day)
1. **Load fonts properly** in `app/layout.js` with `next/font/google`: `Inter` (or `Geist`) for sans, `JetBrains Mono` / `Geist Mono` for mono. Expose as CSS vars, set `--font-sans`/`--font-mono` from them. Same font on every machine.
2. **Define a type scale as tokens** (in `@theme`), and nothing else is allowed:

   | token | size / line-height | use |
   |---|---|---|
   | `text-xs` | 12 / 16 | meta, table headers, chips (minimum size anywhere) |
   | `text-sm` | 13 / 20 | table cells, secondary text |
   | `text-base` | 14 / 22 | body, inputs, buttons (new body default) |
   | `text-lg` | 16 / 24 | card titles |
   | `text-xl` | 20 / 28 | section headings, KPI values |
   | `text-2xl` | 24 / 32 | page titles |
   | `text-3xl` | 30 / 36 | landing hero only (cap the 68 px clamp at ~48 px) |

3. **Weights: 400, 500, 600 only.** Replace every 540/550/560/570/580/620/650/700/720/750.
4. **Spacing & sizing tokens**: 4-pt scale; control heights 28 (sm) / 32 (default) / 36 (lg); table rows 36 / 44 / 52; one radius (`--radius: 8px`) with sm/md derived. Full spec: [`agents/ui/tokens.md`](../../../agents/ui/tokens.md).
5. Add a lint guard: a Biome/stylelint rule or a CI grep that fails on `font-size:` px literals and `text-[NNpx]` outside the token file.

### Phase 2 — One component system (2–3 days)
Pick **shadcn/Base UI** (already installed) as the only system and migrate to it:
- `Button` (variants: default, secondary, outline, ghost, destructive; sizes sm/default/lg) → replace 39 `.btn` + 34 raw `<button>`.
- `Select` → replace the 5 native `<select>`.
- `Input` with a proper leading-icon slot (`pl-8` + absolutely positioned icon) → fixes G9 everywhere at once.
- `Table` → replace the 2 raw tables; add `numeric` cell variant (right aligned, `tabular-nums`).
- `Badge` with semantic variants only: `severity` (solid, 4 levels), `status` (dot + text, no border), `tag` (subtle, for label/decoy/cadence). Tech IDs become plain mono text links, not boxes.
- `StatTile` single component (label, value, hint, optional trend) — zero values neutral.
- `Tabs` (`TabsList` hugging content, not stretched) → fixes I1.
- `PageHeader` (title + description + actions; drop the eyebrow, rely on breadcrumb) and `Card` with compact header (title 16/600, subtitle 13, toolbar slot on the same row as the title).
- `EmptyState`, `Skeleton` usage for every list.
Then **delete** the Genesis `globals.css` leftovers (`.pill`, `.chip`, `.btn`, `.resource-row`, `.provider`, the `[data-slot]` min-width patches) and shrink `lxs.css` to page-specific layout only. Target: no inline `style={{}}` except dynamic values (colours from data, widths).

### Phase 3 — Shell & layout (1 day)
- Sidebar: `height:100dvh; overflow-y:auto` for the nav list, footer pinned; collapsible to icon rail ≥ 980 px; **below 768 px use a `Sheet` drawer** behind a hamburger instead of the scrolling strip (R1, R2).
- One topbar: breadcrumb left, global status (Live dot + critical count) right; remove the duplicated counts from page headers (G3).
- Render the shell immediately and put the session check inside it with skeletons (G5).
- Page grid: `max-width: 1280px`, 24 px gutters, 12-col grid; two-column pages use `align-items:start` and stack < 1100 px.
- Sticky action bar on incident detail: give it `top: var(--topbar-h)` and `scroll-margin` on the following content, or move actions into the incident header and make only the header sticky (D1).

### Phase 4 — Page fixes (2–3 days), highest value first
1. **Incident detail**: order = header (title, severity, score inline at `text-xl`) → AI summary → kill chain (compact horizontal stepper, vertical on mobile, no "Reached" text) → two tabs **Timeline | Score ledger** instead of two uneven columns. Timeline rows: one line each (`time · source · title · value in mono`), no code boxes; command lists in a single collapsible block.
2. **Incident queue**: tabs hug content; row = severity badge, title (14/500) + one meta line (IP mono 12, label tag), kill-chain mini bar, up to 3 tech IDs as text + "+N", last activity, status; whole row is a link (`<Link>`, not `onclick`) for middle-click / keyboard.
3. **Overview**: KPI row via `StatTile`; critical hero sized to content (max ~720 px text, actions inline); "needs attention" list puts kill-chain right after the title.
4. **Feed / Attackers / Audit**: filters in the card header toolbar row; numeric columns right-aligned; consistent empty value "—"; streaming state as a small dot in the header.
5. **ATT&CK**: fixed tactic order (Recon → Resource Dev → Initial Access → Execution → Persistence → … → Exfiltration → Impact), header row with `min-height` and single-line truncation + tooltip, cell = ID (12 mono) + name (13), numeric legend.
6. **Settings / System / Onboarding / Decoys**: full-width keys table; disabled buttons via the `Button` disabled state; "Not configured" instead of 0%; chart empty state; onboarding progress single source of truth; drop duplicate "Done".
7. **Landing & auth**: single container left edge; hero ≤ 48 px; back link on its own line above the eyebrow; inputs use shared `Input`.

### Phase 5 — Responsive, theme & QA (1 day)
- Tables → stacked card rows below 768 px (`<Table>` with a `mobile="cards"` variant).
- Decide theme: ship dark as default without `enableSystem` (or keep system but test both equally); tone down tinted badge backgrounds in dark (≤ 15 % alpha).
- Accessibility: all text ≥ 12 px, contrast ≥ 4.5:1 for body/meta, visible focus rings on every control (shadcn `ring` token), `aria-current` on tabs.
- Visual regression: Playwright screenshots of the 12 routes at 1440, 1024 and 390 widths, light + dark, run in CI so drift is caught.

### Definition of done
- ≤ 7 font sizes and 3 weights in computed styles on any page (re-run the audit script used in this review).
- No text < 12 px; no `font-size` px literals outside tokens.
- One button / input / select / badge implementation; `grep -r 'className="btn'` returns nothing.
- No horizontal scroll at 390 px except inside intentionally scrollable code blocks.
- Sidebar fully usable at 1366×600.

---

## 7. Why these fixes: industry guidelines behind each one

| Fix | Guideline it follows | Source |
|---|---|---|
| 7-step type scale, nothing < 12 px, body 14 px | Named type roles, not ad-hoc sizes (body 16/14/12, label 14/12/11). macOS text minimum 10 pt, default 13 pt. Body text ≥ 14 px. Use only type presets | [Material 3 typography](https://m3.material.io/styles/typography/overview), [Apple HIG typography](https://developer.apple.com/design/human-interface-guidelines/typography), [Meta Horizon typography](https://developers.meta.com/horizon/design/styles_typography/), [Primer typography](https://primer.style/foundations/typography) |
| 3 weights only; heavier for small text | Heavier weights are more legible, and lighter weights need larger sizes. Hierarchy comes from weight + size + colour combined | [Meta Horizon typography](https://developers.meta.com/horizon/design/styles_typography/), [Polaris using type](https://polaris.shopify.com/design/typography/using-type) |
| Fixed (non-fluid) sizes in product UI | Productive type set for dense product screens | [Carbon type sets](https://carbondesignsystem.com/elements/typography/type-sets/) |
| Load fonts explicitly | System font is only the fallback. Load the brand face | [Fluent 2 typography](https://fluent2.microsoft.design/typography), [next/font](https://nextjs.org/docs/app/getting-started/fonts) |
| 4 px spacing scale, densities | 4 px base with comfortable/compact modes. Limited spacing token scale | [Cloudscape content density](https://cloudscape.design/foundation/visual-foundation/content-density/), [Atlassian spacing](https://atlassian.design/foundations/spacing) |
| Table rows/headers, table gets max width | Explicit row heights, header matches row size, table gets most width | [Carbon data table](https://carbondesignsystem.com/components/data-table/usage/), [Cloudscape table view](https://cloudscape.design/patterns/resource-management/view/table-view) |
| List → detail page instead of nested/uneven panels | Use a details page as the hub for complex data | [Cloudscape nested resources](https://cloudscape.design/patterns/resource-management/view/table-with-nested-resources/) |
| Quiet sidebar, hugging tabs, fewer borders | "Don't compete for attention you haven't earned". "Structure should be felt, not seen". Compact tabs, dimmed sidebar | [Linear design refresh](https://linear.app/now/behind-the-latest-design-refresh) |
| Chrome recedes, content leads | Controls form a separate layer that defers to content (take the principle, not the glass) | [Apple Liquid Glass](https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/) |
| Search icon slot, real links for rows, URL state, loading buttons, empty/error states, tabular numbers, no `transition: all` | Web Interface Guidelines (MUST/SHOULD rules written for agents) | [Vercel guidelines](https://vercel.com/design/guidelines), [AGENTS.md](https://github.com/vercel-labs/web-interface-guidelines) |
| Contrast, 24 px targets, focus not obscured by sticky bar | WCAG 2.2 AA: 1.4.3, 1.4.11, 2.5.8, 2.4.11 | [WCAG 2.2 new](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/), [Target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum) |
| 44 px touch targets on mobile | Minimum 44×44 pt touch targets | [Apple HIG accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility) |
| Neutral zeros, severity-only colours, OKLCH palette | Perceptually uniform colour scales give predictable contrast | [Stripe accessible colour systems](https://stripe.com/blog/accessible-color-systems) |
| Shell first + skeletons, honest "Not configured", live status | Visibility of system status. Error prevention. Minimalist design | [NN/g 10 heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/), [NN/g complex apps](https://www.nngroup.com/articles/usability-heuristics-complex-applications/) |
| AI summary + "why critical" at top, noise shown as handled | Alerts must say what happened, why it matters and what to do next. Reduce alert fatigue | [Splunk human-centered SOC](https://www.splunk.com/en_us/blog/ciso-circle/human-centered-soc-design), [Rapid7 alert fatigue](https://www.rapid7.com/fundamentals/alert-fatigue-cybersecurity/) |

Ongoing UI work with agents: follow [`agents/ui/agent-workflow.md`](../../../agents/ui/agent-workflow.md)
and use the prompts in [`agents/ui/prompts.md`](../../../agents/ui/prompts.md).

---

## 8. Implementation status (2026-11-23, branch `ui/design-system`)

Audit after the redesign (`ui-audit` checks at 1366 px, dark):

| Page | Font sizes | Weights | Text < 12 px | h1 | Horizontal overflow |
|---|---|---|---|---|---|
| `/incidents` (before) | 10 | 9 | 30 | 1 | table scrolled |
| `/dashboard` | 6 | 3 | 0 | 1 | none |
| `/incidents` | 5 | 3 | 0 | 1 | none |
| `/incidents/[id]` | 6 | 3 | 0 | 1 | none |
| `/feed` | 5 | 3 | 0 | 1 | none |

- Legacy CSS went from 2,078 lines (globals.css + lxs.css) to 256, all inside `@layer components`. About 330 dead selectors were removed.
- Done: S1, S2, G1–G11, L1–L4, O1–O4, I1–I5, D1–D8, F1–F3, A1–A3, M1–M4, C1–C2, B1, U1–U2, T1–T3, Y1–Y3, N1–N3, R1–R4.
- Incident detail page: 2,958 px → 1,722 px tall.

**Still open:**
- URL state for the `/feed`, `/attackers` and `/audit` filters (needs `useSearchParams` + Suspense).
- The `/attack` time-range select is ignored by `api.attackMatrix`.
- On mobile, the tabs row scrolls horizontally inside its own strip.
- The incident back link doesn't keep the list's filters.
- Settings "Save changes" and the webhook actions are client-only (no settings-update API).
- Timeline grouping only covers repeated failed logins.
- Visual regression screenshots (Playwright) are not set up yet.
- The H1 decision (dark default vs system theme) is still pending.

---

## 9. Contrast revision (2026-11-23)

**Symptom (user report):** "no evident contrast… the eyes stress a lot to find the things that actually matter."

**Diagnosis (measured):** text was fine (body 16:1, secondary 5–7:1). The failure was *separation*. Everything sat on one flat plane:

| Pair | Light | Dark |
|---|---|---|
| Card vs page | 1.06 | 1.07 |
| Border vs card | 1.27 | 1.36 |
| Sidebar vs page | 1.05 | 1.05 |
| Faint text vs card | **3.16 (fails AA)** | 4.39 |
| Input border vs card | ~1.4 | ~1.6 (fails WCAG 1.4.11) |

**Fix:**
- A surface ladder: chrome → panel → card → popover. Cards ≥ 1.19 against the chrome. Borders ≥ 1.45. Inputs ≥ 3:1.
- Three text tiers, all ≥ 4.5:1.
- Saturated severity colours (every solid badge ≥ 5.7:1).
- The lead incident carries its severity on the surface (4 px edge + 4 % tint + severity-coloured kill-chain checks).
- Table headers sit on a muted band. Sidebar section labels moved to the faint tier.

Every pair was computed before shipping; values and rules are in `agents/ui/tokens.md` §9 ("Surface and contrast ladder").

## 10. 2026 visual refresh (2026-11-23)

**Symptom (user report):** "the dashboard looks like it is 2020."

**What read as dated:** blue-grey neutrals, flat equal-weight cards on a flat page, uppercase sidebar labels, underline tabs, a default system-feeling font, KPI tiles that were just numbers, no keyboard command surface.

**Direction:** the current generation of well-reviewed product UIs (Linear's 2026 refresh, Vercel's Geist system, Raycast, Notion Calendar, Apple's 2025 "controls as a layer above content"). The spec is `agents/ui/visual-language.md`:
- **Layering:** the sidebar and window share one chrome colour; content lives in a raised, rounded panel; cards float on the panel.
- **Neutrals and type:** zinc neutrals (re-measured against the contrast ladder above). Geist + Geist Mono. Tight-tracked headings. Sentence-case section labels.
- **Shape and controls:** 10 px radius with 14 px on cards and the panel. Layered ambient + direct shadows. Segmented-control tabs. Buttons with a subtle inset highlight and press state.
- **Data:** KPI tiles with 24 h sparklines and delta chips. Pulsing live dots. Shimmer skeletons.
- **⌘K command palette:** pages, open incidents by #id/IP/title, quick actions. A topbar trigger "Search or jump to… ⌘K".

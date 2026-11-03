# Dashboard UI iteration log

Branch: `ui`. Backlog: `IMPR.md` (brutal UI/UX review). Each module runs the loop:

1. **Analyze** the live UI (dev server + mock data) and the code.
2. **Plan** the change.
3. **Judge the plan** — is it the right fix, in scope, low-risk?
4. **Code** it.
5. **Test** — reload, screenshot, console/network check, `npm test`; confirm nothing
   existing broke.
6. **Judge the result** — did the developer/analyst experience actually improve?
   If not, feed back to step 2 and iterate.
7. **Commit** when satisfied.

Test harness (local only, never committed): the dashboard runs standalone against a
scratchpad mock backend (`mock-api.mjs`) that serves `lib/mock.js` on the real `/v1`
routes, with `apps/dashboard/.env.local` pointing `LXS_API_URL` at it. This mirrors the
platform API (clean 200s, no demo banner) so the UI can be judged exactly as shipped.

---

## Module 0 — `useAsync` never loads under StrictMode (foundational)

**Analyze.** Every `useAsync`-driven page (attackers, blocklist, audit, decoys, feed,
incident detail, settings, system) rendered skeletons forever, even though the network
requests returned `200` with data. Store-driven Overview worked. `reactStrictMode: true`.

**Root cause.** `useAsync` set `alive.current = false` in an effect cleanup but never
reset it to `true` on setup. StrictMode runs setup → cleanup → setup, so `alive` stayed
`false` and every resolved fetch skipped `setState`. (Also affects a genuine
unmount→remount on route revisit.)

**Judge (plan).** One-line, textbook fix: reset `alive.current = true` at setup, keep the
cleanup. No-op in production (StrictMode off there), so zero behavioural risk; unblocks
visual iteration on every page.

**Code.** `lib/hooks.js` — `useAsync` effect now `{ alive.current = true; return () => { alive.current = false; }; }`.

**Test.** Attackers (and the other data pages) now populate from the mock API. Data is
internally consistent — 203.0.113.66 shows Targeted/human and Real assets "Payments…",
contradicting IMPR.md P0.1's "Real assets: none" (already resolved on this branch).
`npm test` → 111/111 pass.

**Judge (result).** ✅ Pages load. This was a prerequisite for the whole review; without
it nothing else is observable. Committed.

---

## Module 1 — Containment safety-proof rendered green when NOT RUN (P0.3)

**Analyze.** `decoys/page.js` renders the "Containment: NOT RUN" state in `.ds-proof`
with no `data-tone`, so it inherits the calm green shield — an unverified safety proof
styled as a passing one. For a honeypot product the safety page *is* the product, so a
judge reads green as "contained" when nothing has been verified.

**Judge (plan).** Amber (not red): NOT RUN is unverified, not failed. `ds-proof` only had
`bad` (red). Add a `warn` tone from the existing `--drift` amber token and apply it to the
NOT RUN branch. PASS stays green, FAIL stays red.

**Code.** `app/lxs.css` — `.ds-proof[data-tone="warn"]` + its `.vb-ico`. `decoys/page.js`
— NOT RUN branch gets `data-tone="warn"`.

**Test.** PASS state still green (no regression). Forced the NOT RUN element's tone via
devtools to confirm the amber banner + amber icon render (computed bg/border = `#dfb361`).
`npm test` → 111/111.

**Judge (result).** ✅ Three distinct states: green PASS, amber NOT RUN, red FAIL. The
10-second judge mistake is gone. Committed.

---

## Module 2 — Live feed count lie + clarity (P0.2, plus two P1 wins)

**Analyze.** The card said `${rows.length} shown` but the table rendered `rows.slice(0, 120)`
— with up to 300 events in the store the count lies. Also: rows showed `below threshold`
(jargon) and activated only on Enter, not Space.

**Judge (plan).** Keep a windowed render (cheap, no virtualization dependency) but make the
count honest and add an explicit "Show more". Fold in the two same-file P1 wins while here.

**Code.** `app/feed/page.js` — `limit` state (120); detail shows `Showing 120 of N` when
capped; `rows.slice(0, limit)`; a "Show more · N older events hidden" button; Space key
activates a row (with `preventDefault`); `below threshold` → `Not an incident yet` with a
tooltip.

**Test.** At 61 mock events: honest "61 shown", no button. Temporarily defaulting the limit
to 30 showed "Showing 30 of 61" + "Show more · 31 older events hidden"; clicking it revealed
the rest and hid the button. `npm test` → 111/111.

**Judge (result).** ✅ The count never lies, older events stay reachable, and the jargon is
gone. Committed.

---

## Module 3 — Incident detail: sticky action bar + asterisk footnote (P1)

**Analyze.** This page was already strong on this branch (labeled kill-chain, the
"why critical" ledger, real-asset/honeytoken badges, human recommended-actions, Origin
and Files-touched both populated — several IMPR P1 items already done). The remaining
IMPR #1 ask stood: the primary actions (Block / Export IOCs / Acknowledge / Resolve)
lived at the *bottom* of the AI-summary band, below the fold. Also the `capped at 100*`
asterisk had no footnote. ATT&CK chips already carry a name tooltip and link, so no change.

**Judge (plan).** Extract an `IncidentActions` component and render it as a sticky bar
right under the hero header, pinned below the 48px top bar (104px on mobile where the top
bar shifts). Remove the buried copy from `AiBand`. Add the asterisk note to the existing
ledger footnote, only when a detection is scored past the cap.

**Code.** `app/incidents/[id]/page.js` — new `IncidentActions`; sticky instance after the
header; `AiBand` trimmed to summary-only (dropped the moved props and a stray `busy`
reference on the narrate button); asterisk footnote. `app/lxs.css` — `.incident-actions`
sticky styling with a blurred card background and a mobile `top` override.

**Test.** Bar sits above the fold and stays pinned while the timeline/ledger scroll under
it. Clicking Acknowledge fired the real handler (toast "Incident #7 acknowledged"), so the
rewiring is intact. Verified no render error (clean page, no Next overlay). `npm test` → 111/111.

**Judge (result).** ✅ Block is one click from anywhere on the page; the asterisk is
explained. Committed.

---

## Module 4 — ATT&CK matrix contrast ramp (P1)

**Analyze.** Column order was already correct kill-chain order on this branch. The live
contrast bug remained: text flipped to its inverted colour at `heat > 0.45`, but the cell
background only becomes saturated near `heat = 1`. So mid-heat cells got inverted text on a
low-contrast background — near-black on dark teal in dark mode (Vulnerability Scanning 33,
Password Guessing 27 were barely legible), and the IMPR "white on pale teal" in light mode.
The two themes also want opposite ramps (light: pale→dark as hits rise; dark: dark→bright).

**Judge (plan).** Raise the flip threshold to `0.62` so inverted text only lands on a truly
saturated cell, and give each theme its own ramp: a gentler light ramp (max 58% brand) so
dark text stays readable on even the hottest cell, a brighter dark ramp (82%) so the hottest
cells flip cleanly to near-black. Drop the forced white — dark text reads across the light
ramp.

**Code.** `app/attack/page.js` — `heat > 0.45` → `0.62`. `app/lxs.css` — `.cell` light ramp
58%, `.dark .cell` ramp 82%, `.cell.is-hot` keeps dark text (border only), `.dark .cell.is-hot`
near-black.

**Test.** Verified both themes at the cell level (zoomed): dark-mode mid-heat cells now use
readable light text and only the brightest flip to near-black; light-mode hottest cell is a
readable medium teal with dark text; the "darker = more hits" signal is preserved.
`npm test` → 111/111.

**Judge (result).** ✅ Every cell legible in both themes; ordering already correct. Committed.

---

## Module 5 — Blocklist "proof it bites" counter (P1 / demo win)

**Analyze.** The page already showed applied-sensor counts and relative+absolute expiry, but
nothing proved the core promise — that a block actually refuses traffic. IMPR: "show Requests
refused since block: N."

**Judge (plan).** Add a `refused_count` (+ `last_refused_at`) to the mock blocks, render a
per-block "Requests refused" column, and — because an 8th column lands off-screen in the wide
table — lead with a prominent green banner summing refused requests across active blocks, so a
judge sees the proof without scrolling.

**Code.** `lib/mock.js` — `refused_count`/`last_refused_at` on each block. `app/blocklist/page.js`
— `ds-proof` headline (sum of active refused), per-row column with tooltip and last-refused time.

**Test.** Restarted the dev mock backend to serve the new fields. Banner reads "2,092 requests
refused by 3 active blocks"; per-row counts (47 / 1,832 / 213) render with tooltips. `npm test`
→ 111/111.

**Judge (result).** ✅ The block is visibly doing something, headline-first. (Live incrementing
needs the simulator/stream and is out of this UI scope; the field is live against the real API.)
Committed.

---

## Module 6 — Audit log readability (P1)

**Analyze.** Row-click already opened a drawer with formatted-JSON metadata (that IMPR item was
done), and the table already uses the app's standard `stamp`. Remaining: no plain-English
sentence per entry, and the detail timestamp lacked a year and timezone for what is a legal
record. Rows also activated only on Enter.

**Judge (plan).** Keep the compact `stamp` in the table (app consistency) but, in the drawer:
lead with a humanized sentence (`humanizeAudit`) and spell the time out with year + timezone
(`preciseStamp`). Add Space-key activation to the shared `AuditTable` rows.

**Code.** `app/audit/page.js` — `humanizeAudit`, `preciseStamp`, drawer lead sentence + precise
time (dropped the now-unused `stamp` import). `components/workspace.jsx` — Space activates a row.

**Test.** Drawer reads "maya@acme.example blocked 198.51.100.23 (inc #6) for 24 h.", time shows
"01 Nov 2026, 06:26:22 GMT+5:30", metadata stays a formatted JSON block with Copy. `npm test`
→ 111/111.

**Judge (result).** ✅ The record reads like language and carries a court-ready timestamp.
Committed.

---

## Module 7 — Settings: dirty state, CIDR validation, switch label (P1)

**Analyze.** "Save changes" fired a toast unconditionally with no sense of what (if anything)
changed; the allowlist textarea had no placeholder, validation, or error; the AI-narration
switch had no visible On/Off; retention had no stated consequence.

**Judge (plan).** Snapshot a baseline from the loaded settings; derive a `changes` list and a
`dirty` flag; disable Save when clean or when any allowlist line is an invalid IP/CIDR, and name
the changed fields in the save toast. Add a placeholder + inline error to the allowlist, an
On/Off label to the switch, and a one-line consequence to retention.

**Code.** `app/settings/page.js` — `normAllow`/`invalidCidrs` helpers; `baseline` state;
`dirty`/`changes`/`badCidrs` derivation; Save button `disabled`/label/title + descriptive toast;
allowlist placeholder + `aria-invalid` + inline error; switch On/Off; retention consequence hint.

**Test.** Clean load → "Saved" (disabled). Typing `999.1.2.3` → inline "Not a valid IP or CIDR
range: 999.1.2.3" and Save disabled with an explanatory title. A valid change → "Save changes"
enabled ("Unsaved: allowlist"); saving toasts "Updated allowlist. Policy version bumped and
audited." and returns to clean. `npm test` → 111/111.

**Judge (result).** ✅ Save is honest about what it does, and the allowlist can't be saved
broken. Committed.

---

## Module 8 — Incident queue: search + condensed prose (P1)

**Analyze.** The IP no longer truncates (the per-incident cell wraps; the earlier clipping was
the whole table's horizontal scroll at narrow width). Remaining IMPR items: the triage model was
explained in a two-line prose paragraph, and there was no search/source filter.

**Judge (plan).** Condense the purpose to one line and move the tab-model explanation into a
"How the tabs work" tooltip. Add a search box that filters the active tab by source IP, #number,
or title, with a q-aware empty state.

**Code.** `app/incidents/page.js` — `q` state; tab rows filtered by IP/number/title; `ds-filter-bar`
with `TextFilter` + an `Info` tooltip; one-line purpose; "No matches" empty state when a query
filters everything out.

**Test.** Typing `91.240` narrowed Targeted to the single matching incident (#2) with a clear (×)
control; no console errors. `npm test` → 111/111.

**Judge (result).** ✅ An analyst can find a source fast, and the model explanation is one hover
away instead of a wall of text. Committed.

---

## Module 9 — Top-bar clickable severity counts (P2)

**Analyze.** The top bar's "N critical / N high" were static text. IMPR: "Make the critical/high
counts clickable links to the filtered queue." (The project selector / "Singularity" only renders
with >1 project, N/A in the single-project mock; the overview "Run simulation" is already a
secondary button and channels are configured, so the webhook nudge doesn't apply here. Kill-chain
components already carry labels/tooltips/aria.)

**Judge (plan).** Turn the critical and high counts into links to `/incidents?tab=targeted` (the
actionable queue), with a hover affordance; leave noise (not queued) as text.

**Code.** `components/Shell.jsx` — crit/high wrapped in `Link` with titles. `app/lxs.css` —
`.sev-summary a` hover style.

**Test.** Clicking "1 critical" from the overview navigated to `/incidents?tab=targeted` with the
Targeted tab active. `npm test` → 111/111.

**Judge (result).** ✅ The headline counts are now a one-click path into the queue, from any page.
Committed.

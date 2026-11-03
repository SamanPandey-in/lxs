# attackerFRONTEND.md — Attacker Demo Web UI (frontend spec)

### A very basic web app that fires attacks at the honeypots for the demo

| | |
|---|---|
| Scope | **Only the attacker's web UI.** The service that does the actual attacking is in `attacker.md` (the `attacker-api`). This doc is just the screen. |
| Purpose | Give the presenter (and a curious judge) buttons to run attacks and a console to send individual requests, and **show the result of each one** — especially "you've been blocked". |
| Keep it basic | This is a stage prop, not a product. No login, no routing, no data layer, no design system. One page. A few fetch calls. That is the whole thing. |
| Shape | **Scenario buttons on top, manual console below** (as decided). |
| Looks | It should look like a hacker's control panel, not like the polished SOC dashboard — deliberately different, so the audience never confuses the two halves of the demo. Dark, monospace, terminal-flavoured. The Genesis **demo client** (`demo-server-and-client/client/app/page.js`) is the reference for this inline-styled, single-file look — copy its vibe, not the SOC dashboard's. |

---

## 1. What the screen has (one page, three regions)

```
┌───────────────────────────────────────────────────────────────────────┐
│  ⚡ ATTACKER CONSOLE                         [ mode: ● LIVE  / SAFE ]   │  header
│  target: acme-shop.demo  ·  ssh :22  ·  http :443                      │
├───────────────────────────────────────────────────────────────────────┤
│  SCENARIOS                                                              │  region 1
│  [ ▶ Run noise ]  [ ▶ Run PS attacker ]  [ ▶ Honeytoken ]              │
│  [ ▶ Opportunistic ]  [ ▶ SQLi spray ]        [ ■ Reset ]              │
│                                                                         │
│  ── live run output ──────────────────────────────────────────────    │
│  10:41:02  http  GET /admin            → 200 decoy login page          │
│  10:41:52  ssh   login admin/admin     → ✓ shell opened                │
│  10:42:17  ssh   cat customer_data.csv → ✓ (fake data returned)        │
│  10:43:10  http  GET /api/payments     → 200 REAL ASSET TOUCHED        │
│  ✔ done · 10 steps · 0 blocked                                         │
├───────────────────────────────────────────────────────────────────────┤
│  MANUAL CONSOLE                                                         │  region 2
│  ┌── Web ──────────────────┐   ┌── SSH ─────────────────────┐          │
│  │ method [GET▾] path [___]│   │ user [___] pass [___]       │         │
│  │ header [Authorization]  │   │ [ Connect / Login ]         │         │
│  │        [_____________]  │   │ cmd [________________]      │         │
│  │ [ Send request ]        │   │ [ Run command ]             │         │
│  │ → 403 BLOCKED (red!)    │   │ → Connection refused (red!) │         │
│  └─────────────────────────┘   └─────────────────────────────┘         │
└───────────────────────────────────────────────────────────────────────┘
```

**Header:** product-y title, the current target(s) (from `attacker-api /health`), and a **LIVE / SAFE** toggle.

**Region 1 — Scenarios:** one button per scenario (from `GET /scenarios`), a Reset button, and a scrolling **run output** area that streams step results as they happen. This is what runs during the smooth demo.

**Region 2 — Manual console:** a Web panel (method, path, one optional header, Send) and an SSH panel (user, pass, Connect, command, Run). This is for "do X" moments and for showing the block in close-up.

---

## 2. Stack

As thin as possible. Match the attacker-api's ecosystem (Node/ESM) so it's one `npm install`.

- **Next.js (JS) single page**, or even plain **Vite + React** — it is one page, pick whichever is faster to stand up. No router needed.
- **No component library, no Tailwind, no tokens.** Inline styles or one small CSS file, terminal theme. This is the opposite choice from the dashboard on purpose.
- The browser calls a same-origin Next.js route at `/api/attacker/*`. The route proxies to `ATTACKER_API_URL` and adds the server-only `ATTACKER_API_TOKEN`; neither value is exposed in the browser bundle.
- Icons optional; emoji (⚡ ▶ ■ ✓ ✗) are fine for a prop.

**Theme (inline `C` object, like the Genesis demo client):** near-black background (`#0b0d0e`), green/amber terminal text, red for blocked/refused, one accent. Monospace everywhere. Keep it legible on a projector: large-ish font (14–15px), high contrast.

---

## 3. The only logic it has

Three fetch patterns against the same-origin proxy. The proxy forwards them to `attacker-api`; it adds the control token on the server.

**Run a scenario (streaming):**

```js
async function runScenario(id) {
  setRunning(true); setSteps([]);
  const res = await fetch('/api/attacker/run', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenarioId: id, mode }),
  });
  // stream NDJSON / SSE frames; append each {type:'step'} to the output list
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      const frame = JSON.parse(line);
      if (frame.type === 'step') appendStep(frame);
      if (frame.type === 'done') setRunning(false);
    }
  }
}
```

**Send one web request:**

```js
async function sendHttp() {
  const r = await fetch('/api/attacker/http', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, path, headers: headerObj, body: reqBody || undefined }),
  });
  const out = await r.json();          // { status, blocked, isDecoy, body, note }
  setHttpResult(out);                  // render; if out.blocked, show the big red banner
}
```

**Send one SSH action:**

```js
async function sshRun(action) {
  const r = await fetch('/api/attacker/ssh', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, username, password, cmd, sessionId }),
  });
  const out = await r.json();          // { ok, refused, output, sessionId }
  setSessionId(out.sessionId);
  setSshResult(out);                   // if out.refused, show the big red "Connection refused"
}
```

That is it. No store, no SSE library (the scenario stream is read with the fetch reader above), no auth, no persistence.

---

## 4. The three things the UI must get right

Everything else is cosmetic. These three carry the demo:

1. **The run output must animate.** Steps should appear one by one as they stream, not all at once, so the audience watches the attack unfold and the dashboard keep pace. (The pacing comes from attacker-api; the UI just appends each frame as it arrives.)

2. **"Real asset touched" must stand out** in the run output — bold it, colour it amber/red — because that line is the exact moment the dashboard flips to Critical. The presenter points at both screens at once.

3. **"Blocked" / "Refused" must be unmissable.** When `blocked:true` or `refused:true` comes back, render a large red banner ("⛔ BLOCKED BY LXS" / "⛔ CONNECTION REFUSED"). This is the payoff of the response beat: analyst clicks Block on the dashboard → presenter clicks Send here → big red banner. If it's subtle, the moment is lost.

---

## 5. States to handle (minimal)

| State | Show |
|---|---|
| attacker-api unreachable | a small "attacker-api offline — start it on :6060" line in the header; disable buttons |
| scenario running | disable other scenario buttons, show a spinner on the active one, Reset becomes Stop |
| step error | the step row turns red with the error text; the run continues |
| mode = SAFE | a visible "SAFE (replay)" badge so everyone knows it's the fallback path |
| empty console result | placeholder text ("send a request to see the response") |

No loading skeletons, no fancy transitions. Plain text state is fine.

---

## 6. Folder structure

```
attacker-demo/attacker-web/
├── package.json            # next (or vite+react), react, react-dom
├── app/
│   ├── layout.js           # minimal: just <html><body>{children}</body></html>, dark bg
│   ├── globals.css         # ~40 lines: terminal theme, mono font, red/green/amber
│   └── page.js             # the whole app: header + scenarios + console (one file is fine)
└── next.config.js
```

One `page.js` holding the three regions and the three fetch helpers above is completely acceptable — and preferred — for a demo prop. Do not over-structure it.

---

## 7. Definition of done

- Buttons list themselves from `GET /scenarios`.
- Clicking **Run PS attacker** streams steps into the output area, and the SOC dashboard reaches Critical while it runs.
- The manual Web panel can **Send request** to any path and renders the result.
- The manual SSH panel can log in and run a command against the honeypot and renders the output.
- After the analyst blocks the source on the dashboard, a fresh **Send request** / SSH connect shows a **big red blocked/refused banner**.
- The **LIVE / SAFE** toggle works and is clearly visible.
- It looks obviously different from the SOC dashboard (dark terminal vs clean SOC), so nobody in the audience mixes them up.

That is the whole app. Resist adding anything else to it — every hour spent polishing the attacker UI is an hour not spent on the honeypots, detection, or the dashboard, which are what actually win PS04.

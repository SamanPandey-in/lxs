# DEMO-SCRIPT.md — LXS · the 5-minute judge demo (v1)

Phase 0 deliverable. Owned by P4 from hour 1; updated as features land.

| | |
|---|---|
| Runtime | 5 minutes, three beats |
| Screens | Left: **attacker console** (dark terminal, `:3002`). Right: **SOC dashboard** (light, `:3000`). Never show a terminal full of logs. |
| Fallback | Every beat has a safe-mode equivalent (`ATTACK_MODE=safe`) that replays through `POST /v1/projects/:pid/demo/replay` with no live network. Rehearse both. |

---

## Before the room walks in

```bash
pnpm install
pnpm platform:up                 # Postgres
pnpm db:migrate && pnpm db:seed  # prints the dev ingest key
pnpm dev                         # API :8080 · dashboard :3000
cd examples/acme-shop && docker compose -f docker-compose.yml -f lxs.compose.yml up -d
cd attacker-demo/attacker-api && npm start      # :6060
cd attacker-demo/attacker-web && npm run dev    # :3002
```

Pre-flight checklist:

- [ ] Dashboard **Decoys** page: all four decoys green, sensor heartbeat < 30 s old.
- [ ] Dashboard **Containment** panel: self-test passed, timestamped today.
- [ ] Incident queue **empty** (reset the demo project if not).
- [ ] Attacker console header shows `LIVE` and `attacker-api online`.
- [ ] Both browser windows side by side, dashboard in light mode, attacker console dark.

---

## Beat 0 — the developer story (45 s)

Show `examples/acme-shop/decoy.config.ts` on screen. Say it, don't read it:

> "This is an ordinary Express shop. Four lines declare four decoys — a fake admin panel, two bait files, and a fake SSH box called `db-backup-01`. One command compiles them into Docker services that run beside the app."

Run nothing. Point at the generated `lxs.compose.yml` header: *generated, do not edit by hand*. Point out that the app never touches the Docker socket.

**The line that lands:** "Security monitoring added with one package and one command."

---

## Beat 1 — noise is not an alert (60 s)

Attacker console → **Run `noise`**.

Scripted scanner: user agent `nmap`, sweeps `/admin`, `/.env`, `/backup.sql`, five fast failed SSH logins.

On the dashboard, point at:
- The event feed moving — **something is happening**.
- The incident queue **not** paging anyone. The row sits under the **Noise** tab with "N noise suppressed".
- Score **23 · Low · Noise**.

**The line that lands:** "This is what the internet does to every public host, all day. A SOC that pages on this is a SOC that stops reading its pager. We label it and suppress it."

---

## Beat 2 — the real attack, Low → Critical (2 min 30 s)

Attacker console → **Run `ps-attacker`**. Narrate while it paces itself (human gaps, so it classifies as targeted).

| Attacker does | Dashboard shows | Say |
|---|---|---|
| Connects to SSH decoy | incident opens, **5 · Low** | "One incident, not twelve alerts." |
| Probes the three web paths | **10 · Low** | "Same source across two decoy types — we're already correlating." |
| 5 failed SSH logins | **20 · Low** | |
| Logs in `admin` / `admin` | **45 · Medium** | "They're in. A fake box, but they don't know that." |
| `ls -la`, `uname -a` | **50 → 60 · High** | "Human pacing, not a script. Label flips to **Targeted**." |
| `cat /srv/exports/customer_data.csv` | **70 · High** | "They just took the bait data." |
| Calls the real `/api/payments` | **CRITICAL** + red badge | **The moment.** "The same source that was in our decoy just touched a *real* asset. That's what turns this red." |

Now open the incident. This is the screen that wins or loses it — spend 45 seconds here:

1. **Kill-chain bar** — six stages, five lit. "How far did they get."
2. **"Why is it Critical?"** — read two lines aloud. Every point is a named rule with its evidence. "Nothing here is a black box."
3. **ATT&CK chips** — T1078.001, T1059.004, T1005, T1083. "Speaks the language the SOC already reports in."
4. **AI summary** — the plain-English paragraph. "The LLM explains. It never scores and never acts — the numbers above are deterministic rules, reproducible every run."

**The line that lands:** "Who, what, how far, how bad, what to do — one screen, no log diving."

---

## Beat 3 — one click, and it's real (45 s)

Dashboard → **Block source** → confirm.

Switch to the attacker console → **Send request** to `/admin` again.

Big red **BLOCKED** banner.

Back on the dashboard: the audit row, with who clicked it and when, and the block's expiry.

**The line that lands:** "That's not a simulated firewall. The SDK middleware enforced it inside the real app, within one poll interval. It expires, and it's reversible — every action is in the audit log."

---

## Closer (30 s)

Open the **Containment** panel.

> "Last thing. The decoys have no network. Web decoys run `network_mode: none` and are reached over a Unix socket; the SSH decoy is inbound-only with all new outbound traffic dropped; the agent is the only thing holding a credential, and the platform never dials into customer infrastructure. The self-test proves it, and it ran today."

Then:

> "Honeypots-as-code: `npm i`, declare, one command. Noise suppressed, one real attack explained end to end, and a response that actually bites."

---

## If something breaks

| Symptom | Do this, out loud, without apologising |
|---|---|
| Attacker console can't reach a target | Flip the toggle to **SAFE** — "replaying the same chain from recorded events" — and carry on. |
| Decoy container down | Open the **Decoys** page and show the health row going red. "The platform noticed before I did." Run the scenario in safe mode. |
| Dashboard SSE drops | The reconnect banner is part of the product. Refresh; state is server-side. |
| Score differs from the table | Don't correct it live. The rules are deterministic; the pacing varied. Keep narrating the shape, not the number. |
| Total platform failure | Screen-recorded run of Beat 2 in `docs/assets/`. Record it the night before. **Do this.** |

---

## The five scenarios behind the demo

These also run in CI (BREAKDOWN §12.3), so what judges see is what the test suite asserts.

| Scenario | Drives | Must produce |
|---|---|---|
| `noise` | scanner + fast brute force | ~23 · Low · Noise · suppressed · no page |
| `ps-attacker` | scan → default creds → shell → read data → real asset | one incident, Low→Critical, Targeted, correct ATT&CK + stages, real-asset badge |
| `honeytoken` | read `/.env` → use the key on the real app | Critical via R16 (65 raw, floored to 75), honeytoken badge, Targeted |
| `opportunistic` | brute force → scripted bot commands | High · Opportunistic · batched, not paged |
| `block` | after `ps-attacker`, analyst blocks | next request refused within the poll interval; audit row written |

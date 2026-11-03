# attacker-demo

The LXS **attacker's console** — a standalone stage prop used to drive
the live demo. Not part of the product, not shipped to customers, no auth, no
persistence. Full spec: `../docs/attacker.md` and `../docs/attackerFRONTEND.md`.

Two small apps, deliberately outside the pnpm workspace:

```
attacker-demo/
├── attacker-api/   # Express 5 + ssh2, does the real attacks. :6060
└── attacker-web/   # Next.js, one page: scenario buttons + manual console. :3002
```

## Run (dev)

```bash
# terminal 1 — attacker-api
cd attacker-demo/attacker-api
npm install
ATTACK_MODE=live TARGET_APP_URL=http://localhost:3001 TARGET_SSH_HOST=localhost TARGET_SSH_PORT=2222 \
ALLOW_TARGETS=localhost ATTACKER_API_TOKEN=choose-a-long-random-value npm start

# terminal 2 — attacker-web
cd attacker-demo/attacker-web
npm install
ATTACKER_API_URL=http://127.0.0.1:6060 ATTACKER_API_TOKEN=choose-a-long-random-value npm run dev   # :3002
```

Open http://localhost:3002.

## The demo beats

1. **Run noise** — fast scanner/brute-force bot, dashboard stays Low/Noise.
2. **Run PS attacker** — human-paced scan → brute-force → `admin/admin` login →
   reads fake customer data → hits the real `/api/payments`. Dashboard climbs
   to Critical.
3. **Block source** on the SOC dashboard, then **Send request** here — big red
   "BLOCKED" / "CONNECTION REFUSED" banner proves the block works.

## Live vs Safe mode

Toggle in the header (or `ATTACK_MODE=live|safe` env var). Live hits the real
honeypots; Safe replays a recorded version of the scenario through the
platform's `POST /v1/projects/:pid/demo/replay` endpoint — use it if the lab
network misbehaves on stage. See `../docs/attacker.md` §3 and §8 for the
source-IP notes.

## Guardrails

`attacker-api` refuses any target not in `ALLOW_TARGETS`, and refuses public
IP targets unless `ALLOW_PUBLIC=1` is set. See `../docs/attacker.md` §9.

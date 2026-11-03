# Getting started

From nothing to your first explained incident. About fifteen minutes, most of it waiting
for containers.

You need: Node 22+, pnpm 10, Docker, and a Linux host if you want the containment
guarantees to be real (see the note at the end).

---

## 1. Run the platform

```bash
git clone <this repo> && cd lxs
pnpm install
pnpm platform:up                  # Postgres in Docker
pnpm db:migrate
pnpm db:seed                      # prints a dev ingest key — copy it
pnpm dev                          # API on :8080, dashboard on :3000
```

Open <http://localhost:3000>. The dashboard is empty, and the onboarding checklist is
waiting for a sensor.

The seed creates one organisation, one project (`acme-shop`) and a **development ingest
key**. It is deterministic so the example app works out of the box:

```
ds_dev_0000000000000000000000000000000000000000
```

It is a development convenience and nothing else. In any real deployment you create a
key from **Settings → Keys** in the dashboard and the secret is shown exactly once.

---

## 2. Add decoys to an app

The example app in `examples/acme-shop` is an ordinary Express shop with a real
`/api/payments` route. Everything below applies the same way to your own app.

```bash
cd examples/acme-shop
npm i lxs                 # already a workspace dependency in the example
npx lxs init
```

`init` writes two files. `decoy.config.ts` is yours to edit:

```ts
import { LXS } from 'lxs';

const t = new LXS({
  service: 'shop',           // this app's service name in docker-compose.yml
  mode: 'enforce',           // 'monitor' never blocks, even if the platform asks
  trustProxy: ['loopback'],  // only if a reverse proxy sits in front
  allowlist: ['10.0.0.0/8'], // your own scanners and uptime monitors
});

// Web decoys — a path on your own domain
t.create('web-admin', '/admin', {
  brand: 'Acme Shop',
  acceptCredentials: [['admin', 'admin']],
  panel: 'customers',
});
t.create('web-bait', '/.env');        // the template is inferred from the path
t.create('web-bait', '/backup.sql');

// Network decoys — a host port
t.create('ssh', 22, {
  persona: 'db-backup',
  hostname: 'db-backup-01',
  credentials: 'weak-defaults',
});

// Real routes worth naming in alerts
t.asset('/api/payments/*', { name: 'Payments API', criticality: 'critical' });
t.asset('/api/*', { name: 'Shop API' });

// A fake key in the same shape as your real ones, planted in /.env and on the SSH box
t.honeytokens({ apiKey: { header: 'authorization', prefix: 'acme_live_' } });

export default t;
```

`.env.lxs` holds the ingest key and is git-ignored. Paste the key from step 1
into it.

Then wire the middleware. It must be **first**, before your own routes:

```ts
import express from 'express';
import decoys from '../decoy.config';

const app = express();
app.use(decoys.express());   // first
// ... your real routes
app.listen(3000);
```

Fastify instead:

```ts
await fastify.register(decoys.fastify());
```

---

## 3. Build and deploy

```bash
npx lxs build
#  ✔ 4 decoys: web-admin /admin · web-bait /.env · web-bait /backup.sql · ssh :22 (db-backup-01)
#  ✔ 2 assets, 1 honeytoken set generated (.lxs/secrets/, git-ignored)
#  → docker compose -f docker-compose.yml -f lxs.compose.yml up -d

docker compose -f docker-compose.yml -f lxs.compose.yml up -d
```

`build` is the parser. It compiles your declarations into `lxs.compose.yml` — an
**override file**, merged with your own compose file, which is how it can attach the log
volume to your app's service without you editing anything. Both generated files carry a
*do not edit by hand* header; regenerate instead. `build --check` fails if they are stale,
which is what you run in CI.

Your application never touches the Docker socket and never starts a container.

Within about a minute the dashboard's onboarding checklist ticks **Sensor connected** and
shows four healthy decoys.

---

## 4. Prove the decoys are sealed

```bash
npx lxs selftest
```

It probes each decoy from the inside and checks it can reach nothing — not the internet,
not your host, not the cloud metadata service, not your app, not even the platform. The
report is posted to the dashboard's **Containment** panel with a timestamp.

Run it before you trust the deployment, and again after any Docker restart.

---

## 5. Trip a decoy

```bash
curl http://localhost:3000/.env
```

You get a convincing fake `.env` back. Within about a second the dashboard's live feed
shows an `http.request` event with `is_decoy: true`, and an incident opens at **Low**.

For the full story, run the attacker console:

```bash
cd attacker-demo/attacker-api && npm start      # :6060
cd attacker-demo/attacker-web && npm run dev    # :3002
```

Open <http://localhost:3002> and press **Run ps-attacker**. Watch the dashboard climb
Low → Medium → High → **Critical** as the same source moves from the decoys to the real
payments API. Then open the incident: the kill chain, the per-rule "Why is it Critical?"
ledger, the ATT&CK chips, and the AI summary.

Press **Block source** on the dashboard, then send another request from the attacker
console. It is refused — the middleware enforces it inside your real app.

---

## Two run modes

| Mode | Set with | Behaviour |
|---|---|---|
| `monitor` | `mode: 'monitor'` in the config | Decoys capture everything; the platform can ask for a block and the middleware will not apply it. Start here. |
| `enforce` | `mode: 'enforce'` | Blocks requested from the dashboard are applied inside your app within one poll interval, and expire. |

Switch to `enforce` once you trust the allowlist.

---

## A word about where you run this

The containment story depends on host firewall rules that only exist on Linux
(`infra/victim/ds-firewall.sh`). **Docker Desktop on macOS and Windows runs containers
inside a VM where those rules cannot be applied from the host.** Developing there is fine
and everything works. Claiming the decoys are sealed is not — `selftest` will tell you so
rather than report a pass it cannot back.

---

## Where to go next

| You want | Read |
|---|---|
| The full design | `docs/BREAKDOWN.md` |
| The API, precisely | `docs/API-CONTRACT.md` |
| To run the demo | `docs/DEMO-SCRIPT.md` |
| What the rules actually score | `packages/detection/src/rules.ts` and its golden tests |
| How containment is enforced | `docs/BREAKDOWN.md` §7.10 and `infra/victim/README.md` |

# acme-shop: the demo customer app

To send this app's honeypot events to the project whose key is configured in `.env.lxs`, follow [the ingest key and project ownership flow](../../docs/ingest-key-project-flow.md).

A small Express shop protected by LXS. It has one real, sensitive route (`/api/payments`, declared as a
critical asset) and the full demo decoy set:

| Decoy | Where | What it is |
|---|---|---|
| `web-admin` | `/admin` | fake "Acme Shop" admin login; `admin`/`admin` opens a fake customer panel with an "Export customers" link |
| `web-bait` | `/.env` | fake secrets file; leaks `SSH_HOST=db-backup-01`, a deploy password and a fake `acme_live_...` API key |
| `web-bait` | `/backup.sql` | fake `pg_dump` with canary customer rows |
| `ssh` | host port 2222 | Cowrie persona `db-backup-01`, accepts `admin`/`admin`, holds the planted API key and a canary export |
| `redis` | host port 6380 | Synthetic RESP endpoint with bounded command logging and fake key names |
| `postgres` | host port 5433 | Separate disposable PostgreSQL service seeded only with fake shop records; connection/auth events are collected, SQL statements are not logged; unrelated to platform Postgres |

The planted `acme_live_...` key is a honeytoken: if anyone sends it to the real app, the middleware reports the use by
token id (only a sha256 hash of the key ever leaves the machine).

## The five-command developer journey

```bash
npm i lxs                                   # 1. install
npx lxs init --service shop                 # 2. scaffold decoy.config.ts, .env.lxs, .gitignore entries
npx lxs build                               # 3. compile the declarations into lxs.compose.yml + .lxs/
docker compose -f docker-compose.yml -f lxs.compose.yml up -d    # 4. deploy the shop and the sensors
npx lxs selftest                            # 5. prove containment
```

Between commands 2 and 3 you edit `decoy.config.ts` (already done in this example) and make
`app.use(decoys.express())` the first middleware in `src/server.ts` (also done). Before command 4, paste the ingest key
from the dashboard into `.env.lxs`:

```bash
LXS_INGEST_KEY=ds_live_...
LXS_ENDPOINT=https://soc.example.dev
```

Within about a minute the dashboard's onboarding checklist shows "Sensor connected" and six healthy decoys.

## What is committed here

| File | Notes |
|---|---|
| `decoy.config.ts` | the declarations; contains nothing secret |
| `lxs.compose.yml` | a committed example of the generated output (do not edit by hand) |
| `.lxs/manifest.json`, `web-decoys.json`, `ssh-db-backup-01/cowrie.cfg`, `postgres-5433/init.sql` | generated synthetic configuration and seed data, safe to commit |
| `.lxs/secrets/**`, `.env.lxs` | **git-ignored**: honeytoken plaintext, bait credentials, the ingest key |

CI can guard against drift with `npx lxs build --check` (exits 1 if the committed output is stale).

## Try it

```bash
# normal traffic is untouched
curl localhost:3000/api/products

# decoys answer instead of the app
curl -i localhost:3000/.env
curl -i localhost:3000/backup.sql
curl -i localhost:3000/admin
ssh admin@localhost            # password: admin (Cowrie; every keystroke is logged)
redis-cli -p 6380 KEYS '*'     # synthetic keys; only command names are retained
PGPASSWORD=lxs_fake_only psql -h localhost -p 5433 -U lxs_fake shop_prod -c 'SELECT * FROM users'

# after the source above has touched a decoy, a hit on the real asset is reported as asset.access
curl localhost:3000/api/payments
```

To run the attack simulator against this app from a chosen source IP, start the stack with
`SHOP_NODE_ENV=development DS_DEV_SIM=1 docker compose ... up -d`. That makes the SDK honour `X-DS-Sim-IP`;
the SDK refuses to start with that flag when `NODE_ENV=production`.

## Notes

* Change the host port in `decoy.config.ts` if 2222 is already in use.
* Images are tagged `0.1.0`. Build them from the repo root with `images/*.Dockerfile` and export
  `LXS_AGENT_IMAGE`, `LXS_WEB_IMAGE`, `LXS_COWRIE_IMAGE` to use local tags or pinned digests.
* On Docker Desktop (macOS/Windows) the host firewall rules from `infra/victim/ds-firewall.sh` cannot be applied, so
  `selftest` marks that check as skipped and the containment claim is limited to what Docker enforces itself.
* Run the app without Compose (`npm run dev`) and the middleware warns once and does nothing: decoy paths fall through to
  the app's own routes.

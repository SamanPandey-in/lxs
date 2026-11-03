# lxs

Honeypots as code. Declare decoy endpoints in a typed config, compile them into a hardened Docker Compose override, and
report decoy interactions to the LXS platform. The SDK never holds a credential and never talks to the platform.

```bash
npm i lxs
npx lxs init --service shop
npx lxs build
docker compose -f docker-compose.yml -f lxs.compose.yml up -d
npx lxs selftest
```

## 60-second quick start

```ts
// decoy.config.ts
import { LXS } from 'lxs';

const t = new LXS({ service: 'shop', mode: 'enforce' });

t.create('web-admin', '/admin', { brand: 'Acme Shop', acceptCredentials: [['admin', 'admin']] });
t.create('web-bait', '/.env');
t.create('web-bait', '/backup.sql');
t.create('ssh', 22, { persona: 'db-backup', hostname: 'db-backup-01' });

t.asset('/api/payments/*', { name: 'Payments API', criticality: 'critical' });
t.honeytokens({ apiKey: { header: 'authorization', prefix: 'acme_live_' } });

export default t;
```

```ts
// server.ts
import decoys from './decoy.config';
app.use(decoys.express()); // must be the first middleware
// Fastify: await fastify.register(decoys.fastify());
```

`create('ssh', '/admin')` and `create('web-admin', 2222)` are compile-time errors (overloads) and runtime errors with a
hint for JavaScript users. A declarative alternative is `defineConfig({ decoys: [...], assets: [...] })`.

## What the middleware does

Per request, in order: skip if disabled or the source is allow-listed; return a generic 403 if the source is on the
polled blocklist (`mode: 'enforce'` only); proxy declared decoy paths to `ds-web` over a Unix socket (a named pipe on
Windows) with `Cookie` and `Authorization` stripped; report use of a planted honeytoken; report `asset.access` when a
watch-listed source touches a declared asset. Everything else is a handful of `Set` lookups and `next()`.

It fails open: an unreachable agent never breaks the app, an unreachable decoy yields a generic 404 on decoy paths only.
`X-Forwarded-For` is ignored unless `trustProxy` lists the proxy.

## CLI

| Command | |
|---|---|
| `lxs init [--service <name>]` | scaffold `decoy.config.ts`, `.env.lxs(.example)`, `.gitignore` entries |
| `lxs build [--config <file>] [--out <file>] [--check]` | validate and generate; `--check` exits 1 if committed output is stale |
| `lxs selftest [--report]` | `docker inspect` / `docker exec` containment probes; `--report` forwards the result through the agent |

`build` refuses to continue if `.env.lxs` or `.lxs/secrets/` is not git-ignored, if the target service
is missing from `docker-compose.yml`, or if anything resembling an ingest key (`ds_live_`) appears in a file it reads.

## Error codes

`E_OPTIONS`, `E_MOUNT_TYPE`, `E_MOUNT_INVALID`, `E_MOUNT_RESERVED`, `E_MOUNT_COLLISION`, `E_ID_COLLISION`,
`E_PORT_TYPE`, `E_PORT_RANGE`, `E_PORT_COLLISION`, `E_TEMPLATE_UNKNOWN`, `E_ASSET_PATTERN`, `E_ASSET_DUPLICATE`,
`E_TYPE_UNKNOWN`, `E_NO_DECOYS`, `E_UNSUPPORTED`, `E_SERVICE_MISSING`, `E_NOT_GITIGNORED`, `E_KEY_IN_CONFIG`,
`E_CONFIG_NOT_FOUND`, `E_CONFIG_EXPORT`, `E_COMPOSE_INVALID`. Each `LXSConfigError` has `code` and `hint`.

## Testing your app with the middleware mounted

```ts
import { startFakeAgent } from 'lxs/testing';
const agent = await startFakeAgent({ runDir, watchlist: ['127.0.0.1'], fakeDecoy: true });
// ... mount decoys.express() with { runDir }, send requests, then assert on agent.signals
```

## Environment

| Situation | Behaviour |
|---|---|
| `LXS_DISABLED=1` or `disabled: true` | no-op middleware |
| socket directory missing (`npm run dev` without Compose) | warn once, no-op |
| edge / serverless runtime | throws at start-up with a clear message |
| `NODE_ENV=production` with `LXS_DEV_TRUST_SIM_HEADER=1` | refuses to start |

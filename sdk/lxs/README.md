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
Windows) with `Authorization` stripped and every cookie stripped except the decoy's own session cookie
(`PHPSESSID`, forwarded only in the exact format `ds-web` issues); report use of a planted honeytoken; report
`asset.access` when a watch-listed source touches a declared asset. Everything else is a handful of `Set` lookups and
`next()`.

It fails open: an unreachable agent never breaks the app, an unreachable decoy yields a generic 404 on decoy paths only.

## Client IP and `trustProxy`

By default the client is the socket address and `X-Forwarded-For` is ignored, because the client can write anything
into it. Behind a reverse proxy, tell the SDK which hops to trust:

| `trustProxy` | Client address |
|---|---|
| `false` (default) | the socket address |
| a hop count, e.g. `1` | walk `[...X-Forwarded-For, socket]` from the right and take the address just beyond the last of the `n` trusted hops. `1` = one proxy (nginx, a cloud load balancer) in front of the app. Only safe if the app cannot be reached except through those proxies. |
| a list, e.g. `['loopback']`, `['10.0.0.0/8']` | only if the socket peer is in the list: walk `X-Forwarded-For` from the right, skipping listed addresses; the first unlisted one is the client. Named ranges: `loopback`, `uniquelocal`, `linklocal`. |

`trustProxy: true` is rejected (`E_TRUST_PROXY`): it would make the leftmost entry the client, which an attacker
sets to any address, evading blocks or getting someone else blocked. A `/0` entry (`0.0.0.0/0`, `::/0`) is rejected in
`trustProxy` for the same reason, and in `allowlist` because it would disable blocking entirely (`E_OPTIONS`). The
middleware also ignores a `/0` entry in the allowlist it polls from the platform.

### Migrating from `trustProxy: true` (0.2.0)

Replace it with the number of proxies in front of the app (usually `trustProxy: 1`), or with the proxies' addresses
(`trustProxy: ['loopback']` when nginx runs on the same host, `['uniquelocal']` or a CIDR such as `['10.0.0.0/8']`
for a load balancer in a private network).

## Production telemetry

`telemetry: { dir: './telemetry' }` mounts a host directory read-only into `ds-agent`, which tails `firewall.jsonl`
and `auth.jsonl` there (restrict with `sources: ['firewall']`) and reports them as `prod.firewall` / `prod.auth`
events, so the platform can correlate decoy attackers with touches on real assets that are not HTTP routes. One JSON
object per line:

```jsonl
{"ts":"2026-11-01T10:43:21Z","src_ip":"203.0.113.66","dst_ip":"10.0.1.20","dst_port":443,"proto":"tcp","action":"allow","asset":"Payments API"}
{"ts":"2026-11-01T10:43:24Z","src_ip":"203.0.113.66","user":"admin","service":"payments-api","result":"success","asset":"Payments API"}
```

`action` is `allow|accept|deny|drop|reject`, `result` is `success|failure`; `asset` (optional) names the real asset.
A denied connection is recorded but is not treated as a touch on the asset.

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
`E_TYPE_UNKNOWN`, `E_TRUST_PROXY`, `E_NO_DECOYS`, `E_UNSUPPORTED`, `E_SERVICE_MISSING`, `E_NOT_GITIGNORED`, `E_KEY_IN_CONFIG`,
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

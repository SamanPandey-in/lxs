# lxs

Honeypots as code. Declare decoy endpoints in a typed config, compile them into a hardened Docker Compose override, and
report decoy interactions to the LXS platform. The SDK never holds a credential and never talks to the platform.

```bash
npm i lxs
npx lxs init --service shop --preset shop   # asks for your ingest key (hidden input)
npx lxs build
npx lxs doctor                              # Docker, ports, key, endpoint: one fix per problem
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

## lxs.yaml

The same config can live in a language-neutral `lxs.yaml` instead of `decoy.config.ts` (useful when the app is not
written in TypeScript, or when a Go service and a Node service share one decoy layout). It has exactly the fields of a
`defineConfig({...})` object:

```yaml
# yaml-language-server: $schema=./node_modules/lxs/schema/lxs.schema.json
service: shop
mode: enforce
# trustProxy: [loopback]
# allowlist: [10.0.0.0/8]

decoys:
  - type: web-admin
    path: /admin
    brand: Acme Shop
    acceptCredentials:
      - [admin, admin]
  - type: web-bait
    path: /.env
  - type: ssh
    port: 22
    hostname: db-backup-01

assets:
  - pattern: /api/payments/*
    name: Payments API
    criticality: critical

honeytokens:
  apiKey:
    header: authorization
    prefix: acme_live_
```

- `lxs build` picks up `lxs.yaml` (or `lxs.yml`) when there is no `decoy.config.ts`. If both exist it stops with
  `E_CONFIG_AMBIGUOUS`; choose one with `--config lxs.yaml` (or delete the other).
- The file is checked against the same zod schema the TypeScript API uses, then goes through `defineConfig()`, so
  validation and generated output are identical (a test builds `examples/acme-shop` both ways and compares bytes).
  Unknown keys are errors (`E_CONFIG_INVALID`), so typos do not pass silently.
- `lxs/schema/lxs.schema.json` is the JSON Schema, generated from the zod schema (`pnpm --filter lxs schema`; a test
  fails if the committed copy is stale). Point your editor at it as in the first line above.
- In a Node app, mount the middleware from it with `loadLxsYaml`:

  ```ts
  import { loadLxsYaml } from 'lxs';
  const decoys = loadLxsYaml('lxs.yaml');
  app.use(decoys.express());
  ```

The middleware behaviour itself is specified language-neutrally in [`conformance/SPEC.md`](../../conformance/SPEC.md)
with test vectors that the Express and Fastify adapters pass (`pnpm --filter @lxs/conformance-node test`).

## What the middleware does

Per request, in order: skip if disabled or the source is allow-listed; return a generic 403 if the source is on the
polled blocklist (`mode: 'enforce'` only); proxy declared decoy paths to `ds-web` over a Unix socket (a named pipe on
Windows) with `Authorization` and client-sent `x-ds-*` headers stripped and every cookie stripped except the decoy's own session cookie
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
| `lxs init [--service <name>] [--preset <name>] [--endpoint <url>] [--key <key>] [--no-input] [--force]` | scaffold `decoy.config.ts`, `.env.lxs(.example)`, `.gitignore` entries |
| `lxs doctor [--json]` | check everything a first run needs; exits 1 if any check fails |
| `lxs build [--config <file>] [--out <file>] [--check]` | validate `decoy.config.ts` or `lxs.yaml` and generate; `--check` exits 1 if committed output is stale |
| `lxs selftest [--report]` | `docker inspect` / `docker exec` containment probes; `--report` forwards the result through the agent |

### `lxs init`

- **Endpoint.** `LXS_ENDPOINT` defaults to the hosted platform (`DEFAULT_ENDPOINT` in `src/cli/init.ts`).
  `--endpoint`, then env `LXS_ENDPOINT`, then a value already in `.env.lxs` win over it. Self-hosters pass
  `--endpoint http://localhost:4000`.
- **Key.** On a terminal, init asks for the ingest key with hidden input (Enter skips). In CI use `--key` or env
  `LXS_INGEST_KEY`; `--no-input` never prompts. The key is written only to `.env.lxs` (mode 600, git-ignored before it
  is written), never to `decoy.config.ts`, never to the log. Re-running init keeps an existing key.
- **Presets.** `--preset` writes a ready-to-build `decoy.config.ts`. Network decoys use high host ports
  (2222/5433/6380) so a first run never collides with a real sshd, Postgres or Redis; move them to the standard
  ports once the real services listen elsewhere.

| Preset | Web decoys | Network decoys | Assets / honeytoken |
|---|---|---|---|
| `shop` | `/admin` (fake customer panel), `/.env`, `/backup.sql`, `/.git/config` | SSH `db-backup-01` :2222, Postgres (`shop` seed) :5433 | payments + checkout critical; `shop_live_` key |
| `saas-api` | `/internal/admin`, `/.env`, `/.env.production`, `/.git/config`, `/db/backup.sql` | SSH `api-worker-01` :2222, Redis (`sessions`) :6380, Postgres (`finance`) :5433 | billing + admin API critical; `x-api-key` `api_live_` key |
| `wordpress` | `/wp-login.php`, `/phpmyadmin`, `/wp-content/uploads/backup.sql`, `/.env` | SSH `wp-prod-01` :2222, Redis :6380 | `/api/*`. For Node apps that do **not** run WordPress: WordPress paths draw most scanner traffic |

### `lxs doctor`

One line per check (`✓` pass, `✗` fail, `!` warning or skipped), one `fix:` line under each failure, exit 1 on any `✗`.
`--json` prints `{ ok, checks: [{ id, title, status, detail, fix }] }`.

| id | Checks |
|---|---|
| `docker` | `docker --version` |
| `daemon` | the daemon answers `docker version` |
| `compose` | `docker compose version` is v2+ |
| `config` | `decoy.config.ts` loads and validates |
| `ports` | the host ports of network decoys are free (or held by the running `ds-*` containers) |
| `env` | `.env.lxs` has a URL in `LXS_ENDPOINT` and a real (non-placeholder) `LXS_INGEST_KEY` |
| `endpoint` | `GET $LXS_ENDPOINT/healthz` is 2xx |
| `key` | `GET /v1/agent/whoami` with the key (read-only; falls back to `GET /v1/agent/policy` on older servers) |
| `images` | every image in `lxs.compose.yml` is present locally (`docker image inspect`) or pullable (`docker manifest inspect`) |
| `build` | `lxs build --check`: the committed output matches the config |

`build` refuses to continue if `.env.lxs` or `.lxs/secrets/` is not git-ignored, if the target service
is missing from `docker-compose.yml`, or if anything resembling an ingest key (`ds_live_`) appears in a file it reads.

## Error codes

`E_OPTIONS`, `E_MOUNT_TYPE`, `E_MOUNT_INVALID`, `E_MOUNT_RESERVED`, `E_MOUNT_COLLISION`, `E_ID_COLLISION`,
`E_PORT_TYPE`, `E_PORT_RANGE`, `E_PORT_COLLISION`, `E_TEMPLATE_UNKNOWN`, `E_ASSET_PATTERN`, `E_ASSET_DUPLICATE`,
`E_TYPE_UNKNOWN`, `E_TRUST_PROXY`, `E_NO_DECOYS`, `E_UNSUPPORTED`, `E_SERVICE_MISSING`, `E_NOT_GITIGNORED`, `E_KEY_IN_CONFIG`,
`E_CONFIG_NOT_FOUND`, `E_CONFIG_AMBIGUOUS`, `E_CONFIG_INVALID`, `E_CONFIG_EXPORT`, `E_COMPOSE_INVALID`, `E_PRESET_UNKNOWN`, `E_KEY_FORMAT`, `E_ENDPOINT_INVALID`. Each `LXSConfigError` has `code` and `hint`.

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

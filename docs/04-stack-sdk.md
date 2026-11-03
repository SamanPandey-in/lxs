
---

## 4. Technology stack

### 4.1 Stack overview

| Layer | Recommended technology | Alternatives considered | Reasoning (short) | MVP? |
|---|---|---|---|---|
| Web dashboard | React SPA served as static files by Caddy | Next.js app | Authenticated tool, no SEO, no server rendering needed; one fewer runtime to deploy | Yes |
| Frontend framework | React 19 + Vite + TypeScript, React Router (SPA mode), TanStack Query, Tailwind CSS + shadcn/ui, Recharts, lucide icons | TanStack Router; Mantine; Chart.js | Fast to build, widely known, AI tools generate it well; shadcn gives accessible primitives without a heavy design system | Yes |
| Backend framework | Node.js LTS + **Fastify 5** + `fastify-type-provider-zod`, pino | NestJS, Hono, Express, Go (S1) | Fast, schema-first, plugin model maps to modules, first-class TS; NestJS adds ceremony; Express lacks schema validation; Go splits the codebase | Yes |
| Data access | **Drizzle ORM** + `postgres` (postgres.js) driver, drizzle-kit migrations | Prisma, Kysely | SQL-shaped TS, no engine binary, easy raw SQL for advisory locks and `inet` | Yes |
| Database | **PostgreSQL 17** | SQLite (S4), MySQL, MongoDB | `inet`/CIDR types, `jsonb`, concurrent writers, LISTEN/NOTIFY, partitioning later, managed options everywhere | Yes |
| Cache / queue | **pg-boss** on the same Postgres; in-memory LRU for key lookups | Redis + BullMQ, NATS | Retries, backoff, scheduling, singleton keys without a second stateful service | Yes |
| Event processing | Worker role in the same codebase; per-source advisory locks; pure detection package | Separate stream processor (Kafka, Benthos), Vector transforms | Volumes are tiny; determinism and testability matter more than throughput | Yes |
| Realtime transport | **SSE** with Postgres LISTEN/NOTIFY fan-out | WebSocket (S1, S4), Socket.IO | One-way push, plain HTTP, built-in reconnect and `Last-Event-ID`; actions use REST | Yes |
| SDK / package | TypeScript, `tsup` (dual ESM/CJS + `.d.ts`), zod, `yaml`, `jiti`, `commander` | Rollup/unbuild; JSON config instead of TS | Typed config is the diagram's step 2; `jiti` loads TS config without asking users to compile | Yes |
| Sensor agent | TypeScript on Node LTS, bundled to one file, distroless non-root image | Vector, Fluent Bit, Go binary | Shares normalisers and schema with the platform; tiny surface; one language | Yes |
| Web decoys | TypeScript, Fastify on a Unix socket, static templates | Python Flask; in-process in the app | Same language as SDK; container with no network | Yes |
| SSH honeypot | **Cowrie** (Python, upstream image, our persona layer) | Hand-built ssh2 + TS shell (S4); Kippo; HonSSH | Mature, believable emulation in hours instead of a day; we maintain config, not Python code | Yes |
| Redis decoy | TypeScript RESP server (~200 lines) | redis-honeypot projects in Go/Python | Cheap, same language, full control of logging | Essential (cut first) |
| Attack simulator | TypeScript (`ssh2` client, `fetch`) | Python + paramiko (S1) | Keeps the repo single-language; ssh2 handles interactive shells fine | Yes |
| Authentication | **Better Auth** (email + password, Postgres sessions, Drizzle adapter); custom hashed API keys for machines | Clerk, Auth.js, hand-rolled sessions | Self-hosted, TS-native, has an organisation plugin for later; keys are simple enough to own | Yes |
| LLM | Provider-agnostic adapter; any fast, inexpensive model on Anthropic or an OpenAI-compatible API | Local model (Ollama) | Explanation quality matters, latency matters more; adapter lets us swap | Yes (with fallback) |
| Infrastructure | Two Ubuntu 24.04 VMs (platform, victim) with Docker Engine + Compose v2; Caddy for TLS | Kubernetes; PaaS (Railway, Render, Fly) for the platform | Iptables control for containment; judges can SSH to a public IP; PaaS cannot host the victim | Yes |
| Deployment | GitHub Actions → images on GHCR → `docker compose pull && up -d` over SSH | Terraform + Ansible | Minutes to set up; reproducible | Yes |
| Monitoring | pino JSON logs, `/healthz` + `/readyz`, internal System page; optional Sentry | Prometheus + Grafana, OpenTelemetry | Enough to run a demo and a pilot; add metrics stack when there is more than one instance | Yes (Sentry optional) |
| Testing | Vitest, Fastify `inject`, Playwright, k6, `testcontainers` for Postgres | Jest, Cypress, Artillery | Fast, TS-native, k6 scripts are JS | Yes |
| Monorepo tooling | pnpm workspaces + Turborepo; Biome (lint + format); Changesets (SDK releases) | npm workspaces (S4), Nx, ESLint + Prettier | Fast installs, cached builds, one lint tool | Yes |

### 4.2 The decisions that deserve an argument

| Decision | Why it fits this product | Downsides | Operational complexity | Scalability | DX / maintenance | MVP? |
|---|---|---|---|---|---|---|
| **TypeScript over Go for the backend** [CHANGED from S1] | The team's strongest language; the SDK, agent, decoys and dashboard are already TS, so one schema package and one test runner cover everything | Lower raw throughput than Go; Node memory per instance higher | Same container model either way | Ingest at thousands of events/s per instance is ample for this product | One language, shared types end to end | Yes |
| **Fastify over NestJS / Hono / Express** | Schema-first routes with zod give runtime validation and typed handlers in one place; encapsulated plugins = modules | Smaller "batteries" than NestJS (no DI container) | Low | Proven at high request rates | Simple mental model; easy for AI-assisted coding | Yes |
| **Postgres over SQLite** [CHANGED from S4] | The diagram's platform is central and multi-project: concurrent writers (ingest + worker), `inet` for blocklists, LISTEN/NOTIFY for SSE fan-out, a job queue, managed backups | One more container; slightly more setup | `postgres:17` in compose; daily dump | Vertical scaling plus partitioning carries far beyond MVP | Migrating from SQLite later would touch schema and queries — paying a few minutes now avoids it | Yes |
| **pg-boss over Redis/BullMQ** | Retries, backoff, cron, singleton jobs, all inside the database we already run | Polling latency (set to 500 ms); throughput ceiling far above our needs | None beyond Postgres | Thousands of jobs/s; swap to a broker if ever needed, behind the same job interface | One fewer system to secure and back up | Yes |
| **SSE over WebSocket** [CHANGED from S1/S4] | Data flows one way (server → dashboard); actions are REST calls with audit; SSE reconnects and resumes natively | No client → server messages (not needed); `EventSource` cannot set headers (we use same-origin cookies) | None | Works across instances via LISTEN/NOTIFY | Less code than a WS protocol | Yes |
| **Cowrie over a hand-built TS SSH shell** [CHANGED from S4] | Decades of collective tuning: dozens of emulated commands, fake filesystem, TTY logs, download emulation. Saves a full person-day in a 30-hour event. Also credible to SOC judges. | Python inside our stack; config quirks (fake filesystem is a pickled file, persona files must be baked at image build); log parsing needed | One upstream image, pinned by digest, wrapped in our persona image | Horizontal per host | We maintain config only; upgrades are image bumps | Yes |
| **Agent sidecar over direct sensor posting** [CHANGED from S4] | Decoys hold no credential and need no network; one auditable component crosses the boundary | One more container | Small, stateless except offsets | One agent per host | Normalisers shared with the platform | Yes |
| **Better Auth over Clerk** | Self-hostable (matters for a security product), keeps users in our Postgres, TS-native | Younger project; we own password-reset email later | Library only | n/a | Less vendor lock-in | Yes |
| **SPA over Next.js** | No SEO or server rendering needs; static hosting; fewer moving parts | No server components (not needed) | Static files | CDN-friendly | Simple | Yes |

Python stays acceptable for future security tooling (threat-intel enrichment, YARA scanning of quarantined uploads, offline analysis notebooks). Nothing in the MVP needs it beyond the Cowrie image.

### 4.3 Finalised stack (decisions, not options)

- **Language:** TypeScript (strict) everywhere we write code; Node.js current LTS line for platform and images; SDK supports Node ≥ 22.
- **Platform:** Fastify 5 API in a modular monolith with `ROLE=api|worker|all`; Drizzle + postgres.js; PostgreSQL 17; pg-boss; SSE via LISTEN/NOTIFY; Better Auth; pino.
- **Dashboard:** React 19, Vite, React Router, TanStack Query, Tailwind + shadcn/ui, Recharts.
- **SDK:** `lxs` npm package (config API + CLI + Express/Fastify middleware), built with tsup.
- **Sensor images:** `lxs/agent` and `lxs/decoy-web` (TS, distroless), `lxs/cowrie-personas` (`FROM cowrie/cowrie@<digest>`), optional `lxs/decoy-redis` (TS).
- **Simulator:** TypeScript CLI in the monorepo (`apps/simulator`).
- **LLM:** provider-agnostic adapter, default to a fast, low-cost hosted model; template fallback always on.
- **Infra:** two Ubuntu VMs, Docker Engine + Compose, Caddy, GHCR, GitHub Actions.
- **Quality:** Vitest, Playwright, k6, Biome, Changesets, Turborepo.
- Pin every dependency version and image digest at the start of Phase 1; versions above are the intended lines, not verified current releases.

---

## 5. The npm SDK

### 5.1 Purpose and responsibilities

The SDK has three jobs, matching diagram steps 2, 3 and the runtime half of 4:

1. **Declare** decoys and sensitive real assets in typed code (`decoy.config.ts`).
2. **Compile** those declarations into a hardened Compose override and its assets (the CLI / "Parser").
3. **Run** a tiny middleware inside the app that routes decoy paths, reports known attackers touching real routes, detects honeytoken use and enforces blocks.

What the SDK must **not** do: start or stop containers; hold or transmit the platform key; talk to the platform; parse request bodies of real traffic; send telemetry about normal users; make detection decisions (those live on the platform, where they can be tuned without redeploying customer apps).

### 5.2 Installation and initialisation

```bash
npm i lxs                 # step 1
npx lxs init --service shop
```

`init` creates `decoy.config.ts` with commented defaults, appends `.env.lxs` and `.lxs/secrets/` to `.gitignore`, and creates `.env.lxs.example`:

```bash
# .env.lxs  (git-ignored; paste the key from the dashboard)
LXS_INGEST_KEY=ds_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
LXS_ENDPOINT=https://soc.example.dev
```

### 5.3 Developer integration, end to end

**Declare decoys (step 2):**

```ts
// decoy.config.ts
import { LXS } from 'lxs';

const t = new LXS({
  service: 'shop',          // the app's service name in docker-compose.yml
  mode: 'enforce',          // 'monitor' never blocks, even if the platform asks
  trustProxy: ['loopback'], // only if a reverse proxy runs in front of the app
  allowlist: ['10.0.0.0/8'],// your own scanners and uptime monitors
});

// Web decoys: the second argument is a path on your own domain
t.create('web-admin', '/admin', { brand: 'Acme Shop', acceptCredentials: [['admin', 'admin']], panel: 'customers' });
t.create('web-bait', '/.env');          // template inferred from the path
t.create('web-bait', '/backup.sql');

// Network decoys: the second argument is a host port
t.create('ssh', 22, { persona: 'db-backup', hostname: 'db-backup-01', credentials: 'weak-defaults' });
// t.create('redis', 6379, { seed: 'finance' });   // optional (E9)

// Real routes worth naming in alerts
t.asset('/api/payments/*', { name: 'Payments API', criticality: 'critical' });
t.asset('/api/*', { name: 'Shop API' });

// Fake key in the same format as real keys; planted in /.env and on the SSH box
t.honeytokens({ apiKey: { header: 'authorization', prefix: 'acme_live_' } });

export default t;
```

**Wire the middleware (runtime):**

```ts
// src/server.ts — Express
import express from 'express';
import decoys from '../decoy.config';

const app = express();
app.use(decoys.express());   // must be the first middleware
// ... the app's real routes
app.listen(3000);
```

```ts
// Fastify alternative
await fastify.register(decoys.fastify());   // registers an onRequest hook and checks route collisions
```

**Parse (step 3) and deploy (step 4):**

```bash
npx lxs build
#  ✔ 4 decoys: web-admin /admin · web-bait /.env · web-bait /backup.sql · ssh :22 (db-backup-01)
#  ✔ 2 assets, 1 honeytoken set generated (.lxs/secrets/, git-ignored)
#  → docker compose -f docker-compose.yml -f lxs.compose.yml up -d

docker compose -f docker-compose.yml -f lxs.compose.yml up -d
npx lxs selftest            # prove containment (§7.10)
```

Within about a minute the dashboard's onboarding checklist shows "Sensor connected" and four healthy decoys.

### 5.4 What `build` generates

```yaml
# lxs.compose.yml  (diagram: mehoney-compose.yml)
# Generated by lxs 0.1.0 from decoy.config.ts. Do not edit by hand.

x-ds-hardened: &ds-hardened
  read_only: true
  cap_drop: [ALL]
  security_opt: ["no-new-privileges:true"]
  restart: unless-stopped
  logging: { driver: local, options: { max-size: "10m", max-file: "3" } }

services:
  shop:                                     # merged into the customer's own service
    volumes:
      - ds_web_sock:/run/lxs/web
      - ds_agent_sock:/run/lxs/agent
    environment:
      LXS_RUN_DIR: /run/lxs

  ds-agent:
    <<: *ds-hardened
    image: ghcr.io/lxs/agent:0.1.0@sha256:<pinned>
    user: "10001:10001"
    env_file: [.env.lxs]            # the only place the key exists
    networks: [ds_uplink]
    mem_limit: 256m
    cpus: 0.5
    pids_limit: 128
    tmpfs: ["/tmp:size=16m,noexec,nosuid"]
    volumes:
      - ds_agent_sock:/run/lxs/agent
      - ds_agent_state:/var/lib/lxs
      - ds_web_logs:/var/log/lxs/web:ro
      - ds_ssh_logs:/var/log/lxs/ssh-db-backup-01:ro
      - ./.lxs/manifest.json:/etc/lxs/manifest.json:ro
      - ./.lxs/secrets/honeytokens.json:/etc/lxs/honeytokens.json:ro

  ds-web:
    <<: *ds-hardened
    image: ghcr.io/lxs/decoy-web:0.1.0@sha256:<pinned>
    user: "10002:10002"
    network_mode: none                      # no network interface at all
    mem_limit: 128m
    cpus: 0.25
    pids_limit: 64
    tmpfs: ["/tmp:size=8m,noexec,nosuid"]
    volumes:
      - ds_web_sock:/run/lxs/web
      - ds_web_logs:/var/log/lxs
      - ./.lxs/web-decoys.json:/etc/lxs/web-decoys.json:ro
      - ./.lxs/secrets/honeytokens.json:/etc/lxs/honeytokens.json:ro

  ds-ssh-db-backup-01:
    <<: *ds-hardened
    image: ghcr.io/lxs/cowrie-personas:0.1.0@sha256:<pinned>
    networks: [ds_trap]
    ports: ["22:2222"]                      # move the host's real sshd to another port first
    mem_limit: 256m
    cpus: 0.5
    pids_limit: 128
    tmpfs: ["/tmp:size=16m,noexec,nosuid", "/cowrie/cowrie-git/var/run:size=1m"]
    volumes:
      - ds_ssh_logs:/cowrie/cowrie-git/var/log/cowrie
      - ds_ssh_data:/cowrie/cowrie-git/var/lib/cowrie
      - ./.lxs/ssh-db-backup-01/cowrie.cfg:/cowrie/cowrie-git/etc/cowrie.cfg:ro
      - ./.lxs/ssh-db-backup-01/userdb.txt:/cowrie/cowrie-git/etc/userdb.txt:ro
      - ./.lxs/secrets/ssh-db-backup-01/honeyfs:/cowrie/honeyfs-live:ro
    healthcheck:
      test: ["CMD", "python3", "-c", "import socket; socket.create_connection(('127.0.0.1', 2222), 2)"]
      interval: 30s
      timeout: 5s
      retries: 3

networks:
  ds_trap:
    driver: bridge
    driver_opts:
      com.docker.network.bridge.name: br-ds-trap
      com.docker.network.bridge.enable_ip_masquerade: "false"
      com.docker.network.bridge.enable_icc: "false"
    ipam:
      config: [{ subnet: 172.31.250.0/24 }]
  ds_uplink:
    driver: bridge

volumes:
  ds_web_sock: {}
  ds_agent_sock: {}
  ds_web_logs: {}
  ds_ssh_logs: {}
  ds_ssh_data: {}
  ds_agent_state: {}
```

Notes: Cowrie's in-image paths and writable directories must be verified against the pinned image in Phase 2 (they differ between Cowrie releases). The health check connects from `127.0.0.1`, so the agent drops loopback-sourced Cowrie sessions during normalisation. Separate socket volumes are deliberate: `ds-web` (attacker-facing) can never reach the agent's socket.

Other generated files:

| File | Contents | Commit? |
|---|---|---|
| `.lxs/manifest.json` | Decoy list (id, type, mount, persona), assets, declared containment posture, SDK version | Yes |
| `.lxs/web-decoys.json` | Per-path template, brand, accepted credentials, breadcrumb targets | Yes |
| `.lxs/ssh-<id>/cowrie.cfg`, `userdb.txt` | Hostname, banner, persona filesystem, accepted credentials, forwarding disabled, JSON logging on | Yes |
| `.lxs/secrets/honeytokens.json` and `secrets/ssh-<id>/honeyfs/` | Plaintext honeytoken values and the bait file contents that contain them | **No** (git-ignored; `build` refuses to continue if they are not ignored) |

### 5.5 Public API (TypeScript)

```ts
export type WebDecoyType = 'web-admin' | 'web-bait';
export type NetDecoyType = 'ssh' | 'redis';
export type Path = `/${string}`;

export interface LXSOptions {
  service?: string;                     // compose service of the app, default 'app'
  mode?: 'monitor' | 'enforce';         // default 'enforce'
  runDir?: string;                      // default env LXS_RUN_DIR or '/run/lxs'
  trustProxy?: boolean | string[];      // 'loopback' | 'uniquelocal' | CIDRs; default false
  allowlist?: string[];                 // CIDRs never reported or blocked
  disabled?: boolean;                   // default env LXS_DISABLED === '1'
  logger?: Pick<Console, 'warn' | 'error'>;
}

export interface WebAdminOptions {
  id?: string;
  brand?: string;                                    // shown on the fake login page
  acceptCredentials?: Array<[user: string, pass: string]>; // these "work" and open the fake panel
  acceptAfter?: number;                              // or: accept any credentials after N tries
  panel?: 'customers' | 'none';                      // fake panel with an "Export customers" link
}
export interface WebBaitOptions {
  id?: string;
  template?: 'dotenv' | 'sql-dump' | 'git-config' | 'wp-login' | 'phpmyadmin'; // inferred from the path if omitted
  breadcrumbs?: boolean;                             // plant links to other decoys, default true
}
export interface SshOptions {
  id?: string;
  persona?: 'db-backup' | 'web-server';
  hostname?: string;
  credentials?: 'weak-defaults' | Array<[string, string]>;
  banner?: string;                                   // SSH version string to present
}
export interface RedisOptions { id?: string; seed?: 'finance' | 'sessions'; requirePassword?: boolean; }

export interface AssetOptions { name: string; criticality?: 'normal' | 'critical'; }
export interface HoneytokenOptions {
  apiKey?: { header: 'authorization' | 'x-api-key'; prefix: string };
  canaryRows?: number;                               // unique fake emails inside decoy exports
}

export class LXS {
  constructor(options?: LXSOptions);
  create(type: 'web-admin', path: Path, options?: WebAdminOptions): this;
  create(type: 'web-bait', path: Path, options?: WebBaitOptions): this;
  create(type: 'ssh', port: number, options?: SshOptions): this;
  create(type: 'redis', port: number, options?: RedisOptions): this;
  asset(pattern: Path, options: AssetOptions): this;
  honeytokens(options?: HoneytokenOptions): this;
  express(): import('express').RequestHandler;
  fastify(): import('fastify').FastifyPluginAsync;
  handler(): (req: import('http').IncomingMessage, res: import('http').ServerResponse, next: () => void) => void;
  readonly decoys: ReadonlyArray<DecoySpec>;
}

export class LXSConfigError extends Error { readonly code: string; readonly hint?: string; }
```

`create('ssh', '/admin')` or `create('web-admin', 2222)` are compile-time errors thanks to the overloads, and runtime errors (with a hint) for JavaScript users.

### 5.6 CLI reference

| Command | What it does | Network? |
|---|---|---|
| `lxs init [--service <name>]` | Scaffold `decoy.config.ts`, `.env.lxs.example`, `.gitignore` entries | No |
| `lxs build [--config <file>] [--out <file>] [--check]` | Validate and generate; `--check` exits 1 if committed output is stale | No |
| `lxs selftest [--report]` | Probe containment with `docker exec` and `docker inspect`; print PASS/FAIL; `--report` posts the result through the agent's credentials file | Only with `--report` |

Validation performed by `build`: unique ids and mounts; web mounts are absolute paths without query strings or wildcards; ports in 1–65535 and unique; reserved paths refused (`/`, `/robots.txt`, `/favicon.ico`, `/health*`); the target service exists in `docker-compose.yml`; `.env.lxs` and `.lxs/secrets/` are git-ignored; no string matching `ds_live_` appears in any read file.

### 5.7 Runtime middleware internals

Per request (hot path), in order:

```ts
function onRequest(req, res, next) {
  if (cfg.disabled) return next();
  const ip = clientIp(req, cfg.trustProxy);              // socket address unless proxy trusted
  if (allowlist.has(ip)) return next();

  if (cfg.mode === 'enforce' && policy.blocklist.has(ip)) {
    signals.push({ kind: 'asset.blocked', ip, method: req.method, path: pathOnly(req.url) });
    res.statusCode = 403; return res.end('Forbidden');    // generic body, no product name
  }

  const decoy = decoyMatcher.match(pathOnly(req.url));    // exact paths, precompiled
  if (decoy) return proxyToDecoy(req, res, decoy, ip);    // stream over web.sock; never next()

  const token = honeytokenCandidate(req);                 // header named in config only
  if (token && policy.honeytokens.has(sha256(token))) {
    signals.push({ kind: 'honeytoken.use', ip, method: req.method, path: pathOnly(req.url), token_id: policy.honeytokens.get(sha256(token)) });
  }

  if (policy.watchlist.has(ip) && rateGate.allow(ip, pathOnly(req.url))) {   // max 1 per ip+path per 60 s
    res.once('finish', () => signals.push({
      kind: 'asset.access', ip, method: req.method, path: pathOnly(req.url),
      status: res.statusCode, asset: assetMatcher.name(pathOnly(req.url)),
    }));
  }
  next();
}
```

- `proxyToDecoy` pipes the raw request to `ds-web` with `http.request({ socketPath })`, removes `Cookie` and `Authorization`, adds `X-DS-Client-IP`, `X-DS-Decoy-Id` and a request id, and pipes the response back. A 10 s timeout returns a generic 504.
- The policy cache refreshes every 2 s from `GET /v1/policy` on the agent socket with ETags. The watchlist is updated by the agent the moment it ships a decoy event, so a real-asset touch seconds after a decoy hit is still caught.
- Signals go into a bounded queue (1 000) flushed every 500 ms to `POST /v1/signals` on the agent socket. When the queue is full the oldest are dropped and counted.
- **Client IP:** the socket address by default. If the app is behind a reverse proxy, `trustProxy` must list it; otherwise `X-Forwarded-For` is ignored because attackers can forge it. In development only, `LXS_DEV_TRUST_SIM_HEADER=1` honours `X-DS-Sim-IP` from the simulator; the flag is refused when `NODE_ENV=production`.

### 5.8 Authentication and project identification

The SDK needs **no credential**. The ingest key identifies the project, and it lives only in the agent's environment. The config file contains nothing secret, so it is safe to commit and review. The SDK identifies itself to the agent through the shared socket volume (only containers that mount the volume can connect).

### 5.9 Communication with the backend

The SDK runtime talks only to the agent; the agent talks to the platform.

| Interface | Caller → callee | Transport | Purpose |
|---|---|---|---|
| Local agent API `GET /v1/policy` | Middleware → agent | Unix socket | Blocklist, watchlist, honeytoken hashes, policy version |
| Local agent API `POST /v1/signals` | Middleware → agent | Unix socket | `asset.access`, `asset.blocked`, `honeytoken.use` |
| Decoy proxy | Middleware → `ds-web` | Unix socket | Raw HTTP stream |
| `POST /v1/agent/register`, `POST /v1/agent/heartbeat`, `GET /v1/agent/policy`, `POST /v1/ingest` | Agent → platform | HTTPS + Bearer | §8.7 |

### 5.10 Event reporting

| Origin | Event types |
|---|---|
| `ds-web` (via agent) | `http.request`, `auth.attempt` (fake login), `file.download` (bait served), `honeytoken.read` |
| Cowrie (via agent) | `connection.open/close`, `auth.attempt`, `command.exec`, `file.download`, `file.upload`, `proxy.attempt`, `ssh.client` |
| Middleware (via agent) | `asset.access`, `asset.blocked`, `honeytoken.use` |
| Telemetry tail (via agent, E7) | `prod.firewall`, `prod.auth` |

The middleware never reports normal traffic. It reports only sources already seen on a decoy, blocked sources, and honeytoken use.

### 5.11 Error handling

- **Build time: fail fast and loud.** Invalid options throw `LXSConfigError` with a `code` and a `hint` (for example `E_MOUNT_COLLISION: '/admin' is declared twice. Use id: to tell them apart.`).
- **Route collisions:** the Fastify adapter checks `fastify.hasRoute()` when the server is ready and throws on a collision; the Express adapter inspects the router stack best-effort and warns. In both cases the middleware runs first, so the decoy wins and the real route is shadowed — `build` prints the list of shadowed paths.
- **Request time: never throw into the app.** Every hot-path error is caught, counted and logged at most once per minute. Agent unreachable → fail open. Decoy unreachable → generic 404 for decoy paths.

### 5.12 Retry and buffering

| Layer | Buffer | Retry | Loss behaviour |
|---|---|---|---|
| Middleware → agent | In-memory queue, 1 000 signals | Next flush (500 ms) | Drops oldest, counts drops, reports count with the next flush |
| Agent → platform | In-memory ring, 10 000 events (MVP); on-disk spool (A2) | Exponential backoff with jitter, 0.5 s → 60 s cap; honours `Retry-After` | Drops oldest beyond capacity; drop counts sent in heartbeats and shown on the System page |
| Duplicates | — | — | Absorbed by `(project_id, event_id)` uniqueness; agent-generated ULIDs make retries idempotent |

### 5.13 Performance overhead

Budget: under 50 µs added at p99 for a non-decoy request (a `Set` lookup, a precompiled path match, no body parsing, no allocation beyond the path slice). Decoy requests cost one extra local socket hop, which is irrelevant because only attackers make them. A benchmark (`autocannon` against the demo app with and without the middleware) runs in CI; a regression above 10 % fails the build.

### 5.14 Environment detection

| Situation | Behaviour |
|---|---|
| `LXS_DISABLED=1` or `disabled: true` | No-op middleware |
| Socket directory missing (e.g. `npm run dev` without Compose) | Warn once, no-op; decoy paths return 404 |
| Edge / serverless runtime detected (no `net`/`http` Unix socket support) | Throw at start-up with a clear message (unsupported in MVP) |
| `NODE_ENV=production` with the dev sim-header flag | Refuse to start |

### 5.15 Versioning and compatibility

- Semver for the package. The SDK's minor version pins the agent and decoy image tags of the same minor, so the generated YAML is always coherent.
- Events carry `schema_version: 1`. The API keeps accepting v1 for at least 12 months after a v2 exists.
- The agent sends `User-Agent: lxs-agent/<ver> (sdk <ver>)`; the API answers outdated agents with `Deprecation` and `Sunset` headers; the dashboard shows an "agent outdated" banner.
- Local agent socket API is versioned (`/v1/...`) so a newer agent can serve an older middleware.

### 5.16 Security of SDK credentials

| Secret | Where it lives | Never |
|---|---|---|
| Ingest key | `.env.lxs` on the host → `ds-agent` environment only | In the app, in decoys, in git, in generated YAML (referenced via `env_file`) |
| Honeytoken plaintext | `.lxs/secrets/` → mounted read-only into the decoys that plant them and into the agent (to derive hashes) | In the app (it receives hashes only), in git, in events (events carry the token id) |

Keys use the `ds_live_` prefix so secret scanners can detect leaks; GitHub secret-scanning partnership is a later step.

### 5.17 TypeScript types and developer experience

Overloaded `create()` with literal-typed mounts; JSDoc on every option with an example; template-literal path types; `LXSConfigError` codes documented with fixes; a `lxs/testing` export with a fake agent socket so app teams can test their app with the middleware mounted.

### 5.18 Documentation and examples shipped with the SDK

README (60-second quick start), `examples/express-compose`, `examples/fastify-compose`, a config reference generated from the zod schemas, an error-code reference, and a "how it is contained" page linking to `selftest`.

### 5.19 Boundary summary

| Public SDK API (developers) | Internal SDK implementation | Platform APIs consumed (by the agent, not the SDK) |
|---|---|---|
| `new LXS()`, `create()`, `asset()`, `honeytokens()`, `express()`, `fastify()`, `handler()`, CLI `init/build/selftest`, error codes | Registry, zod schemas, YAML renderers, honeytoken generator, path matcher, policy cache, signal queue, socket proxy, local socket client | `POST /v1/agent/register`, `POST /v1/agent/heartbeat`, `GET /v1/agent/policy`, `POST /v1/ingest`, `POST /v1/agent/selftest-report` |

# LXS

**Honeypots-as-code for developers, plus a SOC dashboard that turns decoy hits into explained, actionable attack chains.**

Hackathon: D3COY · PS04 — Deception-Driven Threat Detection and Response.

---

## What it is

A honeypot has no legitimate users, so *any* interaction with it is a near-zero-false-positive signal. LXS gives a developer that signal with one package and one command, and gives an analyst the resulting attack chain already correlated, scored, mapped to MITRE ATT&CK, and explained in plain English.

Three pieces, and only three:

1. **The SDK** — `npm i lxs`. Declare decoys in `decoy.config.ts`; `npx lxs build` compiles them into `lxs.compose.yml`. Middleware routes decoy paths to an isolated container and enforces blocks inside the real app.
2. **The sensor stack** — generated containers that run beside the app: a web decoy, a Cowrie SSH honeypot, and an agent that ships events with a Bearer key. The agent is the only component holding a credential; the platform never dials in.
3. **The platform** — a Fastify API (ingest, detection, incidents, response), PostgreSQL, and a React dashboard fed by Server-Sent Events.

### The moment that matters

An attacker probes the fake `/admin` panel, brute-forces the fake SSH box, logs in with `admin`/`admin`, reads the bait data — and then touches the **real** payments API. That is one incident climbing Low → Medium → High → **Critical**, on one screen, with a point-by-point "Why is it critical?" ledger and a one-click block that actually bites.

---

## Requirements

| | |
|---|---|
| Node | 22+ |
| pnpm | 10+ (`npm i -g pnpm`) |
| Docker | Desktop or Engine, running |
| OS | Any for development. **Linux for the containment guarantees** — see [Containment](#containment) |

---

## Quick start — the whole demo, one command

```bash
pnpm install
pnpm demo
```

That builds the decoy images, starts Postgres, migrates and seeds, boots the API, the dashboard, the shop app with its decoys, and the attacker console — checking each step as it goes.

| Service | URL |
|---|---|
| **SOC dashboard** | <http://localhost:3000> |
| **Attacker console** | <http://localhost:3002> |
| Shop app (the real app being protected) | <http://localhost:3001> |
| Platform API | <http://localhost:8080> |

Then run the three-beat demo (`docs/DEMO-SCRIPT.md` has the words):

1. Attacker console → **Run `noise`** — the dashboard labels it Noise and suppresses it. Nobody gets paged.
2. Attacker console → **Run `ps-attacker`** — one incident climbs Low → **Critical**.
3. Dashboard → **Block source** — the next attacker request is refused.

Other demo commands:

```bash
pnpm demo:status     # what is running, and the current incident counts
pnpm demo:down       # stop the containers
pnpm demo --no-images     # skip the image build (already built)
pnpm demo --no-sensors    # platform + dashboard only, no Docker decoys
pnpm demo --dev           # serve the dashboard with hot reload (5-20x slower)
```

The demo serves the dashboard from a **production build**. `next dev` compiles each route
the first time it is opened, which costs 0.6-2.6 s per screen; production serves the same
screens in 120-290 ms. Use `--dev` only when you are editing the dashboard. See
`docs/PERFORMANCE.md` for the measurements.

---

## Setup, step by step

Use this when you want to run pieces individually, or when `pnpm demo` fails and you need to see where.

### 1. Install

```bash
pnpm install
cp .env.example .env          # defaults work for local development
```

### 2. Database

```bash
pnpm platform:up              # Postgres 16 in Docker, on 127.0.0.1:5432
pnpm db:migrate
pnpm db:seed
```

The seed prints what you need:

```
login      : demo@lxs.dev / demo1234
project    : acme-shop (<uuid>)
ingest key : ds_dev_0000000000000000000000000000000000000000   <- DEV ONLY
```

That ingest key is deterministic so the example app works out of the box. It is a development convenience and nothing else — in a real deployment you create a key from **Settings → Keys** and the secret is shown once.

### 3. API and dashboard

```bash
pnpm dev                      # Postgres + API (:8080) + dashboard (:3000)
pnpm dev:all                  # the same, plus the attacker console
```

Or separately:

```bash
pnpm --filter @lxs/api dev                       # :8080
cd apps/dashboard && npm install && npm run dev  # :3000
```

### 4. The decoys

```bash
docker build -f images/agent.Dockerfile           -t lxs/agent:0.1.0 .
docker build -f images/decoy-web.Dockerfile       -t lxs/decoy-web:0.1.0 .
docker build -f images/cowrie-personas.Dockerfile -t lxs/cowrie-personas:0.1.0 .

cd examples/acme-shop
cp .env.lxs.example .env.lxs        # paste the ingest key from the seed
npx lxs build                       # config -> lxs.compose.yml + .lxs/
docker compose -f docker-compose.yml -f lxs.compose.yml up -d
npx lxs selftest                    # prove the decoys are sealed
```

### 5. Attacker console

```bash
cd attacker-demo/attacker-api && npm install && npm start     # :6060
cd attacker-demo/attacker-web && npm install && npm run dev   # :3002
```

### No Docker? Drive it from the simulator

The simulator posts synthetic-but-valid events straight at the ingest endpoint, so the whole detection and dashboard story works without a single container beyond Postgres:

```bash
pnpm demo:simulate ps-attacker
pnpm demo:simulate noise
pnpm demo:simulate opportunistic
pnpm demo:simulate honeytoken
```

---

## Adding LXS to your own app

```bash
npm i lxs
npx lxs init --service <your-compose-service-name>
# edit decoy.config.ts, paste your ingest key into .env.lxs
npx lxs build
docker compose -f docker-compose.yml -f lxs.compose.yml up -d
npx lxs selftest
```

Wire the middleware **first**, before your own routes:

```ts
import express from 'express';
import decoys from '../decoy.config';

const app = express();
app.use(decoys.express());   // first
// ... your real routes
```

`docs/getting-started.md` is the full walkthrough. Start in `mode: 'monitor'` (never blocks) and move to `'enforce'` once you trust your allowlist.

---

## Development

```bash
pnpm test        # 109 tests across 7 packages
pnpm typecheck
pnpm lint        # Biome
pnpm build
```

The detection engine's golden tests lock the demo's numbers. If you change a rule and the `ps-attacker` chain stops scoring 5 → 10 → 20 → 45 → 50 → 60 → 70 → Critical, CI fails — deliberately, because the demo narrates those numbers out loud.

---

## Repository layout

| Path | What |
|---|---|
| `packages/schema` | **The contract.** `DecoyEvent`, API DTOs, policy, honeytokens. Everything imports this. |
| `packages/detection` | Pure, deterministic rules R01–R19, ATT&CK map, kill chain, scoring, labels. No I/O. |
| `packages/normalizer` | Raw Cowrie / ds-web / telemetry records → `DecoyEvent`. |
| `apps/api` | Fastify platform. `ROLE=api\|worker\|all`. Drizzle + Postgres + pg-boss. |
| `apps/dashboard` | The SOC dashboard (Next.js, standalone npm project). |
| `apps/agent` | `ds-agent` — tailer, shipper, policy poller. Holds the only credential. |
| `apps/decoy-web` | `ds-web` — decoy templates on a Unix socket, no network at all. |
| `apps/simulator` | Synthetic attack traffic for tests, CI and Docker-less demos. |
| `sdk/lxs` | The public npm package. |
| `examples/acme-shop` | The demo customer app. |
| `attacker-demo` | The judge-facing attacker console (standalone). |
| `infra`, `images`, `data` | Compose files, Dockerfiles, wordlists, personas, seeded telemetry. |
| `docs` | The engineering blueprint. Start with `docs/BREAKDOWN.md`. |

`apps/dashboard` and `attacker-demo` are plain-JS npm projects deliberately kept **outside** the pnpm workspace — they have no workspace imports, so keeping them out avoids a package-manager fight for no benefit.

---

## Key documents

| Doc | Read it for |
|---|---|
| `docs/BREAKDOWN.md` | The full blueprint — architecture, stack, SDK, dashboard, honeypots, backend, security, phases |
| `docs/API-CONTRACT.md` | The one-page frozen contract everything mocks against |
| `docs/DEMO-SCRIPT.md` | The 5-minute judge demo, beat by beat, with the failure playbook |
| `docs/getting-started.md` | The full first-run walkthrough |
| `docs/PROGRESS.md` | Where we are against the plan, and what is left, in order |
| `docs/PERFORMANCE.md` | What was slow, what was measured, what was fixed |
| `docs/STATUS.md` | Per-phase detail and known gaps |
| `docs/frontend.md` | How the dashboard is built |

---

## Containment

The decoys are sensors, never a pivot:

- Web decoys run with **`network_mode: none`** and are reached over a Unix socket.
- Network decoys are inbound-only, with all new outbound connections dropped at the host firewall (`infra/victim/ds-firewall.sh`).
- Every decoy container: read-only root filesystem, all capabilities dropped, `no-new-privileges`, non-root, memory/CPU/PID limits.
- The control channel is **pull-only** — the platform never connects into customer infrastructure.
- Attacker input is logged as data and never executed, interpolated, or rendered unescaped.
- The LLM only explains. It never scores and never acts.

`npx lxs selftest` probes each decoy from the inside and posts the result to the dashboard's Containment panel.

> **Docker Desktop (macOS/Windows) runs containers inside a VM where the host firewall rules cannot be applied.** Development there is fine; the containment *claim* is not. `selftest` reports this honestly rather than passing. Run it on the Linux demo host before making the claim.

---

## Status

Phases 0–7 and the LLM narrator are built. The narrator has been tested against a stand-in
provider, not yet a real one: set a real `LLM_API_KEY` to turn it on. Not done: real auth,
notifications, and proving containment on Linux. See **`docs/PROGRESS.md`** for where
things stand against the plan and what is left, in the order worth doing it.

# LXS Development & Operations Command Reference

A comprehensive cheat-sheet of all commands required during development, testing, simulation, and troubleshooting.

---

## 1. Quick Start & All-in-One Commands

| Command | Description | Ports |
|---|---|---|
| `pnpm dev:all` | **Recommended Dev Mode**: Starts Postgres, API, SOC Dashboard, Attacker API, and Attacker Web | `:8080`, `:3000`, `:3002`, `:6060` |
| `pnpm dev` | Starts Postgres, API, and SOC Dashboard (no attacker console) | `:8080`, `:3000` |
| `pnpm demo` | Full end-to-end demo orchestrator: builds images, starts containers, migrates, seeds, and verifies thin-slice | `:8080`, `:3000`, `:3001`, `:3002`, `:6060` |
| `pnpm demo:status` | Shows status of all running services, healthy sensors, and active incidents | — |
| `pnpm demo:down` | Gracefully stops all demo containers | — |

---

## 2. Starting Services Individually

If you prefer running components in dedicated terminal tabs:

### Platform API (`:8080`)
```bash
# Start Postgres first (required)
pnpm platform:up

# Start the Fastify API with hot reload
pnpm --filter @lxs/api dev
```

### SOC Dashboard (`:3000`)
```bash
# Standalone Next.js 15 app
cd apps/dashboard
npm run dev

# Or build & run production server (faster navigation)
npm run build && npm start
```

### Attacker Demo (`:6060` and `:3002`)
```bash
# Terminal 1 — Attacker API (:6060)
cd attacker-demo/attacker-api
npm start

# Terminal 2 — Attacker Console (:3002)
cd attacker-demo/attacker-web
npm run dev
```

### Protected Example App (Acme Shop on `:3001`)
```bash
cd examples/acme-shop
pnpm dev
```

---

## 3. Database Operations (PostgreSQL)

PostgreSQL 16 runs in Docker at `127.0.0.1:5432` (`user: lxs`, `password: lxs`, `db: lxs`).

```bash
# Start Postgres container only
pnpm platform:up

# Stop platform containers
pnpm platform:down

# Run Drizzle migrations
pnpm db:migrate

# Seed demo organisation, 'acme-shop' project, and deterministic dev key
pnpm db:seed

# Generate Drizzle migrations from schema changes
pnpm --filter @lxs/api db:generate

# Connect directly to Postgres CLI
docker exec -it lxs-platform-postgres-1 psql -U lxs -d lxs
```

> **Default Dev Ingest Key:**  
> `ds_dev_0000000000000000000000000000000000000000`  
> *(Deterministic key seeded for local development)*

---

## 4. Testing, Type Checking & Linting

### Monorepo-Wide Checks (Turbo)
```bash
# Run all unit and golden tests across all packages
pnpm test

# Run TypeScript typecheck across all workspaces
pnpm typecheck

# Check formatting and linting rules (Biome)
pnpm lint

# Auto-format and apply safe fixes (Biome)
pnpm format

# Build all packages and SDK
pnpm build
```

### Package-Specific Tests
```bash
# Run detection engine tests & golden scoring suites
pnpm --filter @lxs/detection test

# Run SDK unit tests
pnpm --filter lxs test

# Run End-to-End scenario integration test
node --test tests/e2e/scenarios.test.ts
```

---

## 5. Attack Simulator (No Docker Needed)

The simulator sends synthetic events directly to the Ingest API endpoint. Use it to test incident scoring and detection without spinning up Docker decoys.

```bash
# Simulated PS04 Attacker (escalates from Low -> Critical)
pnpm demo:simulate ps-attacker

# Background noise (port scans, brute-force bots -> filtered as noise)
pnpm demo:simulate noise

# Opportunistic crawler scan
pnpm demo:simulate opportunistic

# Honeytoken leak & misuse
pnpm demo:simulate honeytoken

# SQL injection attack scenario
pnpm demo:simulate sqli
```

---

## 6. Decoys & Sensor Stack (Docker)

### Building Decoy Docker Images
```bash
docker build -f images/agent.Dockerfile           -t lxs/agent:0.1.0 .
docker build -f images/decoy-web.Dockerfile       -t lxs/decoy-web:0.1.0 .
docker build -f images/cowrie-personas.Dockerfile -t lxs/cowrie-personas:0.1.0 .
```

### Compiling & Verifying Decoys (SDK CLI)
```bash
cd examples/acme-shop

# Compile decoy.config.ts into lxs.compose.yml and .lxs/ assets
npx lxs build

# Check if generated compose files are up-to-date (used in CI)
npx lxs build --check

# Bring up protected app + decoy containers
docker compose -f docker-compose.yml -f lxs.compose.yml up -d

# Verify honeypot containment (proves honeypots are isolated)
npx lxs selftest
```

---

## 7. Health Checks & Verification (cURL)

Quick checks to verify all services are responsive:

```bash
# Check Platform API health and readiness
curl -i http://localhost:8080/healthz
curl -i http://localhost:8080/readyz

# Check Attacker API health
curl -i http://localhost:6060/health

# Check Dashboard
curl -I http://localhost:3000

# Check Attacker Console
curl -I http://localhost:3002

# Check Protected App
curl -I http://localhost:3001

# Trip a web decoy manually (opens a Low severity incident)
curl -i http://localhost:3001/.env

# Hit the honeypot admin panel
curl -i http://localhost:3001/admin
```

---

## 8. Ports Reference & Troubleshooting

### Port Mapping

| Port | Service | Process / Container |
|---|---|---|
| `8080` | Platform API | Node (`@lxs/api`) or Docker (`lxs-platform-api`) |
| `3000` | SOC Dashboard | Next.js (`apps/dashboard`) |
| `3001` | Acme Shop App | Node / Docker (`examples/acme-shop`) |
| `3002` | Attacker Console UI | Next.js (`attacker-demo/attacker-web`) |
| `6060` | Attacker API | Express (`attacker-demo/attacker-api`) |
| `5432` | PostgreSQL Database | Docker (`lxs-platform-postgres-1`) |
| `22` | Cowrie SSH Honeypot | Docker (`cowrie`) |

### Troubleshooting Port Conflicts

Check which processes are listening on the project ports:
```bash
lsof -nP -iTCP:8080 -iTCP:3000 -iTCP:3001 -iTCP:3002 -iTCP:6060 -iTCP:5432 -sTCP:LISTEN
```

Kill an orphaned process holding a port:
```bash
# Example: kill process on port 8080
kill -9 $(lsof -t -iTCP:8080 -sTCP:LISTEN)
```

If Docker is holding port 8080:
```bash
docker stop lxs-platform-api-1
```

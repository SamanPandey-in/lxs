
---

## 2. Product scope and requirements

### 2.1 Scope tiers

**Core MVP** — the demo and the product do not work without these. Never cut.

| ID | Feature |
|---|---|
| F1 | SDK config API: `new LXS()`, `create()`, `asset()` |
| F2 | Parser CLI: `init`, `build`, `build --check` |
| F3 | Generated sensor stack: `ds-agent`, `ds-web` (web-admin + web-bait templates), `ds-ssh` (Cowrie) with containment |
| F4 | Runtime middleware (Express + Fastify): decoy routing, real-asset signals, block enforcement |
| F5 | Agent: tail, normalise, batch, ship, register, heartbeat, policy poll, local socket for the app |
| F6 | Ingest API with project-scoped Bearer keys |
| F7 | Detection engine: tag, correlate by source, rules R01–R18, ATT&CK, six-stage kill chain, scoring, three labels |
| F8 | Incidents (attack chains) and attacker profiles |
| F9 | Live stream (SSE) and the core dashboard screens: Overview, Live feed, Incident queue, Incident detail, Attacker profile |
| F10 | Response: Block source (real, expiring, reversible), Export IOCs (JSON/CSV), incident status changes, audit log |
| F11 | LLM narration with template fallback |
| F12 | Accounts, single-owner organisation, projects, ingest key management, onboarding wizard |
| F13 | Attack simulator (noise, opportunistic, targeted personas) and a deterministic replay mode |
| F14 | Demo customer app ("Acme Shop": Express, real `/api/payments`) |
| F15 | Containment self-test (`npx lxs selftest`) and the Containment panel |

**Essential supporting** — build after the thin slice works, in this priority order. The cut list (§11.6) removes them from the bottom up.

| ID | Feature | Why it matters |
|---|---|---|
| E1 | Honeytokens + breadcrumb chain (fake API key planted in `/.env` and the SSH box; middleware detects its use) | Zero-false-positive proof of theft; S4 calls it the highest value per hour |
| E2 | ATT&CK heatmap and kill-chain progress bar | Speaks the SOC's language |
| E3 | Decoy health and staleness detection | An analyst must know when a sensor goes silent |
| E4 | Slack / generic webhook notification for High and Critical | Analysts do not stare at dashboards |
| E5 | Allowlist (CIDRs) for the customer's own scanners and monitors | Prevents self-inflicted alerts |
| E6 | Agent-side flood aggregation and ingest rate limits | Keeps internet noise from flooding the database |
| E7 | Production telemetry tail (agent tails a firewall/auth JSONL file) + seeded demo telemetry | Correlation with assets that are not HTTP routes (S1, S4) |
| E8 | STIX 2.1 bundle export | Standard threat-intel sharing (S4) |
| E9 | Redis decoy (RESP protocol, TypeScript) | Covers "exposed database" from the PS examples; first to cut (S1 put the decoy DB first on its cut list) |

**Advanced** — after the hackathon, before calling it production.

| ID | Feature |
|---|---|
| A1 | Team invites and roles (owner / analyst / viewer), email verification, password reset |
| A2 | Durable on-disk spool in the agent; agent version-skew warnings |
| A3 | Fingerprint correlation beyond IP (HASSH, signed cookie + UA for web sessions, credential reuse) |
| A4 | Full TTY session replay (Cowrie ttylogs → asciicast → xterm.js) |
| A5 | More decoys: fake Docker Engine API (S4's best fourth), fake IoT camera + Telnet, Postgres wire protocol |
| A6 | Threat-intel enrichment: offline GeoIP/ASN, reputation lookups |
| A7 | Sigma rule export; SIEM forwarding (Splunk HEC, Elastic) with ECS field mapping |
| A8 | More frameworks: NestJS, Koa, Hono, Next.js (Node runtime only) |
| A9 | Uploaded-file quarantine shipped to the platform (hash-named, mode 0400, never executed) |
| A10 | Email notifications and a weekly digest for managers |

**Future**

Kubernetes/Helm sensor · multi-region hosted SaaS · SSO/SAML · Postgres row-level security · columnar analytics store · billing · remote agent configuration · automated response playbooks with approval workflows · S4's shadow-clone session routing.

**Explicitly excluded from the initial build**

| Excluded | Reason |
|---|---|
| Billing, subscriptions, plans | Scores nothing; adds days |
| "Isolate host" and real firewall/EDR/NAC integrations | No safe mechanism in scope; simulated buttons erode trust |
| LLM-driven scoring or autonomous response | Non-deterministic; prompt-injectable by attacker input |
| Any component with access to the Docker socket at runtime | Root-equivalent on the host (S4 Fix 1) |
| High-interaction honeypots (real VMs or real shells) | Isolation risk is far higher; emulation is enough to catch and characterise |
| Edge/serverless runtimes for the middleware | No Unix sockets, no long-lived policy cache |
| Shadow-clone routing of web sessions | Risk of real users seeing fake data; needs app cooperation (C17) |
| GeoIP map | On both S1's and S4's cut lists; text country is enough if enrichment lands |

### 2.2 Feature specifications (core MVP)

Complexity is in **focused person-hours for an AI-assisted TS developer** (S ≤ 3 h, M 3–8 h, L > 8 h).

| Feature | Purpose / why needed | How it works | Depends on | Inputs → outputs | Interacts with | Complexity |
|---|---|---|---|---|---|---|
| F1 SDK config API | Lets developers declare decoys in code (diagram step 2) | Typed `create(type, mount, options)` overloads validate with zod into an in-memory registry; `asset()` names sensitive real routes | Shared schema package | Declarations → `DecoySpec[]`, `AssetSpec[]` | F2, F4 | S (2 h) |
| F2 Parser CLI | Turns declarations into deployable infrastructure (step 3) | Loads the config with `jiti`; validates; renders YAML from typed templates; writes manifest, Cowrie configs and honeytokens; deterministic output with a golden-file test | F1, image tags | Config → `lxs.compose.yml` + `.lxs/` | F3 | M (5 h) |
| F3 Sensor stack | The decoys themselves, safely contained (step 4) | `ds-web` (Fastify on a Unix socket, `network_mode: none`), `ds-ssh` (Cowrie persona image on an inbound-only bridge), `ds-agent` | Docker; persona image build | Attacker traffic → JSON log lines | F4, F5 | L (Cowrie persona 4 h, web decoys 5 h, compose hardening 3 h) |
| F4 Runtime middleware | Routes decoy paths into the container; reports known attackers touching real routes; enforces blocks | First middleware in the app; per request: blocklist check → decoy match → watchlist check → `next()`; talks only to the agent socket | F5 local socket | HTTP request → proxied stream / 403 / signal / pass-through | F3, F5 | M (6 h) |
| F5 Agent | The only credentialed bridge to the platform (step 5) | Tails log files with offset tracking, normalises, batches with retry/backoff, registers, heartbeats, polls policy, serves a local socket API to the app | F6 endpoints | Log lines → `POST /v1/ingest`; policy → local cache | F4, F6 | L (9 h) |
| F6 Ingest API | Trustworthy entry point for events | Bearer key → project; per-event zod validation; idempotent insert; enqueue; 202 | DB schema | Batches → stored events + job | F5, F7 | M (4 h) |
| F7 Detection engine | Turns events into meaning (between steps 5 and 6) | Pure functions `tagEvent()` and `evaluateChain()` from `packages/detection`, run in a worker under a per-source advisory lock | F6 | Events → detections, incident verdict | F8, F11 | L (10 h) |
| F8 Incidents and attackers | One attack chain per source; one profile per source | Upsert attacker by `(project, entity_key)`; open or extend an incident (24 h inactivity window); store verdict and factors | F7 | Verdict → `incidents`, `attackers` rows | F9, F10 | M (4 h) |
| F9 Stream + core screens | Step 6 and the analyst's whole experience | SSE hub on LISTEN/NOTIFY; React SPA with TanStack Query | F8 | Notifications → UI | F10, F11 | L (16 h across screens) |
| F10 Response | Detection must lead to action | Actions API writes blocklist + policy version + audit; agent polls; middleware enforces; agent acks the applied version | F4, F5 | Click → 403 at the app | F9 | M (5 h) |
| F11 LLM narration | Plain-English explanation (steps 7–8) | Debounced job; fact sheet; strict JSON; cache; template fallback | F8 | Fact sheet → summary JSON | F9 | M (4 h) |
| F12 Accounts / projects / keys | Step 0; replaces the seeded dev key | Better Auth email/password; projects CRUD; key create/revoke | DB | Sign-up → session; key → hash | F6, F9 | M (5 h) |
| F13 Simulator + replay | Repeatable demo traffic; demo never depends on luck | TS personas (ssh2 client, fetch); replay posts recorded fixtures through the real ingest path with `simulated: true` | F3, F6 | Scenario → real or replayed events | All | M (6 h) |
| F14 Demo app | A real customer app to protect | Express "Acme Shop" with `/`, `/login`, `/api/payments`, `/api/users`; real API-key auth so honeytokens can be "used" | F4 | — | F4 | S (2 h) |
| F15 Self-test + panel | Containment is a PS objective and a judge question | CLI runs `docker exec` probes and `docker inspect` checks, prints PASS/FAIL, posts a report the dashboard shows | F3 | Probes → report | F9 | M (4 h) |

### 2.3 Missing requirements and technical gaps (and how this document closes them)

| # | Gap | Resolution | Section |
|---|---|---|---|
| G1 | No onboarding or key issuance in the diagram | Step 0 wizard | §1.6, §6 |
| G2 | How does `/admin` on the customer's domain reach a container? | Middleware streams the request over a Unix socket to `ds-web` | §5.7 |
| G3 | Where does the Bearer key live? | Only in `ds-agent`'s environment, loaded from a git-ignored env file | §5.16, §9.2 |
| G4 | No processing step drawn between 5 and 6 | Worker-based detection pipeline | §8.4 |
| G5 | No response loop drawn | Pull-based policy: platform → agent → middleware | §5.7, §8.7 |
| G6 | Source-IP fidelity: reverse proxies, NAT/CGNAT, and the local-demo problem where every simulated attacker appears as the same IP | Trusted-proxy config; IP as MVP entity key with fingerprints stored for later; attackers run from separate machines in the demo; replay mode with documentation-range IPs | §5.7, §11.9 |
| G7 | Decoy health is invisible | Heartbeats, staleness job, health in the Containment panel | §7.8 |
| G8 | "Touched a real asset" needs a data source | SDK watchlist signals + optional telemetry tail + honeytokens | §5.7, §7.6 |
| G9 | Credentials and personal data captured by decoys (a real employee may type a real password into the fake `/admin`) | Clear text only for passwords in a bundled common-credentials list; otherwise salted hash + masked form (S4 A9); cookies and Authorization headers stripped before reaching decoys | §7.13 |
| G10 | Floods and cost (brute-forcers, LLM spend) | Agent aggregation, per-key rate limits, LLM only per incident with debounce and a daily cap | §9.2 |
| G11 | Versioning across SDK, agent image and API | Event schema version, agent version in User-Agent, compatibility matrix | §5.15 |
| G12 | Apps not running under Docker Compose, and Docker Desktop on macOS | MVP supports Compose on Linux hosts; Docker Desktop for development with documented isolation caveats | §7.10, §14.4 |
| G13 | Decoy paths that collide with real routes | Fastify: hard error via `hasRoute`; Express: best-effort warning; the middleware is mounted first so the decoy wins | §5.11 |
| G14 | Data retention | Per-project retention, purge job | §7.13 |
| G15 | Prompt injection through attacker-typed commands | Quoted data, strict schema, no tools, advisory only | §7.12, §8.4 |
| G16 | Clock skew between hosts | Store sensor time and `received_at`; order by sensor time within a session, by `received_at` across hosts | §8.5 |

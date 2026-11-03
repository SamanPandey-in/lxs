# LXS decoy roadmap

This document describes which decoys LXS can deploy today and a staged plan for adding protocol coverage. A decoy improves visibility and detection; it does not replace patching, authentication, authorization, network segmentation, or incident response.

## What is supported today

| Capability | State today | Notes |
|---|---|---|
| `web-admin` | Deployable | Fake admin login, panel, and export route, routed by the application SDK to the isolated web-decoy service. |
| `web-bait` | Deployable | Fake secret/config/backup paths. A SQL dump or a fake `postgres://` URL in a bait file is data, not a database server. |
| `ssh` | Deployable | Cowrie SSH persona, with JSON events tailed by the agent. |
| Honeytokens | Deployable data/signals | Fake values can be planted in decoys. A read is recorded; use of a recognized token by the protected app can trigger a high-confidence detection. Honeytokens are not listening services. |
| Redis | Deployable low-interaction sensor | A bounded RESP2 service returns synthetic key names and records command names, authentication outcomes, and source addresses. It never executes Redis persistence, replication, scripting, or configuration actions. |
| PostgreSQL wire-protocol server | Deployable synthetic service | A dedicated disposable PostgreSQL container uses a separate host port, fake database and restricted fake role; its bootstrap superuser is disabled after seeding. The first implementation records connection and authentication events; statement logging stays disabled to avoid retaining attacker supplied SQL literals. The platform database is never reused. |
| Other protocols | Not implemented | No deployable Docker API, Kubernetes API, SMB, RDP, DNS, FTP, SMTP/IMAP, SNMP, or VNC decoy is present. |

Relevant current code: [`DecoySpec`](../sdk/lxs/src/types.ts), [`create()`](../sdk/lxs/src/create.ts), [`cli/build.ts`](../sdk/lxs/src/cli/build.ts), the shared [`DecoyEvent` schema](../packages/schema/src/event.ts), and the existing advanced-decoy list in [`BREAKDOWN.md`](BREAKDOWN.md).

## Implementation rules for every new decoy

Every protocol should use the same product path. Do not call a protocol supported merely because its name appears in an enum or SDK type.

1. **Define a typed declaration.** Add an explicit decoy type, options, validation, stable ID rules, port-conflict checks, and generated manifest shape. Keep web mounts and network ports distinct in the API.
2. **Generate an isolated service.** Give each sensor a generated Compose service, resource limits, non-root identity where supported, read-only config, bounded logs, and no Docker socket or host filesystem mounts. Place network decoys on a trap network with no outbound route and no access to platform or customer networks. Publish only the intended listener port.
3. **Keep credentials and data synthetic.** Use generated bait credentials and synthetic records. Never copy production data, production credentials, database URLs, or usable customer API keys into a decoy.
4. **Emit structured, bounded events.** Include stable event IDs, timestamps, source address, decoy ID, protocol, event kind, and outcome. Normalize credentials and attacker-controlled text using existing masking/hash rules; cap field lengths, event volume, and log storage.
5. **Use the agent as the only platform credential holder.** The agent tails or receives decoy logs, normalizes them to `DecoyEvent`, batches and retries them, and sends them to `/v1/ingest`. A decoy container must not contain the project ingest key.
6. **Connect events to detection and UI.** Add rules only for useful behavior; correlate by project and source, preserve raw event evidence, and expose sensor health, events, incidents, attacker profiles, and applicable ATT&CK techniques.
7. **Prove containment and lifecycle.** Add tests for parser robustness, invalid frames, volume limits, restart/rotation, and event idempotency. Add a self-test for listener health and a network test that proves the decoy cannot reach platform/customer services or the public internet.
8. **Add a repeatable demo.** Add one deterministic simulator scenario and expected feed/incident results. Test both a low-signal touch and a meaningful interaction so the dashboard does not turn every port scan into a high-severity incident.

## Prioritized roadmap

Effort estimates are engineering days for one engineer familiar with this repository. Each estimate includes SDK/generator work, the sensor, agent normalization, API/schema and detection integration, tests, docs, and a demo update. It excludes production deployment and operational monitoring rollout. S = 2–4 days; M = 5–8; L = 9–15; XL = 16–25.

| Order | Follow-up | Value and telemetry | Demo impact | Effort |
|---:|---|---|---|---:|
| 1 | **Complete Redis verification/demo** | Add parser, invalid-frame, restart/rotation and event-volume coverage; sensor currently emits bounded command names and auth outcomes. | Add a deterministic real Redis-protocol interaction to the simulator and assert the resulting feed event. | Remaining: **M** |
| 2 | **PostgreSQL query telemetry** | Current native service reports connection/auth activity only. Add SQL command-class visibility through a protocol-aware sanitized collector; do not enable raw statement logging. | Add a `psql` discovery scenario whose sanitized query class appears in the feed without SQL literals. | Remaining: **L** |
| 3 | **Docker Engine API** | High impact for containerized environments: probes for unauthenticated API access, container creation, mounts, and privileged execution. | Strong infrastructure-compromise story; use a fake API response layer and show attempted container creation in the feed. | **L: 8–12 days** |
| 4 | **Telnet through Cowrie** | Low-cost legacy-protocol coverage for credential guessing and interactive shell behavior. Cowrie supports Telnet, but LXS currently disables it and has no separate Telnet declaration. | Reuses the existing persona and parser; adds a second port and a simple login scenario. | **S: 2–4 days** |
| 5 | **DNS canary service** | Useful for internal discovery and lookups of seeded fake service names. It only sees queries directed to it; it is not passive monitoring of all DNS. | A scan scenario can query planted names and produce clear DNS events. The demo client must explicitly target the canary resolver. | **M: 5–8 days** |
| 6 | **SMB and RDP** | Good enterprise coverage for file-share discovery, credential attacks, and lateral movement. Treat them as separate integrations because their protocols and logging differ. | Makes the platform relevant to Windows-heavy networks; requires a scanner/client scenario and more demo setup than SSH or HTTP. | **L: 10–16 days each** |
| 7 | **FTP, SMTP/IMAP, SNMP, VNC, TFTP** | Broader legacy and device coverage. Pick protocols based on user deployments and observed attacks instead of enabling every listener by default. | Adds breadth, but each listener needs its own concise scenario and dashboard presentation. | **M: 5–8 days each** |
| 8 | **Kubernetes API** | Valuable for cluster discovery and attempted workload/secret access in Kubernetes deployments. | High-impact cloud-native demo, but it should follow Docker API and a clear cluster-isolation design. | **L: 10–15 days** |

The protocol list is intentionally a roadmap, not a recommendation to expose all ports at once. OpenCanary's official configuration guide is a useful reference for common low-interaction protocol families (FTP, Git, HTTP(S), MySQL/MSSQL, Telnet, SNMP, SIP, VNC, Redis, TFTP, NTP, and others): [supported services](https://github.com/thinkst/opencanary/blob/master/docs/starting/configuration.rst). Cowrie documents its SSH and Telnet honeypot modes: [Cowrie project](https://github.com/cowrie/cowrie).

## PostgreSQL decoy: detailed plan

There is **no PostgreSQL service decoy today**. The production platform database is a private control-plane dependency. The PostgreSQL URI shown in fake files is only bait content. The planned decoy must be a distinct, synthetic target.

### Design choice

For the first release, prefer a dedicated PostgreSQL container with a synthetic database and a restricted fake role over implementing the wire protocol from scratch. The real server provides protocol fidelity; the dedicated container remains disposable and isolated. Do not reuse the platform database, its credentials, volumes, network, or `DATABASE_URL`.

Use a distinct demo listener such as host port `5433` mapped to container port `5432`; platform Postgres remains on its own private port/network. Keep the honeypot on the trap network, with no egress and no route to the platform or shop. Seed only fake database names, tables, and records. Do not grant the ordinary fake account superuser, filesystem, replication, or untrusted-extension privileges.

PostgreSQL supports JSON log output and connection logging, which can feed the agent's structured event pipeline. Configure connection/authentication logging and a bounded JSON log volume. Query statements can contain sensitive literals, so the agent must redact or normalize SQL before it is retained in the platform. Do not store passwords or unrestricted raw query values. See PostgreSQL's [logging documentation](https://www.postgresql.org/docs/current/runtime-config-logging.html), including its JSON log format and warning that logged statements may expose sensitive data.

### Steps

1. **Freeze the behavior contract.** Pick the persona (for example, fake `shop_prod` with synthetic `users`, `payments`, and `sessions` tables), fake roles, auth behavior, ports, and which actions are logged. Define what is deliberately unsupported; never execute host commands or connect to a real database.
2. **Add first-class SDK/config support.** Add `postgres` to `DecoySpec`, `create()`, zod options, manifest validation, unique-port validation, CLI descriptions, and generated Compose output. Add optional persona/seed choices and a safe listener port. Keep this separate from the platform's own DB configuration.
3. **Build the sensor image.** Add a pinned PostgreSQL image/config with synthetic seed data, restricted roles, connection limits, statement/time limits, bounded JSON logs, resource caps, and a read-only config/seed mount. Use an ephemeral data volume; never persist attacker writes as trusted state.
4. **Contain it.** Publish only the configured honeypot port. Put it on the trap network with outbound routing disabled. Test that it cannot resolve/reach the platform DB, shop, Docker socket, host filesystem, or internet. Ensure the regular demo Postgres remains private and unaffected.
5. **Add agent collection and normalization.** Tail the PostgreSQL JSON log with rotation-safe offsets. Normalize events to existing connection/auth/database event types, and add a `postgres` sensor kind/protocol field where needed. Keep query text out by default; emit command class, normalized fingerprint/table name where safe, outcome, and a redacted bounded excerpt only when explicitly configured.
6. **Integrate ingest and detection.** Confirm sensor ownership and project attribution through the normal ingest key path. Add rules for repeated auth failure, successful access, schema enumeration, sensitive-table reads, role/privilege changes, and suspicious file/replication/extension commands. Make low-signal connection attempts visible without automatically creating a high-severity incident.
7. **Expose health and evidence.** Show the Postgres decoy as a sensor in Decoys & containment, list connection/auth/query events in Live feed and incident detail, and attach the same source profile used by other decoys. Include the SQL behavior in incident evidence while ensuring literals and credentials are redacted.
8. **Add repeatable tests and demo.** Test valid and malformed protocol startup, wrong and valid synthetic credentials, representative read/write/privilege commands, query redaction, log rotation, agent restart, duplicate delivery, ingest attribution, rate limits, and network containment. Add a simulator path that connects to the honeypot and attempts a synthetic database discovery sequence.
9. **Operational rollout.** Apply resource and connection limits, add per-sensor/project ingest quotas, monitor event volume and disk usage, pin image digests, document port/firewall requirements, and verify a safe rollback that removes only the decoy service and its disposable volume.

## Demo guidance

Keep the demo on a small number of connected signals rather than a port-scan catalog:

1. Probe a web bait file or admin route.
2. Connect to the SSH persona and run a short discovery sequence.
3. Try the PostgreSQL decoy using the fake URL planted in the bait file; query only synthetic records.
4. Use a planted honeytoken against the real demo app to demonstrate the high-confidence distinction between **reading bait** and **using a stolen value**.
5. Show the resulting event chain in Live feed, the incident and attacker profile, and the ATT&CK matrix where detections support technique mapping.

For a first public demo, implement Redis completion and the PostgreSQL decoy before adding SMB/RDP or Kubernetes. Keep every decoy's host port explicit in the demo instructions, and never expose the platform database or real customer services as a honeypot.

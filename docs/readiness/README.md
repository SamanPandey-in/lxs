# LXS: demo readiness audit and deployment plan

**Audited:** 31 Oct 2026, 16:35–17:05 IST, commit `2eb7661` · **Demo deadline:** 18:00 IST

**Verdict: NO-GO for a public AWS deployment as the code stands. GO for the demo if the 8 must-fix items in [section 2](#2-must-fix-before-the-demo) are finished.** If they aren't finished by 17:35, use the [fallback](#10-go--no-go).

No application code was changed in this audit, so **every finding below is still open**. Each one has an owner in [section 7](#7-four-person-split).

## Evidence labels

| Label | Meaning |
|---|---|
| **Measured** | Run during this audit, against a throwaway local Postgres and API |
| **Code** | Clear from reading the source, but not executed |
| **Suspected** | A risk to check during rehearsal |

### What this audit did not cover

- **AWS VM and Render:** neither was accessed. The AWS figures are estimates, and the Render assessment uses Render's published limits, not a test deployment.
- **Live decoy chain:** the Cowrie and web decoy containers were not run. Scores below came from the simulator and replay endpoint, so **`noise` and `ps-attacker` have not been confirmed against live decoys**.
- **Builds:** the dashboard production build and the agent, decoy-web and Cowrie images were not rebuilt.
- **File coverage:** security-critical code and all deployment files were read line by line. The other modules were checked through their tests and pattern searches, not line by line. These include the dashboard pages, `incidents.ts`, `events.ts`, `insights.ts` and most of the SDK generators.

---

## 1. Current state

### Test results

| Category | Total | Passed | Failed | Notes |
|---|---:|---:|---:|---|
| `packages/detection` | 28 | 28 | 0 | Golden scores |
| `apps/agent` | 23 | 23 | 0 | |
| `sdk/lxs` | 21 | 21 | 0 | |
| `packages/schema` | 11 | 11 | 0 | |
| `apps/decoy-web` | 11 | 11 | 0 | |
| `packages/normalizer` | 9 | 9 | 0 | |
| `apps/simulator` | 6 | 6 | 0 | |
| **Unit total** | **109** | **109** | **0** | Measured |
| `apps/api` | 0 | – | – | The test script is `echo "no tests yet"`, so auth and ingest have **no tests** |
| `apps/dashboard`, `attacker-demo` | 0 | – | – | No tests exist |
| `tests/e2e` (API scenarios) | 1 file | 0 | **1** | **This is the failing test.** See below |
| `tests/e2e` (Playwright) | 0 | – | – | No spec files exist |

| Check | Result |
|---|---|
| Typecheck | 13 of 13 packages pass |
| Lint on this Windows checkout | 197 errors, 195 of them caused by CRLF line endings |
| Lint on the same commit with LF endings | **2 real errors:** `apps/api/src/modules/demo.ts`, `apps/dashboard/app/decoys/page.js` |
| `images/api.Dockerfile` | Builds at 353 MB, and `@lxs/detection` loads inside the image. `pnpm start` was not run in the container |

### Why the e2e test fails

The fixes must be made together, because each problem hides the next one:

1. `tests/e2e` is missing from `pnpm-workspace.yaml`, so `tsx` can't be found (`ERR_MODULE_NOT_FOUND`) and `pnpm --filter @lxs/e2e` matches nothing.
2. `skip: !apiUp` is evaluated before `before()` runs, so the tests would **always skip**, even with the API running.
3. The test uses the slug `acme-shop`, but the route needs a UUID. Measured result: 404.
4. It sends a Bearer ingest key to routes that only accept session cookies.
5. It sends `reset: true`, which the API ignores, so incidents from earlier scenarios remain and the count assertions can't hold.

### Scenario scores (Measured, through the simulator and real ingest)

| Scenario | Expected | Actual | Match |
|---|---|---|:---:|
| `noise` | 23 · Low · noise | 23 · low · noise | Yes |
| `ps-attacker` | 100 · Critical · targeted, 19 events | 100 · critical · targeted, 19 events | Yes |
| `opportunistic` | 65 · High · opportunistic | 65 · high · opportunistic | Yes |
| `honeytoken` | 75 · Critical · targeted | 75 · critical · targeted | Yes |

These also passed (Measured): duplicate events are rejected, a tampered cookie gets 401, an invalid ingest key gets 401, and malformed JSON gets 400.

---

## 2. Must fix before the demo

| ID | Sev | Problem | Evidence | Fix | Owner | Min |
|---|---|---|---|---|---|---:|
| **D1** | P0 | **The dashboard can show fake data, including a fake successful block.** Any 401, 403, 5xx or timeout over 2.5 s switches it to mock data, and POST actions return mock success too. A judge would be watching invented data, marked only by a small badge. | Code: `apps/dashboard/lib/core.js:39,84,210` | Never mock POST/PATCH/DELETE calls: show the error. Allow mock data only with `LXS_ALLOW_MOCK=1`. Raise the timeout to 8 s. Show a full-width red banner in mock mode. | P4 | 15 |
| **D2** | P0 | **The default API setup allows forged admin sessions.** Compose defaults to `NODE_ENV=development` and a session secret published in the repo, so the production check never runs. | **Measured:** a forged cookie got 200 on `/v1/me` | Require `SESSION_SECRET` in compose with no default, and set `NODE_ENV=production` | P3 | 5 |
| **D3** | P0 | **Auth bypass runs in production.** With `DEV_AUTH_BYPASS=true`, anyone who can reach the API is the owner. The dashboard has **no login page**, so turning bypass off leaves it on mock data (see D1). | **Measured:** anonymous request got 200 on `/v1/me`, and 202 adding a block | For today, keep bypass on but **limit ports 3000 and 8080 to the presenter's IP**. See [section 5](#5-aws-deployment). | P3 | 5 |
| **D4** | P0 | **The public dev ingest key is seeded automatically.** The key is in the README, and anyone holding it can inject fake incidents. | Code: `seed.ts:55`. Measured: ingest accepted it | Create a real key after seeding, revoke the dev key, and keep port 8080 closed to the public | P3 | 5 |
| **D5** | P0 | **The attack console says "blocked" before any block happens.** A failed SSH password matches the "refused" check, so every brute-force attempt displays `Connection refused — You have been blocked by LXS`. | Code: `ssh-attacker.js:23,109` | Remove `All configured authentication methods failed` from the regex, and treat it as a normal failed login | P4 | 5 |
| **D6** | P0 | **The safe-mode fallback doesn't work.** `demo.mjs` doesn't set `PLATFORM_PROJECT_ID`, replay failures are hidden, and the console still animates success with nothing reaching the dashboard. `honeytoken` and `sqli` are also rejected. | Measured: both scenarios get a validation error. Code: `safe-mode.js:21,36`, `demo.mjs:316` | Set the project ID, show failed replays as errors, and hide unsupported scenarios in safe mode | P4 | 10 |
| **D7** | P0 | **Moving the SSH decoy onto port 22 can lock you out of the VM,** or fail because `sshd` already holds the port. | Code: `decoy.config.ts:21` | Use host port **2222** today and set `TARGET_SSH_PORT=2222` | P3 | 5 |
| **D8** | P0 | **The dashboard can't be deployed the same way as the rest.** It has no Dockerfile or compose service, and no restart policy. | Code: `images/`, `docker-compose.platform.yml` | Quickest route: run `next start` under `systemd` with `Restart=always`. Add a Dockerfile afterwards. | P3 | 10 |

### Demo script corrections (P4, 5 minutes)

Judges may ask about each of these, so the script must match what the product does:

| Script says | What is true | Say instead |
|---|---|---|
| "AI summary", "the LLM explains" | There is no LLM. Summaries are deterministic templates, labelled **Template** | "A deterministic template summary. The LLM narrator is planned." |
| "The self-test proves it, and it ran today" | The last recorded result is 10 of 13 on Docker Desktop | Say this only after `selftest` passes on the VM |
| Blocks happen "within one poll interval" | Up to about 7 s (agent 5 s + SDK 2 s), and only in the HTTP middleware (Code) | Wait 8 s before retrying. **The SSH decoy still accepts a blocked IP** |
| Noise uses an `nmap` user agent on `/backup.sql` | The scenario defines Masscan and `/wp-login.php`, and `run-scenario.js` **never sends scenario headers** | Pass `step.headers` to `sendHttp`, then update the script |
| 23 · Low · Noise | Measured with the simulator only, and the live noise paths differ | Rehearse live and use whatever score you actually get |

---

## 3. Must fix before AWS exposure

| ID | Sev | Problem | Evidence | Fix | Owner | Min |
|---|---|---|---|---|---|---:|
| A1 | P1 | **Login rate limiting can be bypassed.** `trustProxy: true` means a spoofed `X-Forwarded-For` header counts as a new IP. It also falsifies audit-log IPs. | **Measured:** 25 of 25 attempts got through with rotating headers. Without spoofing, the limit started at attempt 21 | Make it `TRUST_PROXY` from env, default off | P1 | 5 |
| A2 | P1 | **Losing the database kills the API, and it doesn't recover.** | **Measured:** `TypeError ... reading 'write'` in `postgres/connection.js:255`; `/healthz` was still unreachable after Postgres restarted | Run it under a restart policy (D8 pattern), and add a logged exit on uncaught exceptions | P1 + P3 | 10 |
| A3 | P1 | **The attack console's target allowlist can be escaped.** `/http` checks the configured target, then builds the URL from the caller's `path`, so an absolute URL goes anywhere. It also has no auth and open CORS, so any website open in the presenter's browser could drive it. | **Measured:** `new URL('http://169.254.169.254/...', base)` resolves to the metadata address | Reject absolute paths, check the final hostname, add a shared token, bind to `127.0.0.1` locally, limit CORS | P4 | 15 |
| A4 | P1 | **Containment is unproven.** It's a headline claim, and `ds-firewall.sh` has never run on Linux. | `docs/PROGRESS.md` | Run the firewall script and `selftest` on the VM (see [section 5](#5-aws-deployment)) | P3 | 10 |
| A5 | P1 | **Local live mode splits one attacker into two.** `pnpm demo` gives HTTP a simulated IP, but SSH uses the real one, so the chain can't form one incident. AWS uses the real IP for both, so it isn't affected. | Code: `demo.mjs:264`, `ssh-attacker.js:44` | Don't use local live mode for Beat 2. Leave `DS_DEV_SIM` off | P4 | 2 |
| A6 | P1 | **Noise and attack traffic from one IP merge into one incident,** so the noise label disappears. | Code: `process-events.ts:84` | Send noise from Render, and attack from your laptop | P4 | – |
| A7 | P1 | **There is no way to reset demo data.** Reruns add to the same incident, and blocks persist. | Code: no reset script | Add `scripts/reset-demo.sql` to clear demo rows (back up first) | P4 | 10 |
| A8 | P2 | **The seed allowlists `10.0.0.0/8`.** Traffic from inside a `10.x` network creates no incidents and can't be blocked. | Code: `seed.ts:49` | Attack from outside the VPC, or clear the list | P3 | 2 |

---

## 4. Other hardening, after the demo

| ID | Sev | Issue | Evidence | Owner |
|---|---|---|---|---|
| H1 | P1 | Add `apps/api` tests for auth, roles, ingest and replay | Measured: none exist | P2 |
| H2 | P1 | Add a real login page, then disable the bypass | Code | P1 + P4 |
| H3 | P2 | Add `.gitattributes` with `* text=auto eol=lf`, and format the 2 files | Measured | P2 |
| H4 | P2 | Reject event timestamps far in the future | Measured: a `2099` timestamp was accepted | P1 |
| H5 | P2 | Add security headers. Only `nosniff` is set today | Measured | P1 |
| H6 | P2 | `/v1/system` returns global counts to the owner of **any** org, and signup is open | Code: `system.ts:32` | P1 |
| H7 | P2 | `/readyz` works, but no alert fires when the worker stops | Code | P3 |
| H8 | P2 | The worker rereads the attacker's full history on every batch (O(n²)) | Code | P1 |
| H9 | P2 | The API image uses `--no-frozen-lockfile`, and the generated compose uses unpublished `ghcr.io/lxs/*` images | Code | P3 |
| H10 | P2 | Require IMDSv2 with hop limit 1, because the agent holds a credential on a bridge network | Suspected | P3 |
| H11 | P3 | Notification delivery is a stub, and `/test` sends nothing | Code | P1 |
| H12 | P3 | SSE connections aren't capped, and `CORS_ORIGINS=*` would allow any origin with credentials | Code | P1 |
| H13 | P3 | `ds_trap` uses `172.31.250.0/24`, inside the default AWS VPC range. Check with `ip route` | Suspected | P3 |
| H14 | P3 | CI runs the compose check with `continue-on-error`, and never runs e2e | Code | P2 |

**Looked sound in what was reviewed (Code):** scrypt password hashing and timing-safe comparison, parameterised SQL, CSV formula-injection escaping, the gzip size cap, 404s that hide other tenants' projects, and decoy input sanitising and hardening.

---

## 5. AWS deployment

### Sizing (estimates, not measurements)

| Component | RAM |
|---|---:|
| Postgres | 200 MB |
| API + worker (`tsx`) | 300 MB |
| Dashboard (`next start`) | 200 MB |
| Shop app | 100 MB |
| Agent, web decoy and Cowrie | 640 MB at their limits |
| **Total** | **about 1.4 GB, plus Docker and the OS** |

| Instance | Verdict |
|---|---|
| `t2.micro` / `t3.micro` (1 GB) | **Not suitable,** even with swap |
| `t3.small` (2 GB) | Works with 2 GB swap. Builds will be slow |
| **`t3.medium` (4 GB), 20 GB gp3** | **Recommended for today** |

Check your VM first:

```bash
nproc && free -h && df -h / && docker --version && docker compose version && ss -tlnp
```

### Security group

| Port | Source | Purpose |
|---|---|---|
| 2200 | Your team's IPs | Real SSH, only if you moved `sshd`. Otherwise keep 22 |
| 3001 | `0.0.0.0/0` | Shop app and web decoys (for attacker and Render) |
| 2222 | `0.0.0.0/0` | SSH decoy (for attacker and Render) |
| 3000 | **Presenter's /32 only** | Dashboard |
| 8080 | **Presenter's /32 only** | API, called by the browser |
| 5432 | **Never open** | Postgres stays on loopback |

Render's IPs are shared, so 3001 and 2222 are simplest left open. **Real internet scanners will find these ports,** so reset the data just before the demo. Any real scan that appears should be described as real background traffic.

### Run order

Do this on a branch that includes the section 2 fixes.

```bash
git clone <repo> lxs && cd lxs && corepack enable && pnpm install --frozen-lockfile
```

```bash
cp .env.example .env
```

Set these in `.env`:

```bash
NODE_ENV=production
SESSION_SECRET=<output of: openssl rand -hex 32>
POSTGRES_PASSWORD=<output of: openssl rand -hex 16>
DEV_AUTH_BYPASS=true
CORS_ORIGINS=http://<ELASTIC_IP>:3000
PUBLIC_URL=http://<ELASTIC_IP>:8080
LXS_API_URL=http://<ELASTIC_IP>:8080
DEMO_MODE=true
```

`DEV_AUTH_BYPASS=true` is only acceptable while the security group limits 3000 and 8080 to the presenter. **Change the `DATABASE_URL` password in `.env` to match.**

```bash
docker compose --env-file .env -f infra/platform/docker-compose.platform.yml up -d --build
```

```bash
docker build -f images/agent.Dockerfile -t lxs/agent:0.1.0 .
```

```bash
docker build -f images/decoy-web.Dockerfile -t lxs/decoy-web:0.1.0 .
```

```bash
docker build -f images/cowrie-personas.Dockerfile -t lxs/cowrie-personas:0.1.0 .
```

Seed the database, create a real ingest key in **Settings → Keys**, revoke the dev key, and paste the new key into `examples/acme-shop/.env.lxs`. Export `LXS_AGENT_IMAGE`, `LXS_WEB_IMAGE` and `LXS_COWRIE_IMAGE` with the tags above, because the generated compose otherwise pulls unpublished images. Then:

```bash
cd examples/acme-shop && npx lxs build && docker compose -f docker-compose.yml -f lxs.compose.yml up -d
```

```bash
sudo infra/victim/ds-firewall.sh && sudo infra/victim/ds-firewall.sh --check
```

```bash
cd examples/acme-shop && npx lxs selftest
```

The agent must reach the API through the Docker bridge gateway. Confirm that with a test request before moving on.

### Readiness checklist

- [ ] VM has at least 2 GB RAM and swap is configured
- [ ] Security group matches the table, and 5432 is unreachable from outside
- [ ] `/readyz` returns 200, and `/v1/system` shows `"detection":"package"`
- [ ] Dashboard shows **no** "Demo data" badge
- [ ] All decoys are green, with a recent heartbeat
- [ ] Source IPs on the dashboard match your laptop's public IP
- [ ] `selftest` passes (otherwise drop the containment claim)
- [ ] After a VM reboot, all services and firewall rules return. Persist the rules with `iptables-persistent`
- [ ] Rollback tested: `git checkout <last-good-tag>`, then rebuild with compose

**TLS:** today's demo uses plain HTTP, restricted by IP. Say so if asked. The Caddyfile only proxies the API, so TLS needs a domain and a dashboard route.

---

## 6. Render free-tier assessment

Based on [Render's free-tier docs](https://render.com/docs/free) and its [free-tier overview](https://render.com/articles/platforms-with-a-real-free-tier-for-developers-in-2026). Nothing has been deployed to test this.

**Verdict: suitable for triggering short noise runs. Not suitable for continuous noise or for hosting the platform.**

| Requirement | Status | Detail |
|---|---|---|
| Run `attacker-api` as a web service | **Supported** | It reads `PORT` and has `/health`. Free tier is 512 MB and 0.1 CPU, which should cover a 10-step run |
| Background worker or cron | **Requires paid plan** | Free instances are limited to web services, static sites, Postgres and Key Value |
| Continuous noise | **Supported with limitations** | Spins down after 15 minutes with no **inbound** traffic. Its own outbound traffic doesn't count |
| Wake-up | **Supported with limitations** | About 1 minute, so **wake it 2–3 minutes before the demo** |
| Uptime | **Supported with limitations** | 750 instance hours a month, and Render may restart it at any time |
| Outbound to 3001 and 2222 | **Supported** | Only ports 25, 465 and 587 are documented as blocked |
| Distinct source IP | **Supported with limitations** | Different from your laptop, which keeps noise separate. IPs are shared, so a run may show more than one IP |
| Persistent storage | **Not supported** | Not needed here |
| Environment variables | **Supported** | Used for targets and the token |
| High-volume traffic | **Not supported** | Services sending unusually high traffic may be suspended. Keep runs small |
| Hosting API + Postgres | **Requires an alternative** | Free Postgres has 1 GB, no backups and expires after 30 days. Keep this on AWS |

### Setup

- **Root directory:** `attacker-demo/attacker-api`
- **Build / start:** `npm install` / `npm start`
- **Environment:** `ATTACK_MODE=live`, `TARGET_APP_URL=http://<ELASTIC_IP>:3001`, `TARGET_SSH_HOST=<ELASTIC_IP>`, `TARGET_SSH_PORT=2222`, `ALLOW_TARGETS=<ELASTIC_IP>`, `ALLOW_PUBLIC=1`

**Do not deploy this until A3 is fixed.** Otherwise anyone who finds the URL can trigger traffic through it.

Trigger noise from your laptop, sending the shared token added in A3:

```bash
curl -X POST https://<service>.onrender.com/run -H 'content-type: application/json' -d '{"scenarioId":"noise"}'
```

**If Render fails:** run noise from a phone hotspot, which also gives you a different IP. Don't use the simulator without telling judges it is simulated.

---

## 7. Four-person split

**Each person owns only the paths in their row, so nobody edits the same files.** P4 is the integration owner and merges to `demo/final`. Each person works on a `fix/<id>` branch, and every pull request needs one reviewer.

| | Person 1: Backend | Person 2: Security and QA | Person 3: DevOps | Person 4: Integration and demo |
|---|---|---|---|---|
| **Owns** | `apps/api/src/**`, `packages/**` | `tests/**`, `apps/api/test/**`, `pnpm-workspace.yaml`, `.github/**`, `.gitattributes`, `docs/readiness/**`, the `test` line in `apps/api/package.json` | `infra/**`, `images/**`, `examples/acme-shop/**`, `.env.example`, VM, Render service | `attacker-demo/**`, `scripts/**`, `apps/dashboard/**`, `docs/DEMO-SCRIPT.md` |
| **Before the demo** | A1, A2 (crash handler), format `demo.ts` | Fix the e2e test. Verify D2–D4, A1 and A3 on the VM. Keep this file's statuses accurate | D2, D3, D4, D7, D8, A2 (restart), A4, A8 | D1, D5, D6, A3, A5, A6, A7, script corrections, rehearsal |
| **After** | H2 (API), H4, H5, H6, H8, H11, H12 | H1, H3, H14 | H7, H9, H10, H13 | H2 (login page) |
| **Done when** | `pnpm test` and typecheck pass; spoofed headers hit 429 | e2e runs without skipping and fails when it should; findings retested | Checklist in section 5 complete; reboot recovers | Rehearsal passes twice with no mock badge |

### Shared interfaces (agree these at the start)

| Interface | Agreed between | Contract |
|---|---|---|
| Env vars for the API | P1 ↔ P3 | P1 adds `TRUST_PROXY`, and P3 sets it in compose |
| Elastic IP and ports | P3 → P4 | P3 shares the IP as soon as it's assigned. Ports: 3000, 3001, 2222, 8080 |
| Attack console token | P4 → P3 | P4 adds `ATTACKER_TOKEN`, and P3 sets it on Render |
| Project ID and ingest key | P3 → P4 | Shared privately, **never committed** |
| Test fixes that need API changes | P2 → P1 | P2 opens an issue and P1 makes the change. For example, the e2e test needs a session login, not a Bearer key |

### Dependencies

`D2, D3, D4, D7, D8` (P3) → VM is reachable → `A4` and the Render deploy → rehearsal. `D1, D5, D6, A3` (P4) can start immediately, and A3 must merge before Render goes live.

---

## 8. Schedule

| Time | Who | What |
|---|---|---|
| 17:05–17:10 | All | Read section 2, agree the interfaces, and confirm the VM's instance type |
| 17:10–17:30 | P3 | Fix defaults, deploy to the VM, and run the firewall script and `selftest` |
| 17:10–17:30 | P4 | D1, D5, D6, A3, script corrections |
| 17:10–17:30 | P1 | A1, A2, format `demo.ts` |
| 17:10–17:30 | P2 | Fix e2e, and prepare retests |
| **17:35** | All | **Decision point: merge to `demo/final` and deploy. If the VM isn't healthy, use the fallback** |
| 17:35–17:45 | P4, P3 | Deploy Render noise and run a full rehearsal |
| 17:45–17:52 | P2 | Rerun tests and retest the fixes |
| 17:52–17:57 | P4 | Second rehearsal, **screen-record it**, then reset data |
| 17:57–18:00 | P4 | Wake Render and run the pre-flight check |

**Deferred past 18:00:** all of section 4, the LLM narrator, real login, TLS, notifications and full API tests. Don't attempt these today.

---

## 9. Demo validation

### Pre-flight

- [ ] Dashboard has no "Demo data" badge, and the incident queue is empty
- [ ] All decoys are green
- [ ] Attacker console shows `LIVE`, and Render `/health` responds
- [ ] Backup recording is open in another window

### Scenarios

Fill in **Actual** during rehearsal. **Nothing here has run on AWS yet.**

| # | Scenario | Start | Steps | Expected | Actual | Evidence | Recovery |
|---|---|---|---|---|---|---|---|
| 1 | Normal traffic | Clean data | Browse `/api/products` from a new IP | App responds, no incident | | Empty queue | – |
| 2 | Noise | Render awake | Trigger `noise` on Render | Low, labelled noise, from a Render IP, no page | | Noise tab, score | Use a hotspot |
| 3 | Targeted attack | Scenario 2 done | Run `ps-attacker` from the laptop | **One** incident, separate from noise, climbing to Critical, with the real-asset badge | | Incident, "Why?" ledger, ATT&CK chips | Switch to SAFE once D6 is fixed, and **say it is a replay** |
| 4 | Block | Scenario 3 done | Block, wait 8 s, request `/admin` | 403, audit row present, SSH decoy still open | | Blocked banner, audit log | Unblock in the dashboard |
| 5 | Failure and recovery | Rehearsal only | `docker restart` the API container | Dashboard shows an error, **not mock data**, and recovers | | Reconnect shown | `docker compose up -d` |

**Be open about what is simulated.** Attacks are run by your team against your own decoys, and replay and simulator events are marked `simulated`. Don't describe any of this as a real attack detected in production.

---

## 10. Go / no-go

| Option | Use it if | What you can claim |
|---|---|---|
| **A. AWS + laptop + Render** | All 8 must-fix items are done and scenario 3 passes twice | The full story, with containment only if `selftest` passed |
| **B. AWS + laptop, noise from a hotspot** | Render fails | The same story, with a different noise source |
| **C. Local, with replay** | The VM isn't healthy at 17:35 | Say "replaying recorded events", and **drop the containment claim** |
| **D. Recording** | Everything fails live | Say it's a recording from today's rehearsal |

**Current recommendation: NO-GO as the code stands, aiming for Option A,** with C as the fallback.

### Remaining risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| The live decoy chain may score differently | Only simulated and replayed scenarios were measured | Rehearse, and narrate the scores you see |
| 60 minutes is tight | Image builds on a small VM may be slow | Decision point at 17:35 |
| Bypass stays on today | IP restriction is the only protection | Check the security group, and stop the VM after the demo |
| Real scanners may reach the decoys | Unexpected incidents may appear | Reset just before the demo |
| Conference Wi-Fi may change the presenter's IP | Dashboard access would be lost | Use a hotspot, or update the rule beforehand |

### After the demo

Stop or terminate the VM, delete the Render service, and rotate every key and secret used today.

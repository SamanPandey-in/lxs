# Containment proof

LXS claims that its decoys are sensors and never a pivot. That claim holds only on Docker Engine on a
Linux host, because the host firewall rules (`infra/victim/ds-firewall.sh`) cannot apply inside
Docker Desktop's VM. This folder holds the evidence: dated `lxs selftest` outputs from a real Linux
host, named `selftest-<YYYY-MM-DD>.txt`.

Until a file like that exists here, the containment claim is "built, not yet proven". See
`docs/STATUS.md`.

## How the proof is produced

`.github/workflows/selftest.yml` runs on a schedule (Mondays 04:23 UTC) and on demand. On a
self-hosted Linux runner it:

1. installs the workspace and builds the SDK;
2. builds the five sensor images from the commit (`infra/victim/build-images.sh`), or, on a manual
   run with `images: registry`, uses the published `<IMAGE_NAMESPACE>/*:<sdk version>` images;
3. writes `examples/acme-shop/.env.lxs` and runs `lxs build`;
4. starts `docker compose -f docker-compose.yml -f lxs.compose.yml up -d`;
5. installs and checks the host firewall rules (`sudo ds-firewall.sh`, then `--check`);
6. runs `lxs selftest` **as root**, so the `DOCKER-USER + INPUT rules` check is counted rather than
   skipped;
7. uploads the output as the `selftest-<date>` artifact (always, pass or fail), and, if enabled,
   commits it here as `docs/containment/selftest-<date>.txt` (only on a pass);
8. tears the stack down (`down -v`) and deletes `.env.lxs` and `.lxs/secrets`.

The job is skipped unless the repository variable `SELFTEST_ENABLED` is `true`, so the workflow
does nothing until a runner exists.

## Registering the runner

Use a disposable Linux host that runs nothing else: the decoys on it are meant to be attacked.
An EC2 instance set up as in `infra/victim/DEPLOY-EC2.md` (steps 1 to 3) works. Docker Desktop does
not; the workflow refuses to run there.

1. **Host:** Ubuntu 24.04 or Amazon Linux 2023, at least 2 vCPU / 4 GB (`t3.medium`), Docker Engine
   with the Compose v2 plugin and `iptables`. `sudo bash infra/victim/ec2-bootstrap.sh` installs
   these on a fresh EC2 host. Use IMDSv2-only on EC2.
2. **Runner user:** create a dedicated user (for example `gha`), add it to the `docker` group, and
   give it passwordless sudo. The workflow needs root for `ds-firewall.sh`, `iptables -C` and the
   selftest run itself:

   ```bash
   sudo useradd -m -s /bin/bash gha
   sudo usermod -aG docker gha
   echo 'gha ALL=(ALL) NOPASSWD: ALL' | sudo tee /etc/sudoers.d/gha-runner
   sudo chmod 0440 /etc/sudoers.d/gha-runner
   ```

   That is broad, and acceptable only because the host is disposable and dedicated to this job.
3. **Free ports:** the example publishes 3001 (shop), 2222 (Cowrie), 6380 (Redis decoy) and 5433
   (Postgres decoy) on the host. Nothing else may hold them.
4. **Register the runner:** in GitHub, **Settings → Actions → Runners → New self-hosted runner →
   Linux**, then follow the shown `config.sh` commands as the `gha` user. Keep the default labels
   (`self-hosted`, `Linux`, `X64` or `ARM64`); the workflow targets `[self-hosted, linux]`. Install
   it as a service (`sudo ./svc.sh install gha && sudo ./svc.sh start`).
5. **Repository variables and secrets** (Settings → Secrets and variables → Actions):

   | Name | Kind | Required | Purpose |
   |---|---|---|---|
   | `SELFTEST_ENABLED` | variable | yes | `true` turns the job on |
   | `SELFTEST_COMMIT` | variable | no | `true` commits `docs/containment/selftest-<date>.txt` on a pass. The push uses `GITHUB_TOKEN`, so the branch must accept it (branch protection usually blocks this on `main`; leave it off and copy the artifact in a PR instead) |
   | `LXS_SELFTEST_ENDPOINT` | variable | no | The platform URL. Without it a placeholder is used, the platform egress probe hits an unresolvable host, and the agent → platform check is reported as skipped |
   | `LXS_SELFTEST_INGEST_KEY` | secret | no | A real ingest key for a dedicated test project. Without it a placeholder is used and no events reach a platform |
   | `IMAGE_NAMESPACE` | variable | no | Only for `images: registry` runs. Defaults to `ghcr.io/lxs` |

6. **First run:** Actions → **Selftest (containment)** → **Run workflow**. Download the artifact and
   check it as below. Public repositories: GitHub advises against self-hosted runners on public
   repos, because a fork's pull request could run code on them. This workflow has no
   `pull_request` trigger, but keep the repo's "require approval for fork workflows" setting on.

## Reading the result

The last line is `Containment: PASS (n/n)` or `Containment: FAIL (p/n)`. `n` is the number of
**counted** checks. Skipped checks (marked `-`) are listed but not counted, and the run passes only
if every counted check passes. The exit code is 0 on PASS and 1 on FAIL.

"13/13" is the figure the roadmap uses: 13 counted checks, all passing, for the original web + ssh
decoy set. The current `examples/acme-shop` declares six decoys (three web, ssh, redis, postgres), so
its total is higher. What matters is the same rule: **every counted check passes, and the
`DOCKER-USER + INPUT rules` check is counted, not skipped.** A PASS where that check was skipped
(because selftest ran without root) does not prove the host firewall.

What is checked (`sdk/lxs/src/cli/selftest.ts`):

| Check | Target | Passes when |
|---|---|---|
| container running | every expected service | `ds-agent`, `ds-web` and one `ds-<id>` per network decoy are up |
| read-only rootfs, caps ALL dropped, no-new-privileges, non-root, limits | each running container | all six properties hold in `docker inspect` |
| network mode | `ds-web` | `none` |
| attached networks | each network decoy | exactly one network, `ds_trap` |
| network interfaces | `ds-web` | loopback only, no default route |
| agent socket | `ds-web` | `/run/lxs/agent` is absent |
| `-> 1.1.1.1:443`, `-> host <gateway>:22`, `-> 169.254.169.254:80`, `-> shop:3000` | each network decoy | the connection is **blocked** (internet, host, cloud metadata, the app by name) |
| `-> platform <host>:<port>` | each network decoy | blocked (only when `LXS_ENDPOINT` is set) |
| `-> customer shop <ip>:<port>`, `-> customer shop published port` | each network decoy | blocked (the app by container IP and by published port) |
| DOCKER-USER + INPUT rules | host | both `iptables -C ... -i br-ds-trap ... -j DROP` rules exist. **Skipped** without root |
| `-> platform /healthz (expected)` | `ds-agent` | the one allowed egress path works. **Skipped** (not a failure) if the platform is unreachable |

A probe that cannot run (for example `nc` missing in the Postgres decoy) counts as a failure, never
as "blocked".

## Running it by hand

Follow `infra/victim/DEPLOY-EC2.md` up to step 8, then:

```bash
cd examples/acme-shop
sudo env "PATH=$PATH" node ../../sdk/lxs/dist/cli/index.js selftest | tee ../../docs/containment/selftest-$(date -u +%F).txt
```

Add a header with the date, commit, `uname -srm` and `docker version`, as the workflow does, and
commit the file.

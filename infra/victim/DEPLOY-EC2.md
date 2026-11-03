# Deploying the LXS victim stack to AWS EC2

This runs the **shop app (the real app being protected)**, the **decoys**, and the
**agent** on an internet-facing EC2 host. The SOC platform (API + dashboard + its
Postgres) stays elsewhere — the agent only dials *out* to it, so the platform never
needs inbound access to this box.

Why EC2 and not Docker Desktop: the containment guarantee (`ds-firewall.sh`) only
holds on a real Linux host. Docker Desktop runs containers in a VM where the host
firewall rules cannot apply. A bare-Linux EC2 instance is what makes the claim real.

---

## 0. What you need first

- The SOC **platform** reachable over HTTPS from the internet, and its URL
  (`LXS_ENDPOINT`), e.g. `https://soc.example.dev`. If the platform is only on your
  laptop for now, expose it with a tunnel (ngrok/cloudflared) and use that URL.
- A **real ingest key** created in the dashboard (**Settings → Keys**) for this
  project — not the dev `ds_dev_000…` key.

---

## 1. Launch the instance

In the EC2 console (**Launch instance**):

| Setting | Value |
|---|---|
| AMI | Amazon Linux 2023 **or** Ubuntu 24.04 LTS, **x86_64** |
| Instance type | **t3.medium** (2 vCPU / 4 GB) — see sizing note below |
| Key pair | your admin SSH key |
| Storage | 20 GB gp3 |
| Advanced → Metadata version | **V2 only (token required)** |
| Advanced → User data | paste `infra/victim/ec2-bootstrap.sh` (optional; installs Docker on boot) |

**Sizing:** the decoy memory caps total ~1 GB (agent 256m + web 128m + cowrie 256m +
redis 128m + postgres 256m), plus the shop (~256 MB) and OS/Docker overhead.
`t3.small` (2 GB) is too tight once you build images on the box; `t3.medium` (4 GB)
is comfortable. Use x86_64 — the Cowrie/Postgres decoy images are not multi-arch.

---

## 2. Security group

Inbound — open only the attacker-facing ports plus your own admin SSH:

| Port | Proto | Source | Why |
|---|---|---|---|
| 22 | TCP | **your IP /32** | admin SSH (you) |
| 2222 | TCP | 0.0.0.0/0 | SSH honeypot (Cowrie) |
| 6380 | TCP | 0.0.0.0/0 | Redis decoy |
| 5433 | TCP | 0.0.0.0/0 | Postgres decoy |
| 3001 | TCP | 0.0.0.0/0 | the shop app (or 80/443 behind a proxy) |

Outbound — leave the default **allow all** (the agent needs HTTPS 443 to the platform;
the decoys' own outbound is blocked at the host firewall, not the security group).

> Realism option: attackers expect SSH on **22**. If you want that, move your admin
> sshd to another port (and point the SG rule above at it), then change the Cowrie
> host port to 22 in `examples/acme-shop/decoy.config.ts` and re-run `npx lxs build`.

---

## 3. Install Docker (skip if you used user data in step 1)

SSH in as the admin user, then:

```bash
sudo bash infra/victim/ec2-bootstrap.sh
```

Log out and back in once, so your user picks up the `docker` group (run `docker ps`
to confirm it works without sudo).

---

## 4. Get the code onto the box

This repo is private, so copy it rather than cloning anonymously. Easiest is from
your laptop:

```bash
scp -r ./Karna_D3C0Y_SamanPandey ec2-user@<EC2_PUBLIC_IP>:~/lxs
```

(Or `git clone` with a deploy key / PAT if you prefer. Ubuntu's admin user is
`ubuntu`, Amazon Linux's is `ec2-user`.)

---

## 5. Build the images

```bash
cd ~/lxs
bash infra/victim/build-images.sh
```

This builds the five decoy images with the exact tags Compose expects, so no env
overrides are needed. (To use ECR instead, push there and export `LXS_AGENT_IMAGE`,
`LXS_WEB_IMAGE`, `LXS_COWRIE_IMAGE`, `LXS_REDIS_IMAGE`, `LXS_POSTGRES_IMAGE` as
`name:tag@sha256:…` digests before `up`.)

---

## 6. Configure the agent's uplink

```bash
cd ~/lxs/examples/acme-shop
cp .env.lxs.example .env.lxs
```

Edit `.env.lxs`:

```
LXS_INGEST_KEY=ds_live_<the real key from Settings → Keys>
LXS_ENDPOINT=https://<your platform host>
```

This file is the **only** place the credential lives, and it is git-ignored. Leave
`NODE_ENV` at its production default and keep `DS_DEV_SIM` unset — the SDK refuses to
start if the sim header is trusted while `NODE_ENV=production`.

---

## 7. Start the stack

```bash
cd ~/lxs/examples/acme-shop
docker compose -f docker-compose.yml -f lxs.compose.yml up -d
docker compose -f docker-compose.yml -f lxs.compose.yml ps
```

Quick checks:

```bash
curl -s http://localhost:3001/health            # shop is up
docker compose ... logs ds-agent | tail          # agent registered with the platform
```

The dashboard on your platform should now show this sensor reporting.

---

## 8. Lock down containment (the point of using Linux)

```bash
sudo ~/lxs/infra/victim/ds-firewall.sh            # install DOCKER-USER + INPUT drops
```

Persist it, because Docker rewrites its chains on restart:

- **Ubuntu:** `sudo netfilter-persistent save`
- **Amazon Linux:** `sudo service iptables save` (iptables-services was installed by bootstrap)

Then verify, and re-verify after any `systemctl restart docker`:

```bash
sudo ~/lxs/infra/victim/ds-firewall.sh --check    # exit 1 if a rule is missing
```

On EC2 these rules also block the decoys from reaching the instance metadata service
(`169.254.169.254`) — which is why step 1 set IMDSv2-only as a second layer.

---

## 9. Prove it

```bash
cd ~/lxs/examples/acme-shop
npx lxs selftest
```

`selftest` probes each decoy from the inside and posts the result to the dashboard's
Containment panel. On this Linux host it should report a real PASS (not the "cannot
back the claim" message Docker Desktop produces).

---

## Operating notes

- **Logs/journaling:** each decoy logs to a Docker volume capped at 10 MB × 3 files;
  the agent tails them and ships events. No extra log plumbing needed.
- **Updating:** re-copy the repo, `build-images.sh`, then
  `docker compose ... up -d` — then `ds-firewall.sh --check` again.
- **Stopping:** `docker compose -f docker-compose.yml -f lxs.compose.yml down`.
- **Blast radius:** this host is meant to be attacked. Keep nothing else on it, keep
  admin SSH pinned to your IP, and treat the box as disposable.

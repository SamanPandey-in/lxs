# infra/victim — the host that runs the decoys

The decoy containers are sensors. This directory holds what the *host* has to do so
they can never become a pivot.

## Install, once, as root

```bash
sudo ./ds-firewall.sh                 # install the DOCKER-USER + INPUT drop rules
sudo ./ds-firewall.sh --check         # verify (exit 1 if a rule is missing)
sudo ./ds-firewall.sh --remove        # back out
```

Then persist them, because Docker rewrites its chains on restart:

```bash
apt-get install -y iptables-persistent && netfilter-persistent save
sudo ./ds-firewall.sh --check         # re-check after `systemctl restart docker`
```

## What the rules do

| Chain | Rule | Stops |
|---|---|---|
| `DOCKER-USER` | drop NEW from `br-ds-trap` | decoys opening connections to the internet, the LAN, or other containers |
| `INPUT` | drop NEW from `br-ds-trap` | decoys reaching the host's own sshd, Docker-published ports, and the cloud metadata service (`169.254.169.254`) |

`ctstate NEW` only. Replies on an inbound attacker session are ESTABLISHED and still
pass, so the honeypot stays convincing.

## Why not `internal: true`?

Docker does not publish ports for containers attached only to internal networks, so
attackers could not reach the decoys at all. Instead: web decoys avoid networking
entirely (`network_mode: none`, reached over a Unix socket), and network decoys use a
normal bridge whose outbound path is shut at three layers — masquerading disabled on
the bridge, inter-container communication disabled, and these host firewall rules.

## Verifying

`npx lxs selftest` probes each decoy from the inside (`docker exec`, using the
interpreter already in the image, so nothing is added to an attacker-reachable
container) and posts the report to the platform, where it shows on the Containment
panel. Run it before every demo.

## Docker Desktop (macOS / Windows)

Containers run inside a VM; these rules cannot be applied from the host. Development
is fine. **Containment claims are not** — `selftest` will say so rather than report a
PASS it cannot back.

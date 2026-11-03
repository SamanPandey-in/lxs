#!/usr/bin/env bash
# ec2-bootstrap.sh — prepare a fresh EC2 Linux host to run the LXS victim stack
# (the shop app + decoys + agent). Installs Docker, the Compose plugin, git, and
# the iptables persistence tooling the containment rules need.
#
# Run as root on first boot. Two ways:
#   1. Paste this file into the instance's "User data" at launch (runs as root once).
#   2. Copy it to the box and run:  sudo bash ec2-bootstrap.sh
#
# Supports Amazon Linux 2023 and Ubuntu 22.04/24.04 (x86_64). It installs
# prerequisites only — it does NOT fetch the repo or start containers; see
# DEPLOY-EC2.md for the steps that follow.
set -euo pipefail

log() { echo "[ec2-bootstrap] $*"; }

[[ "${EUID}" -eq 0 ]] || { echo "must run as root (use sudo)" >&2; exit 1; }

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
else
  echo "cannot read /etc/os-release; unsupported host" >&2; exit 1
fi

case "${ID}" in
  amzn)
    log "Amazon Linux ${VERSION_ID} detected"
    dnf -y update
    dnf -y install docker git iptables iptables-services
    systemctl enable --now docker
    # Compose v2 plugin (dnf package is not always present on AL2023)
    install -d /usr/libexec/docker/cli-plugins
    ARCH="$(uname -m)"
    curl -fsSL "https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-${ARCH}" \
      -o /usr/libexec/docker/cli-plugins/docker-compose
    chmod +x /usr/libexec/docker/cli-plugins/docker-compose
    ADMIN_USER="ec2-user"
    ;;
  ubuntu)
    log "Ubuntu ${VERSION_ID} detected"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y ca-certificates curl gnupg git iptables-persistent
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    systemctl enable --now docker
    ADMIN_USER="ubuntu"
    ;;
  *)
    echo "unsupported distro '${ID}'. This script targets Amazon Linux 2023 or Ubuntu." >&2
    exit 1
    ;;
esac

# Let the admin user run docker without sudo (takes effect on next login).
if id "${ADMIN_USER}" >/dev/null 2>&1; then
  usermod -aG docker "${ADMIN_USER}"
  log "added ${ADMIN_USER} to the docker group (re-login to take effect)"
fi

log "versions:"
docker --version || true
docker compose version || true

cat <<'NEXT'

[ec2-bootstrap] done. Next steps (see infra/victim/DEPLOY-EC2.md):
  1. Get the repo onto this box (git clone or scp).
  2. Build the images:        bash infra/victim/build-images.sh
  3. Fill examples/acme-shop/.env.lxs with the real ingest key + platform URL.
  4. Start:   cd examples/acme-shop
              docker compose -f docker-compose.yml -f lxs.compose.yml up -d
  5. Lock containment:        sudo infra/victim/ds-firewall.sh
  6. Prove it:                npx lxs selftest
NEXT

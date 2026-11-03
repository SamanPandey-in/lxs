#!/usr/bin/env bash
# ds-firewall.sh — host containment rules for a LXS victim host (Linux).
#
# Network decoys sit on the ds_trap bridge with a published port so attackers can
# reach them. This script shuts their OUTBOUND path at the host layer, so a decoy
# is a sensor and never a pivot. Replies to inbound attacker sessions are
# ESTABLISHED and still pass, so the honeypots keep working.
#
# Run once, as root, on the host that runs the decoy containers:
#   sudo ./ds-firewall.sh [--network COMPOSE_NETWORK] [--bridge LINUX_BRIDGE] [--check] [--remove]
#
# Docker Desktop (macOS/Windows) runs containers inside a VM where these rules
# cannot be applied from the host. Development there is fine; containment claims
# are NOT. Say so out loud rather than claiming a PASS you cannot back.
set -euo pipefail

BRIDGE=""
NETWORK=""
MODE="apply"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bridge) BRIDGE="$2"; shift 2 ;;
    --network) NETWORK="$2"; shift 2 ;;
    --check)  MODE="check";  shift ;;
    --remove) MODE="remove"; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

require_root() {
  [[ "${EUID}" -eq 0 ]] || { echo "must run as root" >&2; exit 1; }
}

if [[ -z "${BRIDGE}" ]]; then
  if [[ -z "${NETWORK}" ]]; then
    mapfile -t networks < <(docker network ls --filter label=com.docker.compose.network=ds_trap --format '{{.Name}}')
    [[ "${#networks[@]}" -eq 1 ]] || {
      echo "expected one Compose ds_trap network; pass --network NAME (found ${#networks[@]})" >&2
      exit 2
    }
    NETWORK="${networks[0]}"
  fi
  BRIDGE="$(docker network inspect -f '{{index .Options "com.docker.network.bridge.name"}}' "${NETWORK}")"
  if [[ -z "${BRIDGE}" || "${BRIDGE}" == "<no value>" ]]; then
    NETWORK_ID="$(docker network inspect -f '{{.Id}}' "${NETWORK}")"
    BRIDGE="br-${NETWORK_ID:0:12}"
  fi
fi

# Two rules, each in its own chain:
#   DOCKER-USER — traffic the bridge tries to route onward (the internet, other
#                 containers, the LAN). Docker consults this chain before its own.
#   INPUT       — traffic aimed at the host itself: its sshd, Docker-published
#                 ports, and the cloud metadata service at 169.254.169.254.
# ctstate NEW means only *new* connections are dropped.
rules=(
  "DOCKER-USER -i ${BRIDGE} -m conntrack --ctstate NEW -j DROP"
  "INPUT -i ${BRIDGE} -m conntrack --ctstate NEW -j DROP"
)

case "${MODE}" in
  apply)
    require_root
    if ! iptables -L DOCKER-USER -n >/dev/null 2>&1; then
      echo "warning: DOCKER-USER chain not found — is Docker running with the iptables backend?" >&2
    fi
    for r in "${rules[@]}"; do
      # shellcheck disable=SC2086
      if iptables -C ${r} 2>/dev/null; then
        echo "already present: ${r}"
      else
        # shellcheck disable=SC2086
        iptables -I ${r}
        echo "installed:       ${r}"
      fi
    done
    echo
    echo "Persist these across reboots (Debian/Ubuntu):"
    echo "  apt-get install -y iptables-persistent && netfilter-persistent save"
    echo "Then re-run '$0 --check' after a Docker restart: Docker rewrites its chains on start."
    ;;
  check)
    rc=0
    for r in "${rules[@]}"; do
      # shellcheck disable=SC2086
      if iptables -C ${r} 2>/dev/null; then
        echo "PRESENT ✔  ${r}"
      else
        echo "MISSING ✘  ${r}"; rc=1
      fi
    done
    exit "${rc}"
    ;;
  remove)
    require_root
    for r in "${rules[@]}"; do
      # shellcheck disable=SC2086
      while iptables -C ${r} 2>/dev/null; do iptables -D ${r}; done
      echo "removed: ${r}"
    done
    ;;
esac

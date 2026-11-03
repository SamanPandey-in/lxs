#!/usr/bin/env bash
# build-images.sh — build the LXS victim-stack images locally on the host.
#
# lxs.compose.yml references ghcr.io/lxs/* images that are not published, with an
# env override for each. This script builds all of them from the repo with the
# exact default tags Compose expects, so `docker compose up` needs no overrides.
#
# Run from the repo root (or anywhere — it cd's to the repo root itself):
#   bash infra/victim/build-images.sh
set -euo pipefail

# Resolve repo root from this script's location (infra/victim/..).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT}"

VER="0.1.0"
log() { echo "[build-images] $*"; }

log "repo root: ${ROOT}"
log "building decoy + agent images (tag ${VER})"

docker build -f images/agent.Dockerfile            -t "ghcr.io/lxs/agent:${VER}"           .
docker build -f images/decoy-web.Dockerfile        -t "ghcr.io/lxs/decoy-web:${VER}"       .
docker build -f images/cowrie-personas.Dockerfile  -t "ghcr.io/lxs/cowrie-personas:${VER}" .
docker build -f images/redis-decoy.Dockerfile      -t "ghcr.io/lxs/decoy-redis:${VER}"     .
docker build -f images/postgres-decoy.Dockerfile   -t "ghcr.io/lxs/decoy-postgres:${VER}"  .

log "building the shop (the real app being protected)"
docker build -f examples/acme-shop/Dockerfile -t acme-shop:latest .

log "done. Images:"
docker images --format '  {{.Repository}}:{{.Tag}}  ({{.Size}})' \
  | grep -E 'ghcr.io/lxs/|acme-shop' || true

cat <<'NEXT'

[build-images] next:
  cd examples/acme-shop
  cp .env.lxs.example .env.lxs   # then edit: real LXS_INGEST_KEY + LXS_ENDPOINT
  docker compose -f docker-compose.yml -f lxs.compose.yml up -d
NEXT

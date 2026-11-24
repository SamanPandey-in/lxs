#!/usr/bin/env bash
# Middleware overhead on a non-decoy route: Go net/http and Node Express, each bare and behind the
# LXS middleware, driven by the same Go load generator (separate process, keep-alive connections).
# Usage: conformance/bench/run.sh [duration=10s] [connections=8]
# Node side needs: pnpm install --frozen-lockfile && pnpm --filter ./sdk/lxs build
set -euo pipefail
cd "$(dirname "$0")"
DUR="${1:-10s}"
CONNS="${2:-8}"
BIN="$(mktemp -d)"
trap 'kill $(jobs -p) 2>/dev/null || true; rm -rf "$BIN"' EXIT

(cd go && go build -o "$BIN/goserver" ./cmd/goserver && go build -o "$BIN/load" ./cmd/load)

wait_ready() { # file -> "bare lxs"
  for _ in $(seq 1 200); do
    if grep -q '^ready ' "$1" 2>/dev/null; then grep '^ready ' "$1" | cut -d' ' -f2-; return; fi
    sleep 0.05
  done
  echo "server did not start: $(cat "$1")" >&2; exit 1
}

load() { "$BIN/load" -label "$1" -url "http://$2/api/products?page=2" -c "$CONNS" -d "$DUR" -warmup 2s; }

"$BIN/goserver" > "$BIN/go.out" 2>&1 &
GO_PID=$!
read -r GO_BARE GO_LXS <<< "$(wait_ready "$BIN/go.out")"
load "go net/http bare" "$GO_BARE"
load "go net/http + lxs" "$GO_LXS"
kill "$GO_PID"

if [ -f ../../sdk/lxs/dist/index.js ]; then
  node node/server.mjs > "$BIN/node.out" 2>&1 &
  NODE_PID=$!
  read -r N_BARE N_LXS <<< "$(wait_ready "$BIN/node.out")"
  load "node express bare" "$N_BARE"
  load "node express + lxs" "$N_LXS"
  kill "$NODE_PID"
else
  echo "skipping Node: build sdk/lxs first (pnpm --filter ./sdk/lxs build)" >&2
fi

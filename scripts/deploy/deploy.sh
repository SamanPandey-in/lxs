#!/usr/bin/env bash
# Deploy one API image: run migrations as a one-off, then restart the service (G8).
# Called by .github/workflows/deploy.yml; runnable by hand with the same env.
#
#   IMAGE=ghcr.io/acme/lxs-api@sha256:... DEPLOY_TARGET=ssh DEPLOY_HOST=10.0.0.5 scripts/deploy/deploy.sh
#
# Common env:
#   IMAGE           required. Immutable reference (prefer the @sha256 digest the build produced).
#   DEPLOY_TARGET   ssh (default) | ecs
#
# ssh target: a host (EC2 or any VM) running the platform with docker compose.
#   DEPLOY_HOST          required. Hostname or IP.
#   DEPLOY_USER          default ubuntu
#   DEPLOY_PORT          default 22
#   DEPLOY_SSH_KEY_FILE  private key file (default: ssh-agent / ~/.ssh config)
#   DEPLOY_KNOWN_HOSTS_FILE  known_hosts with the host's key; strict checking is always on
#   DEPLOY_PATH          default /opt/lxs. Holds the compose file and its .env (secrets live there
#                        or in the host's environment, never in this repo)
#   DEPLOY_COMPOSE_FILE  default docker-compose.yml (relative to DEPLOY_PATH). Its api service must
#                        use `image: ${LXS_API_IMAGE}`; see docs/OPERATIONS.md
#   DEPLOY_SERVICE       default api
#   DEPLOY_HEALTH_URL    default http://127.0.0.1:8080/readyz (checked from the host)
#
# ecs target: TODO, see deploy_ecs below.
set -euo pipefail

: "${IMAGE:?IMAGE is required}"
TARGET="${DEPLOY_TARGET:-ssh}"

deploy_ssh() {
  : "${DEPLOY_HOST:?DEPLOY_HOST is required for DEPLOY_TARGET=ssh}"
  local user="${DEPLOY_USER:-ubuntu}" port="${DEPLOY_PORT:-22}"
  local ssh_opts=(-p "$port" -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15)
  [[ -n "${DEPLOY_SSH_KEY_FILE:-}" ]] && ssh_opts+=(-i "$DEPLOY_SSH_KEY_FILE" -o IdentitiesOnly=yes)
  [[ -n "${DEPLOY_KNOWN_HOSTS_FILE:-}" ]] && ssh_opts+=(-o UserKnownHostsFile="$DEPLOY_KNOWN_HOSTS_FILE")

  echo "deploy: $IMAGE -> $user@$DEPLOY_HOST:${DEPLOY_PATH:-/opt/lxs}"
  # Arguments travel as positional parameters, never interpolated into the remote script.
  ssh "${ssh_opts[@]}" "$user@$DEPLOY_HOST" bash -s -- \
    "$IMAGE" "${DEPLOY_PATH:-/opt/lxs}" "${DEPLOY_COMPOSE_FILE:-docker-compose.yml}" \
    "${DEPLOY_SERVICE:-api}" "${DEPLOY_HEALTH_URL:-http://127.0.0.1:8080/readyz}" <<'REMOTE'
set -euo pipefail
image="$1"; dir="$2"; file="$3"; svc="$4"; health="$5"
cd "$dir"
compose=(docker compose -f "$file")

# Registry login: ECR through the instance role; anything else must already be logged in.
registry="${image%%/*}"
if [[ "$registry" == *.dkr.ecr.*.amazonaws.com ]]; then
  region="$(cut -d. -f4 <<<"$registry")"
  aws ecr get-login-password --region "$region" | docker login --username AWS --password-stdin "$registry"
fi

# Pin the image in .env so a later `compose up` or reboot keeps this version.
touch .env
previous="$(sed -n 's/^LXS_API_IMAGE=//p' .env | tail -n1)"
if grep -q '^LXS_API_IMAGE=' .env; then
  sed -i "s#^LXS_API_IMAGE=.*#LXS_API_IMAGE=${image}#" .env
else
  echo "LXS_API_IMAGE=${image}" >> .env
fi
echo "remote: previous image ${previous:-<none>}"

export LXS_API_IMAGE="$image"
"${compose[@]}" pull "$svc"

echo "remote: running migrations (one-off)"
if ! "${compose[@]}" run --rm --no-deps "$svc" pnpm db:migrate; then
  echo "remote: migration failed; restoring previous image pin, service left untouched" >&2
  [[ -n "$previous" ]] && sed -i "s#^LXS_API_IMAGE=.*#LXS_API_IMAGE=${previous}#" .env
  exit 1
fi

echo "remote: restarting $svc"
"${compose[@]}" up -d --no-deps "$svc"

for _ in $(seq 1 60); do
  if curl -fsS "$health" >/dev/null 2>&1; then
    echo "remote: healthy ($health)"
    docker image prune -f >/dev/null || true
    exit 0
  fi
  sleep 2
done
echo "remote: $svc did not become ready at $health; previous image was ${previous:-<none>}" >&2
"${compose[@]}" logs --tail 80 "$svc" >&2 || true
exit 1
REMOTE
}

deploy_ecs() {
  # TODO(ecs): not implemented. Intended shape, all via the aws CLI with an OIDC-assumed role:
  #   1. aws ecs describe-task-definition --task-definition "$ECS_TASK_FAMILY" and register a new
  #      revision with the container image replaced by "$IMAGE" (jq over containerDefinitions).
  #   2. One-off migration: aws ecs run-task --cluster "$ECS_CLUSTER" --launch-type FARGATE
  #      --task-definition <new revision> --network-configuration <ECS_SUBNETS/ECS_SECURITY_GROUPS>
  #      --overrides '{"containerOverrides":[{"name":"api","command":["pnpm","db:migrate"]}]}',
  #      then aws ecs wait tasks-stopped and fail unless the container exitCode is 0.
  #   3. aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE"
  #      --task-definition <new revision>, then aws ecs wait services-stable.
  # Secrets come from the task definition (Secrets Manager / SSM references), not from here.
  echo "deploy: DEPLOY_TARGET=ecs is not implemented yet (cluster=${ECS_CLUSTER:-?} service=${ECS_SERVICE:-?}); see the TODO in $0" >&2
  exit 2
}

case "$TARGET" in
  ssh) deploy_ssh ;;
  ecs) deploy_ecs ;;
  *)
    echo "deploy: unknown DEPLOY_TARGET '$TARGET' (ssh|ecs)" >&2
    exit 2
    ;;
esac

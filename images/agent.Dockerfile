# syntax=docker/dockerfile:1
# ds-agent: the only container that holds the platform key. Build context: the monorepo root.
#   docker build -f images/agent.Dockerfile -t ghcr.io/lxs/agent:0.1.0 .

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY pnpm-lock.yaml* ./
COPY packages/schema packages/schema
COPY packages/normalizer packages/normalizer
COPY apps/agent apps/agent
COPY data/wordlists/common-creds.txt /tmp/common-creds.txt
RUN pnpm install --no-frozen-lockfile --filter @lxs/agent...
RUN pnpm --filter @lxs/agent build
# Pre-create the writable mount points owned by the runtime uid: named volumes inherit this ownership.
RUN mkdir -p /rootfs/app /rootfs/run/lxs/agent /rootfs/var/lib/lxs /rootfs/var/log/lxs /rootfs/etc/lxs \
 && cp apps/agent/dist/main.js /rootfs/app/main.js \
 && cp /tmp/common-creds.txt /rootfs/etc/lxs/common-creds.txt \
 && chown -R 10001:10001 /rootfs/run/lxs /rootfs/var/lib/lxs

# Distroless: no shell, no package manager, nothing for an intruder to use. The bundle is a single file.
FROM gcr.io/distroless/nodejs22-debian12:nonroot
COPY --from=build /rootfs/ /
WORKDIR /app
USER 10001:10001
ENV NODE_ENV=production
LABEL org.opencontainers.image.title="lxs-agent" \
      org.opencontainers.image.description="LXS sensor agent (the only component holding the ingest key)" \
      org.opencontainers.image.version="0.1.0"
# Entrypoint is /nodejs/bin/node; the key arrives via env_file at runtime and is never baked into the image.
CMD ["main.js"]

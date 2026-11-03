# syntax=docker/dockerfile:1
# ds-web: static HTTP decoys on a Unix socket. Runs with network_mode: none. Build context: the monorepo root.
#   docker build -f images/decoy-web.Dockerfile -t ghcr.io/lxs/decoy-web:0.1.0 .

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY pnpm-lock.yaml* ./
COPY apps/decoy-web apps/decoy-web
RUN pnpm install --no-frozen-lockfile --filter @lxs/decoy-web...
RUN pnpm --filter @lxs/decoy-web build
RUN mkdir -p /rootfs/app /rootfs/run/lxs/web /rootfs/var/log/lxs /rootfs/etc/lxs \
 && cp apps/decoy-web/dist/main.js /rootfs/app/main.js \
 && chown -R 10002:10002 /rootfs/run/lxs /rootfs/var/log/lxs

FROM gcr.io/distroless/nodejs22-debian12:nonroot
COPY --from=build /rootfs/ /
WORKDIR /app
USER 10002:10002
ENV NODE_ENV=production
LABEL org.opencontainers.image.title="lxs-decoy-web" \
      org.opencontainers.image.description="LXS web decoys (no network, no child processes)" \
      org.opencontainers.image.version="0.1.0"
# Config and honeytokens are mounted read-only at /etc/lxs; logs go to the /var/log/lxs volume.
CMD ["main.js"]

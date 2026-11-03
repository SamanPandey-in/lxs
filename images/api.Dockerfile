# LXS platform API (ROLE=api|worker|all). Build context = repo root:
#   docker build -f images/api.Dockerfile -t lxs-api .
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* .npmrc* ./
COPY packages/schema/package.json packages/schema/
COPY packages/detection/package.json packages/detection/
COPY apps/api/package.json apps/api/
RUN pnpm install --no-frozen-lockfile --filter @lxs/api...

FROM base AS runtime
ENV NODE_ENV=production ROLE=all PORT=8080
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/apps ./apps
COPY package.json pnpm-workspace.yaml ./
COPY packages/schema/src packages/schema/src
COPY packages/schema/tsconfig.json packages/schema/
COPY packages/detection/src packages/detection/src
COPY packages/detection/tsconfig.json packages/detection/
COPY apps/api/src apps/api/src
COPY apps/api/tsconfig.json apps/api/
COPY data/wordlists /app/data/wordlists
ENV COMMON_CREDS_PATH=/app/data/wordlists/common-creds.txt
USER node
EXPOSE 8080
WORKDIR /app/apps/api
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["pnpm", "start"]

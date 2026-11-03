# Build from the monorepo root:  docker build -f examples/acme-shop/Dockerfile -t acme-shop .
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY pnpm-lock.yaml* ./
COPY sdk/lxs sdk/lxs
COPY examples/acme-shop examples/acme-shop
RUN pnpm install --no-frozen-lockfile --filter acme-shop... \
 && pnpm --filter lxs build

FROM node:22-alpine
WORKDIR /repo
COPY --from=build /repo /repo
WORKDIR /repo/examples/acme-shop
USER node
EXPOSE 3000
CMD ["node_modules/.bin/tsx", "src/server.ts"]

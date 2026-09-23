# The existing lockfile overrides target linux/x64 glibc (not Alpine or ARM).
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@10.32.1
COPY . .
RUN pnpm install --frozen-lockfile --filter @workspace/api-server...
RUN pnpm --filter @workspace/api-server build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /app/artifacts/api-server/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/index.mjs"]

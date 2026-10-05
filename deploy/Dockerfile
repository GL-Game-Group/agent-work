# The company service (admin/ + gateway/, one process). Built from the repository root:
#   docker build -f deploy/Dockerfile .
#
# The workspace layout is kept as is: Node strips TypeScript types only outside
# node_modules, so gateway/src must stay a workspace link, not a copied dependency.

FROM node:24.21.0-slim AS build
WORKDIR /app
# CI: pnpm may replace node_modules without asking (the production re-install below).
ENV CI=true
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY gateway/package.json gateway/
COPY admin/package.json admin/
COPY plugins/team-bundle/package.json plugins/team-bundle/
COPY plugins/tunnel/package.json plugins/tunnel/
RUN pnpm install --frozen-lockfile --filter @agent-work/admin...
COPY gateway gateway
COPY admin admin
RUN pnpm --filter @agent-work/admin build

FROM node:24.21.0-slim
WORKDIR /app
ENV NODE_ENV=production
# Only what runs: the console's build output and server, and the company service's source
# (admin's one runtime dependency, linked as in the workspace). Small layers, so the internal
# cluster pulls them quickly.
COPY --from=build --chown=node:node /app/package.json /app/
COPY --from=build --chown=node:node /app/gateway/package.json /app/gateway/
COPY --from=build --chown=node:node /app/gateway/src /app/gateway/src
COPY --from=build --chown=node:node /app/admin/package.json /app/admin/server.js /app/admin/
COPY --from=build --chown=node:node /app/admin/build /app/admin/build
RUN mkdir -p /app/admin/node_modules/@agent-work && ln -s ../../../gateway /app/admin/node_modules/@agent-work/gateway
# A named volume mounted here takes this ownership on first use.
RUN mkdir -p /data /backups && chown node:node /data /backups
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/agent-work/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "admin/server.js"]

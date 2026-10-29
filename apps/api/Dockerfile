# syntax=docker/dockerfile:1.7
#
# Production image for the messengers2amo API (Fastify, Node 24).
#
# The application runs TypeScript sources directly via Node 24 built-in type
# stripping (`node src/index.ts`), so there is no compile/bundle step. The
# runtime image therefore contains only production dependencies plus sources.
#
# Layout is preserved on purpose: src/platform/migrate.ts resolves the SQL
# directory as `../../../../packages/database/migrations/`, which maps to
# /app/packages/database/migrations from /app/apps/api/src/platform.
#
# TODO(release): pin both base images by digest (@sha256:...) before the first
# production rollout and record the digests in RELEASE-MANIFEST.md.

ARG NODE_VERSION=24

# ---------------------------------------------------------------------------
# Stage 1: production dependencies only
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps

WORKDIR /app

# Copy only manifests first so the dependency layer is cached across source edits.
COPY apps/api/package.json apps/api/package-lock.json ./

# --omit=dev keeps fastify/pg/pino/zod and drops typescript/@types.
# --ignore-scripts is safe here: none of the runtime dependencies build native code.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    TZ=UTC

WORKDIR /app

# node_modules lives at /app so that both /app/apps/api/src (application) and
# /app/ops/... (migration entrypoint) resolve the same production tree.
COPY --from=deps --chown=root:root /app/node_modules ./node_modules

COPY --chown=root:root apps/api/package.json ./package.json
COPY --chown=root:root apps/api/src ./apps/api/src
# Application-owned migrations 005..007, read via `../../migrations/` from
# apps/api/src/platform/migrate.ts.
COPY --chown=root:root apps/api/migrations ./apps/api/migrations
# Shared domain migrations 001..004, read via
# `../../../../packages/database/migrations/` from the same module.
COPY --chown=root:root packages/database/migrations ./packages/database/migrations
# Transactional advisory-lock runner used by the one-shot `migrate` service.
COPY --chown=root:root packages/database/src/migrate.mjs ./packages/database/src/migrate.mjs
# Dependency-free HMAC signing module required at runtime by
# apps/api/src/integrations/amocrm/{client,webhook}.ts (CommonJS require of a
# relative path, so the repository layout must be preserved).
COPY --chown=root:root packages/amocrm-protocol/src ./packages/amocrm-protocol/src
COPY --chown=root:root ops/deploy/messengers2amo/migrate-entrypoint.mjs ./ops/deploy/messengers2amo/migrate-entrypoint.mjs

# The bundled `node` user (uid/gid 1000) is unprivileged and owns nothing in /app.
# The container is additionally run with a read-only root filesystem and
# no-new-privileges (see ops/deploy/messengers2amo/docker-compose.yml).
USER node

# Container-internal port. The host publishes it as 127.0.0.1:18767 only.
EXPOSE 3000

STOPSIGNAL SIGTERM

# Liveness only: /health/live does not touch the database, so a database outage
# must not restart-loop the API. Readiness (/health/ready) is polled by nginx
# and monitoring instead, see ops/deploy/messengers2amo/MONITORING.md.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/src/index.ts"]

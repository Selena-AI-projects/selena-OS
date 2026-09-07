# Elmo 
# Supports: web app (Nitro server), worker, and isolated private-asset scanner.

# Build-time selector used by the final runtime stage.
ARG RAILWAY_SERVICE_NAME=web

# Base stage with Node.js
FROM node:24-alpine AS base
RUN corepack enable pnpm
RUN apk add --no-cache curl

# Dependencies stage
FROM base AS deps
WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY apps/www/package.json ./apps/www/
COPY packages/ui/package.json ./packages/ui/
COPY packages/config/package.json ./packages/config/
COPY packages/content-workflow/package.json ./packages/content-workflow/
COPY packages/lib/package.json ./packages/lib/
COPY packages/local/package.json ./packages/local/
COPY packages/whitelabel/package.json ./packages/whitelabel/
COPY packages/cloud/package.json ./packages/cloud/
COPY packages/deployment/package.json ./packages/deployment/
COPY packages/docs/package.json ./packages/docs/
COPY packages/og/package.json ./packages/og/
COPY packages/api-spec/package.json ./packages/api-spec/
COPY packages/selena-visibility-contracts/package.json ./packages/selena-visibility-contracts/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Builder stage
FROM base AS builder
WORKDIR /app

# Copy dependencies
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=deps /app/apps/www/node_modules ./apps/www/node_modules
COPY --from=deps /app/packages/ui/node_modules ./packages/ui/node_modules
COPY --from=deps /app/packages/config/node_modules ./packages/config/node_modules
COPY --from=deps /app/packages/content-workflow/node_modules ./packages/content-workflow/node_modules
COPY --from=deps /app/packages/lib/node_modules ./packages/lib/node_modules
COPY --from=deps /app/packages/local/node_modules ./packages/local/node_modules
COPY --from=deps /app/packages/whitelabel/node_modules ./packages/whitelabel/node_modules
COPY --from=deps /app/packages/cloud/node_modules ./packages/cloud/node_modules
COPY --from=deps /app/packages/deployment/node_modules ./packages/deployment/node_modules
COPY --from=deps /app/packages/docs/node_modules ./packages/docs/node_modules
COPY --from=deps /app/packages/og/node_modules ./packages/og/node_modules
COPY --from=deps /app/packages/selena-visibility-contracts/node_modules ./packages/selena-visibility-contracts/node_modules

# Copy source code
COPY . .

# Build arguments for VITE_ env vars (baked into client bundle)
ARG DEPLOYMENT_MODE=local
ARG VITE_DEPLOYMENT_MODE=${DEPLOYMENT_MODE}
ENV VITE_DEPLOYMENT_MODE=${VITE_DEPLOYMENT_MODE}

# Build the web application (increase heap for large bundles)
RUN pnpm --filter @workspace/web build

# Create pruned standalone deployments (only each package's own deps)
# --legacy: allows deploy without inject-workspace-packages (which breaks Alpine Docker builds)
RUN pnpm --filter @workspace/worker deploy --legacy /deploy/worker
RUN pnpm --filter @workspace/lib deploy --legacy /deploy/lib

# Runner stage for web app (Nitro)
FROM base AS web
WORKDIR /app

ENV NODE_ENV=production

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 elmo

# Copy entrypoint script
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Copy Nitro output - this is the entire server bundle
COPY --from=builder --chown=elmo:nodejs /app/apps/web/.output ./.output

USER elmo

EXPOSE 3000
ENV PORT=3000
ENV HOST="0.0.0.0"

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", ".output/server/index.mjs"]

# Migration stage — runs a single-connection migration runner then exits.
FROM base AS migrate
WORKDIR /app

COPY --from=builder /deploy/lib ./
COPY docker/migrate-entrypoint.sh /migrate-entrypoint.sh
RUN chmod 500 /migrate-entrypoint.sh

ENTRYPOINT ["/migrate-entrypoint.sh"]
CMD ["node", "scripts/run-migrations.mjs"]

# Worker stage
FROM base AS worker
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 worker

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

COPY --from=builder --chown=worker:nodejs /deploy/worker ./

USER worker

ENTRYPOINT ["/entrypoint.sh"]
CMD ["npx", "tsx", "src/index.ts"]

# Scanner stage. It is intentionally a separate service: it is the only
# runtime that receives the restricted scanner database role and Supabase
# Storage service credential.
FROM base AS scanner
WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache clamav clamav-daemon
RUN addgroup --system --gid 1002 scanner
RUN adduser --system --uid 1002 scanner
RUN mkdir -p /var/lib/clamav /run/clamav
RUN chown -R scanner:scanner /var/lib/clamav /run/clamav

COPY --from=builder --chown=scanner:scanner /deploy/worker ./
COPY docker/scanner-entrypoint.sh /scanner-entrypoint.sh
COPY docker/clamd.conf /etc/clamav/clamd.conf
COPY docker/freshclam.conf /etc/clamav/freshclam.conf
RUN chmod 500 /scanner-entrypoint.sh

USER scanner

EXPOSE 8081
ENV SELENA_SCANNER_PORT=8081

ENTRYPOINT ["/scanner-entrypoint.sh"]
CMD ["node_modules/.bin/tsx", "src/selena-scanner.ts"]

# Release Gateway has a distinct runtime identity and no Postiz credential.
# It builds and signs an immutable publication package; a later adapter is the
# only component that may submit that package to an external provider.
FROM base AS gateway
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1003 gateway
RUN adduser --system --uid 1003 gateway

COPY --from=builder --chown=gateway:gateway /deploy/worker ./

USER gateway

EXPOSE 8082
ENV SELENA_GATEWAY_PORT=8082

CMD ["node_modules/.bin/tsx", "src/selena-release-gateway.ts"]

# The Aether bridge receiver is the only runtime that faces the public internet
# with a shared secret, and it carries the ingestion identity, whose entire
# reach into the database is one recording function.
FROM base AS receiver
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1004 receiver
RUN adduser --system --uid 1004 receiver

COPY --from=builder --chown=receiver:receiver /deploy/worker ./

USER receiver

EXPOSE 8083
ENV SELENA_RECEIVER_PORT=8083

CMD ["node_modules/.bin/tsx", "src/selena-aether-receiver.ts"]

# The Aether material projection is an internal runtime: it reads the inbox the
# receiver fills and writes content versions under the registry worker identity,
# so it runs as its own service with its own login and never listens on a port.
FROM base AS projection
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1005 projection
RUN adduser --system --uid 1005 projection

COPY --from=builder --chown=projection:projection /deploy/worker ./

USER projection

CMD ["node_modules/.bin/tsx", "src/selena-aether-projection-worker.ts"]

# A browser that can reach the deployment, for the one thing no log can prove:
# whether a person who signs in can get from an empty account to a material in
# the Inbox. Its own base image, because Playwright ships the browser matched to
# the library and the runtime stages above are Alpine. Temporary — it exists for
# the staging acceptance run and goes when that run is signed off.
FROM mcr.microsoft.com/playwright:v1.62.1-noble AS owner-path-check-temp
WORKDIR /app
COPY e2e/staging ./staging
RUN npm install --no-save playwright@1.62.1 pg@8.16.3
CMD ["node", "staging/owner-path.mjs"]

# The service name selects the final runtime stage: web, worker, migrate, scanner, gateway, receiver, projection, or owner-path-check-temp.
FROM ${RAILWAY_SERVICE_NAME} AS final

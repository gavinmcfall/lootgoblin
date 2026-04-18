# syntax=docker/dockerfile:1.9

# ---------- deps ----------
FROM node:22-alpine AS deps
WORKDIR /app
# native build deps for better-sqlite3 and argon2
RUN apk add --no-cache libc6-compat python3 make g++
# Copy only package manifests first so docker layer caches deps when manifests don't change.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
# Extension is excluded from the build context (.dockerignore) — we only need
# the server workspace, so create a stub manifest so npm workspaces can resolve
# the root without erroring on the missing sibling.
RUN mkdir -p apps/extension && echo '{"name":"extension","version":"0.0.0","private":true}' > apps/extension/package.json
RUN npm ci --workspace=server --include-workspace-root

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Build-time dummy — next build pre-renders pages which triggers env.ts parse.
# Runtime secret is set separately by the deployment (never bake a real one).
ENV LOOTGOBLIN_SECRET=dummy_build_only_never_used_at_runtime_pad_xxxxxxxxxxxxxxxx
ENV DATABASE_URL=file:/tmp/build-placeholder.db
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/server/node_modules ./apps/server/node_modules
# Bring in the remaining source
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server ./apps/server
# Extension isn't needed for the server image — skip apps/extension.
# Ensure a public dir exists so the runtime COPY doesn't fail on projects
# that have no static public assets.
RUN mkdir -p apps/server/public
RUN npm run build --workspace=server

# ---------- runtime ----------
FROM node:22-alpine AS runtime
WORKDIR /app
# home-operations: non-root default uid/gid 65534:65534
RUN addgroup -g 65534 -S nobody 2>/dev/null || true \
 && adduser -u 65534 -S -D -G nobody -H -s /sbin/nologin nobody 2>/dev/null || true \
 && mkdir -p /config /app && chown -R 65534:65534 /config /app

# Standalone output from Next.js + static + public + migrations
COPY --from=build --chown=65534:65534 /app/apps/server/.next/standalone/ /app/
COPY --from=build --chown=65534:65534 /app/apps/server/.next/static /app/apps/server/.next/static
COPY --from=build --chown=65534:65534 /app/apps/server/public /app/apps/server/public
COPY --from=build --chown=65534:65534 /app/apps/server/src/db/migrations /app/apps/server/src/db/migrations

ENV NODE_ENV=production \
    PORT=7393 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1 \
    MIGRATIONS_DIR=/app/apps/server/src/db/migrations \
    SITE_CONFIGS_DIR=/config/site-configs \
    STAGING_DIR=/config/staging

USER 65534:65534
EXPOSE 7393
VOLUME ["/config"]

# home-operations: single process per container, no init supervisor.
# server.js is produced by next build's standalone output.
CMD ["node", "apps/server/server.js"]

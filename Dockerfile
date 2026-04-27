# syntax=docker/dockerfile:1.9

# Pinned tool versions — Renovate auto-bumps via custom regex manager
# in renovate.json. See docs/operations/forge-tools.md for bump procedure.
ARG BLENDER_VERSION=4.2.3
ARG BLENDER_DOWNLOAD_BASE=https://download.blender.org/release

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

# ---------- forge-tools ----------
# Heavyweight tools (Blender, 7z) installed in a separate stage so they cache
# independently of the application code. Renovate bumps BLENDER_VERSION via
# a regex-manager in renovate.json; apt-installed p7zip-full bumps with the
# debian:bookworm-slim base image.
#
# Why a glibc base here (and a glibc runtime below): Blender ships a glibc
# linux-x64 tarball. Alpine's musl libc would require gcompat, which is
# unreliable for graphical/X11 deps. Debian-slim is the standard answer.
FROM debian:bookworm-slim AS forge-tools
ARG BLENDER_VERSION
ARG BLENDER_DOWNLOAD_BASE

# 7z (p7zip-full provides 7z + 7za). curl + xz-utils + ca-certificates are
# needed to fetch + extract the Blender tarball.
RUN apt-get update && \
    apt-get install -y --no-install-recommends p7zip-full curl xz-utils ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Blender — download the pinned linux-x64 tarball, extract to /opt/blender,
# and symlink onto PATH. The tarball's top-level directory is named
# "blender-<version>-linux-x64"; --strip-components=1 drops it.
RUN MAJOR_MINOR=$(echo "$BLENDER_VERSION" | cut -d. -f1-2) && \
    curl -fsSL -o /tmp/blender.tar.xz "${BLENDER_DOWNLOAD_BASE}/Blender${MAJOR_MINOR}/blender-${BLENDER_VERSION}-linux-x64.tar.xz" && \
    mkdir -p /opt/blender && \
    tar -xJf /tmp/blender.tar.xz -C /opt/blender --strip-components=1 && \
    rm /tmp/blender.tar.xz && \
    ln -s /opt/blender/blender /usr/local/bin/blender

# Build-time health check — fail fast if either binary is missing or broken.
# Blender headless needs a few X/audio libs (libxrender, libxi, libxxf86vm,
# libxfixes, libgl) that debian:bookworm-slim doesn't include by default.
# Install just the minimal set so `blender --version` succeeds.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libxrender1 libxi6 libxxf86vm1 libxfixes3 libxkbcommon0 \
        libgl1 libegl1 libsm6 libglib2.0-0 && \
    rm -rf /var/lib/apt/lists/* && \
    7z --help > /dev/null && \
    blender --version > /dev/null

# ---------- runtime ----------
# node:22-bookworm-slim (glibc) — required for the Blender tarball to run.
# better-sqlite3 + argon2 prebuilds exist for both Alpine (musl) and Debian
# (glibc); npm picks the right one at install time, so switching the runtime
# base doesn't break native modules.
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# Runtime-side install of 7z + the libs Blender needs to actually run.
# Copying apt-installed binaries across stages is brittle (shared libs,
# alternatives links); installing once more here is cheaper and reliable.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        p7zip-full \
        libxrender1 libxi6 libxxf86vm1 libxfixes3 libxkbcommon0 \
        libgl1 libegl1 libsm6 libglib2.0-0 && \
    rm -rf /var/lib/apt/lists/*

# Copy Blender tree from forge-tools and re-symlink onto PATH.
COPY --from=forge-tools /opt/blender /opt/blender
RUN ln -s /opt/blender/blender /usr/local/bin/blender

# home-operations: non-root default uid/gid 65534:65534. Debian's adduser
# already creates a `nogroup`/`nobody` (gid 65534/uid 65534) by default, so
# guard each step against "already exists" instead of always creating.
RUN (getent group 65534 > /dev/null || groupadd -g 65534 -r appgroup) && \
    (getent passwd 65534 > /dev/null || useradd -u 65534 -r -g 65534 -s /sbin/nologin appuser) && \
    mkdir -p /config /app && chown -R 65534:65534 /config /app

# Standalone output from Next.js + static + public + migrations
COPY --from=build --chown=65534:65534 /app/apps/server/.next/standalone/ /app/
COPY --from=build --chown=65534:65534 /app/apps/server/.next/static /app/apps/server/.next/static
COPY --from=build --chown=65534:65534 /app/apps/server/public /app/apps/server/public
COPY --from=build --chown=65534:65534 /app/apps/server/src/db/migrations /app/apps/server/src/db/migrations

# Final build-time health check. If any tool went missing during the COPY/
# symlink dance, fail the build now rather than at first dispatch.
RUN 7z --help > /dev/null && blender --version > /dev/null

ENV NODE_ENV=production \
    PORT=7393 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1 \
    MIGRATIONS_DIR=/app/apps/server/src/db/migrations \
    SITE_CONFIGS_DIR=/config/site-configs \
    STAGING_DIR=/config/staging
# Set FORGE_DISABLE_MESH_CONVERSION=1 in the deployment env to skip Blender
# invocations entirely. The image still bundles Blender; the converter
# returns {ok:false, reason:'disabled-by-config'} for any mesh pair.
# (T_b3 reads this env var; T_b2 only declares + documents the contract.)

USER 65534:65534
EXPOSE 7393
VOLUME ["/config"]

# home-operations: single process per container, no init supervisor.
# server.js is produced by next build's standalone output.
CMD ["node", "apps/server/server.js"]

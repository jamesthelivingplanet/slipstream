# syntax=docker/dockerfile:1

###############################################################################
# Slipstream pod image — runs the headless daemon (server.js) under plain Node.
#
# Unlike the desktop app, the pod build compiles better-sqlite3 / node-pty for
# the *Node* ABI (not Electron's) and runs the server with `node`, so the image
# carries no Electron binary and needs no GUI libraries. See docs/POD-DEPLOY.md.
###############################################################################

# -- Build stage --------------------------------------------------------------
FROM node:22-bookworm-slim AS build

# Toolchain for native modules (better-sqlite3, node-pty); python3/make/g++ are
# what node-gyp needs.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# We never run Electron in the image; skip its ~100MB binary download.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    npm_config_build_from_source=true

# .git is excluded from the build context (.dockerignore) so `git rev-parse`
# can't resolve a SHA inside the image build; thread it in from outside
# instead (CI passes --build-arg GIT_SHA=$CI_COMMIT_SHORT_SHA). See
# docs/VERSIONING.md and scripts/lib/buildMeta.mjs.
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA

WORKDIR /app
RUN corepack enable

# Install deps first for better layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Build the renderer (dist/) and the server bundle (dist-electron/server.js).
COPY . .
RUN pnpm build

# Drop dev dependencies (Electron, vite, ...) but keep the freshly compiled
# native modules the server needs at runtime.
RUN pnpm prune --prod

# -- Runtime stage ------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# git: clone-on-demand + push. curl: healthcheck. tini: PID 1 / signal reaping.
# The Claude Code CLI is what actually drives the agents — installed globally so
# `claude` is on PATH for every user.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code \
    && npm cache clean --force

# Non-root user — Claude Code refuses to run with --dangerously-skip-permissions
# as root, so the daemon MUST be unprivileged.
RUN useradd --uid 10001 --create-home --home-dir /home/slipstream --shell /bin/bash slipstream

WORKDIR /app
COPY --from=build /app/dist          ./dist
COPY --from=build /app/dist-electron ./dist-electron
COPY --from=build /app/node_modules  ./node_modules
COPY --from=build /app/package.json  ./package.json
COPY deploy/pod/entrypoint.sh /usr/local/bin/slipstream-entrypoint
RUN chmod +x /usr/local/bin/slipstream-entrypoint

ENV NODE_ENV=production \
    HOME=/home/slipstream \
    SLIPSTREAM_DATA_DIR=/home/slipstream/state \
    SLIPSTREAM_BIND=127.0.0.1 \
    SLIPSTREAM_PORT=7421

# Persist DB, cloned repos, worktrees, and Claude auth across restarts.
VOLUME ["/home/slipstream"]
EXPOSE 7421

USER slipstream

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${SLIPSTREAM_PORT}/healthz" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/slipstream-entrypoint"]

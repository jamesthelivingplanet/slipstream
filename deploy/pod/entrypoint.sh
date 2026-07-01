#!/usr/bin/env bash
set -euo pipefail

# Configure git identity + credentials for clone-on-demand and push, if provided.
if [[ -n "${GIT_USER_NAME:-}" ]]; then
  git config --global user.name "$GIT_USER_NAME"
fi
if [[ -n "${GIT_USER_EMAIL:-}" ]]; then
  git config --global user.email "$GIT_USER_EMAIL"
fi
if [[ -n "${GH_TOKEN:-}" ]]; then
  git config --global credential.helper store
  printf 'https://x-access-token:%s@github.com\n' "$GH_TOKEN" > "$HOME/.git-credentials"
  chmod 600 "$HOME/.git-credentials"
fi

if [[ -z "${SLIPSTREAM_TOKEN:-}" ]]; then
  echo "[slipstream] SLIPSTREAM_TOKEN is required but not set. Refusing to start." >&2
  echo "[slipstream] Generate one with:  openssl rand -hex 16" >&2
  exit 1
fi

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "[slipstream] WARNING: ANTHROPIC_API_KEY is not set — agents will fail to authenticate." >&2
  echo "[slipstream] Set it in your .env, or run 'claude login' against the mounted volume." >&2
fi

exec node /app/dist-electron/server.js

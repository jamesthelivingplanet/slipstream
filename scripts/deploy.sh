#!/usr/bin/env bash
# deploy.sh — build Flotilla and restart the headless server via systemd
#
# Usage:
#   pnpm deploy                  # full quality-gate + build + restart + healthcheck
#   SKIP_CHECKS=1 pnpm deploy    # skip pnpm check / pnpm test
#   pnpm deploy --skip-checks    # same via CLI flag
#
# Environment (optional, sourced from ~/.config/flotilla/server.env):
#   FLOTILLA_BIND   bind address for the server   (default: 127.0.0.1)
#   FLOTILLA_PORT   port the server listens on     (default: 7421)

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve repo root relative to this script so no absolute paths are hardcoded
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# Parse flags
# ---------------------------------------------------------------------------
SKIP_CHECKS="${SKIP_CHECKS:-0}"

for arg in "$@"; do
  case "$arg" in
    --skip-checks)
      SKIP_CHECKS=1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Phase 1: Quality gates
# ---------------------------------------------------------------------------
if [[ "$SKIP_CHECKS" == "1" ]]; then
  echo "⚠  Skipping quality gates (SKIP_CHECKS=1 or --skip-checks passed)."
else
  echo "▶ Running type-check (pnpm check)…"
  pnpm check

  echo "▶ Running tests (pnpm test)…"
  pnpm test
fi

# ---------------------------------------------------------------------------
# Phase 2: Build
# ---------------------------------------------------------------------------
echo "▶ Building (pnpm build)…"
pnpm build

# ---------------------------------------------------------------------------
# Phase 3: Restart the systemd user service
# ---------------------------------------------------------------------------
echo "▶ Restarting flotilla.service…"
if ! systemctl --user restart flotilla.service 2>/dev/null; then
  echo ""
  echo "✗ 'systemctl --user restart flotilla.service' failed."
  echo "  This is expected if the systemd service is not set up on this machine."
  echo "  To set it up, create ~/.config/systemd/user/flotilla.service and run:"
  echo "    systemctl --user daemon-reload"
  echo "    systemctl --user enable flotilla.service"
  exit 1
fi

# ---------------------------------------------------------------------------
# Phase 4: Health check
# ---------------------------------------------------------------------------

# Source optional server config to pick up bind/port
SERVER_ENV_FILE="${HOME}/.config/flotilla/server.env"
if [[ -f "$SERVER_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$SERVER_ENV_FILE"
fi

BIND="${FLOTILLA_BIND:-127.0.0.1}"
PORT="${FLOTILLA_PORT:-7421}"
HEALTH_URL="http://${BIND}:${PORT}/healthz"

echo "▶ Waiting for server at ${HEALTH_URL}…"

MAX_ATTEMPTS=10
attempt=0
success=0

while [[ $attempt -lt $MAX_ATTEMPTS ]]; do
  attempt=$(( attempt + 1 ))

  http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "$HEALTH_URL" 2>/dev/null || true)

  if [[ "$http_code" == "200" ]]; then
    success=1
    break
  fi

  echo "  Attempt ${attempt}/${MAX_ATTEMPTS}: got '${http_code}', retrying…"
  # Sleep between 0.5s and 1s to avoid hammering the service during startup
  sleep 0.75
done

if [[ "$success" == "1" ]]; then
  echo ""
  echo "✔ Flotilla is up and healthy!"
  echo "  Health URL : ${HEALTH_URL}"
  echo "  Access URL : http://${BIND}:${PORT}/"
  echo ""
  echo "  If you're connecting from a mobile device or another machine, reload"
  echo "  the browser tab to pick up the latest UI."
else
  echo ""
  echo "✗ Server did not become healthy after ${MAX_ATTEMPTS} attempts."
  echo "  Recent service logs:"
  echo ""
  journalctl --user -u flotilla -n 30 --no-pager 2>/dev/null || \
    echo "  (journalctl unavailable — check service logs manually)"
  exit 1
fi

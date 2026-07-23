#!/usr/bin/env bash
# deploy.sh — build Slipstream and restart the headless server via systemd
#
# Usage:
#   pnpm deploy                  # full quality-gate + build + restart + healthcheck
#   SKIP_CHECKS=1 pnpm deploy    # skip pnpm check / pnpm test
#   pnpm deploy --skip-checks    # same via CLI flag
#
# Environment (optional, sourced from ~/.config/slipstream/server.env):
#   SLIPSTREAM_BIND   bind address for the server   (default: 127.0.0.1)
#   SLIPSTREAM_PORT   port the server listens on     (default: 7421)
#
# Phase 5 publishes the app over Tailscale HTTPS via 'tailscale serve'; this
# requires HTTPS Certificates to be enabled for the tailnet (Tailscale admin
# console → DNS page: https://login.tailscale.com/admin/dns).
#
# Phase 6 publishes the newest dist-apk/slipstream-<version>.apk (built by
# 'pnpm release', see scripts/lib/apk.sh) into dist/ so it's downloadable at
# .../slipstream-latest.apk over the daemon's static route — best-effort; a
# one-line note is printed instead if no APK has been built yet.

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve repo root relative to this script so no absolute paths are hardcoded
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# Node 22 enforcement — needed for native module ABI compatibility with Electron 33.
# with_node22 lives in scripts/lib/node22.sh (shared with setup.sh).
# ---------------------------------------------------------------------------
# shellcheck source=lib/node22.sh
source "$SCRIPT_DIR/lib/node22.sh"
# shellcheck source=lib/apk.sh
source "$SCRIPT_DIR/lib/apk.sh"
# shellcheck source=lib/tailscale.sh
source "$SCRIPT_DIR/lib/tailscale.sh"

# ---------------------------------------------------------------------------
# Onboarding QR code — printed at the end of each success path so a phone can
# scan straight into the (optionally tokenized) app URL.
# ---------------------------------------------------------------------------
print_onboarding_qr() {
  local url="$1"
  echo ""
  echo "  Onboarding URL : ${url}"
  if command -v qrencode &>/dev/null; then
    qrencode -t ansiutf8 "${url}"
  else
    echo "  (install qrencode to show a scannable QR code)"
  fi
}

# ---------------------------------------------------------------------------
# APK download — publishes the newest dist-apk/slipstream-<version>.apk (built
# by 'pnpm release', see scripts/lib/apk.sh) into dist/ so the daemon's static
# route can serve it, then prints a download URL + QR. Best-effort: if no APK
# has ever been built, prints a one-line note and does not fail the deploy.
# ---------------------------------------------------------------------------
print_apk_download() {
  local base_url="$1"

  if ! apk_publish_to_dist "$REPO_ROOT/dist"; then
    echo "  (no APK found in dist-apk/ yet — run 'pnpm release' to build one)"
    return 0
  fi

  local apk_path versioned
  apk_path="$(apk_latest)"
  versioned="$(basename "$apk_path")"

  echo ""
  echo "  App download : ${base_url}/slipstream-latest.apk"
  echo "                 (versioned: ${base_url}/${versioned})"
  print_onboarding_qr "${base_url}/slipstream-latest.apk"
}

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
with_node22 pnpm build

# Assert the CJS preload invariant post-build (FLO-80, flipped by FLO-84):
# preload.cjs must load as CommonJS with no top-level import/export, or
# window.slipstream never loads.
node scripts/check-preload-cjs.mjs

# ---------------------------------------------------------------------------
# Phase 3: Restart the service (OS-aware: systemd on Linux, launchd on macOS)
# ---------------------------------------------------------------------------
echo "▶ Restarting slipstream service…"
_DEPLOY_OS="$(uname -s)"
if [[ "$_DEPLOY_OS" == "Linux" ]]; then
  if ! systemctl --user restart slipstream.service 2>/dev/null; then
    echo ""
    echo "✗ 'systemctl --user restart slipstream.service' failed."
    echo "  The systemd service may not be installed on this machine."
    echo "  Run 'pnpm setup' to install and enable it, then re-run 'pnpm deploy'."
    exit 1
  fi
elif [[ "$_DEPLOY_OS" == "Darwin" ]]; then
  if ! launchctl kickstart -k "gui/$(id -u)/com.slipstream.server" 2>/dev/null; then
    echo ""
    echo "✗ 'launchctl kickstart -k gui/$(id -u)/com.slipstream.server' failed."
    echo "  The LaunchAgent may not be installed on this machine."
    echo "  Run 'pnpm setup' to install and register it, then re-run 'pnpm deploy'."
    exit 1
  fi
else
  echo ""
  echo "✗ Unsupported OS: $_DEPLOY_OS — cannot restart service automatically."
  exit 1
fi

# ---------------------------------------------------------------------------
# Phase 4: Health check
# ---------------------------------------------------------------------------

# Source optional server config to pick up bind/port
SERVER_ENV_FILE="${HOME}/.config/slipstream/server.env"
if [[ -f "$SERVER_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$SERVER_ENV_FILE"
fi

BIND="${SLIPSTREAM_BIND:-127.0.0.1}"
PORT="${SLIPSTREAM_PORT:-7421}"
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
  echo "✔ Slipstream is up and healthy!"
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
  journalctl --user -u slipstream -n 30 --no-pager 2>/dev/null || \
    echo "  (journalctl unavailable — check service logs manually)"
  exit 1
fi

# ---------------------------------------------------------------------------
# Phase 5: Tailscale HTTPS serve
# ---------------------------------------------------------------------------
# Remote-access mode is recorded in server.env as SLIPSTREAM_SERVE.
# Default to 'tailscale' for backward-compat with installs predating this var.
if [[ "${SLIPSTREAM_SERVE:-tailscale}" == "none" ]]; then
  echo "▶ Tailscale serve is disabled (SLIPSTREAM_SERVE=none)."
  echo "  The app is reachable only locally at http://127.0.0.1:${PORT}/."
  echo "  To expose it remotely, put your own HTTPS origin in front of it, or"
  echo "  re-run 'pnpm setup' and choose Tailscale."
  echo ""
  echo "✔ Deploy complete (local-only)."
  if [[ -n "${SLIPSTREAM_TOKEN:-}" ]]; then
    url="http://${BIND}:${PORT}/?token=${SLIPSTREAM_TOKEN}"
    print_onboarding_qr "$url"
  else
    echo "  (no SLIPSTREAM_TOKEN found in server.env — skipping tokenized onboarding URL)"
  fi
  print_apk_download "http://${BIND}:${PORT}"
  exit 0
fi

echo "▶ Publishing over Tailscale HTTPS…"

if ! command -v tailscale &>/dev/null; then
  echo ""
  echo "✗ tailscale is not installed — HTTPS serve was skipped."
  echo "  Install Tailscale and re-run the deploy to publish over HTTPS."
  echo "  Without HTTPS, mobile devices cannot reach the app securely."
  exit 1
fi

if ! tailscale serve --bg --https=443 "http://127.0.0.1:${PORT}"; then
  echo ""
  echo "╔══════════════════════════════════════════════════════════════════╗"
  echo "║  ✗  tailscale serve failed — deploy is incomplete               ║"
  echo "╠══════════════════════════════════════════════════════════════════╣"
  echo "║  Most likely cause: HTTPS Certificates are not enabled for       ║"
  echo "║  this tailnet.                                                   ║"
  echo "║                                                                  ║"
  echo "║  Fix: go to the Tailscale admin console → DNS page and enable   ║"
  echo "║  HTTPS Certificates:                                             ║"
  echo "║    https://login.tailscale.com/admin/dns                        ║"
  echo "║                                                                  ║"
  echo "║  Until this succeeds, phones and other devices cannot reach the  ║"
  echo "║  app over HTTPS.                                                 ║"
  echo "╚══════════════════════════════════════════════════════════════════╝"
  exit 1
fi

# Derive tailnet DNS name without requiring jq
TS_DNS="$(ts_dns)"

echo ""
if [[ -n "$TS_DNS" ]]; then
  # Best-effort HTTPS health check — cert propagation / DNS can lag, so non-200 is informational only
  https_code="$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "https://${TS_DNS}/healthz" 2>/dev/null)" || true
  echo "✔ Tailscale HTTPS serve is active!"
  echo "  HTTPS health check : https://${TS_DNS}/healthz → ${https_code} (best-effort; lag expected)"
  echo "  Access URL         : https://${TS_DNS}/"
  echo ""
  echo "  Mobile devices: reload the browser tab to pick up the latest UI."
  if [[ -n "${SLIPSTREAM_TOKEN:-}" ]]; then
    url="https://${TS_DNS}/?token=${SLIPSTREAM_TOKEN}"
    print_onboarding_qr "$url"
  else
    echo "  (no SLIPSTREAM_TOKEN found in server.env — skipping tokenized onboarding URL)"
  fi

  # -------------------------------------------------------------------------
  # Phase 6: Publish newest APK for download
  # -------------------------------------------------------------------------
  print_apk_download "https://${TS_DNS}"
else
  echo "✔ Tailscale HTTPS serve is active!"
  echo "  (Could not derive tailnet DNS name — current serve config:)"
  tailscale serve status || true
  echo ""
  echo "  Mobile devices: reload the browser tab to pick up the latest UI."
fi

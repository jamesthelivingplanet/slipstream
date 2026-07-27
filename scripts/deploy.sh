#!/usr/bin/env bash
# deploy.sh — build Slipstream and restart the running instance via systemd
#
# Two targets:
#   prod   The shared production instance: systemd user unit
#          'slipstream.service', ~/.config/slipstream/server.env, port 7421,
#          published via 'tailscale serve --https=443'. Only deployable from
#          the main checkout (~/.repositories/slipstream).
#   dev    An isolated per-worktree dev instance: systemd template unit
#          'slipstream-dev@<slug>.service', its own port/tsPort/data dir
#          allocated by scripts/dev-slot.mjs (scripts/lib/devSlots.mjs),
#          published via 'tailscale serve --https=<tsPort>' (never :443).
#
# Target resolution (scripts/lib/target.sh):
#   - A LINKED git worktree (e.g. a per-ticket worktree under
#     .claude/worktrees/) always resolves to 'dev' — structurally, not by
#     path matching. This is a HARD GUARD: no --target flag and no
#     SLIPSTREAM_TARGET env var can make a linked worktree deploy 'prod'; the
#     script exits 1 immediately if that's attempted. This is deliberate —
#     production must only ever be deployed from the main checkout.
#   - The main worktree defaults to 'prod', or honors SLIPSTREAM_TARGET=dev
#     (or --target=dev) if you want to run a dev instance from there too.
#
# Usage:
#   pnpm deploy                  # full quality-gate + build + restart + healthcheck
#   pnpm deploy --target=dev     # force the dev path from the main worktree
#   SKIP_CHECKS=1 pnpm deploy    # skip pnpm check / pnpm test
#   pnpm deploy --skip-checks    # same via CLI flag
#
# Environment (optional, sourced from ~/.config/slipstream/server.env for
# target=prod; the dev path reads its own ~/.config/slipstream/dev-slots/<slug>.env):
#   SLIPSTREAM_BIND   bind address for the server   (default: 127.0.0.1)
#   SLIPSTREAM_PORT   port the server listens on     (default: 7421)
#
# --- prod path ---
# Phase 5 publishes the app over Tailscale HTTPS via 'tailscale serve'; this
# requires HTTPS Certificates to be enabled for the tailnet (Tailscale admin
# console → DNS page: https://login.tailscale.com/admin/dns).
#
# Phase 6 publishes the newest dist-apk/slipstream-<version>.apk (built by
# 'pnpm release', see scripts/lib/apk.sh) into dist/ so it's downloadable at
# .../slipstream-latest.apk over the daemon's static route — best-effort; a
# one-line note is printed instead if no APK has been built yet.
#
# --- dev path ---
# Reuses phases 1-2 (quality gates + build), then allocates/reuses this
# worktree's dev slot, (re-)materializes the shared dev scaffolding so a
# fresh worktree is self-healing with no 'pnpm setup' re-run, verifies its
# native modules (better-sqlite3, node-pty — see scripts/lib/nativeAbi.sh)
# load under Electron's ABI and rebuilds them if not (a fresh worktree's
# 'pnpm install' only ever builds them for plain Node's ABI), restarts its
# own 'slipstream-dev@<slug>.service', health-checks it, and publishes it
# over Tailscale on its own tsPort. Never runs Phase 6 (APK publish).

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
# shellcheck source=lib/target.sh
source "$SCRIPT_DIR/lib/target.sh"
# shellcheck source=lib/devScaffold.sh
source "$SCRIPT_DIR/lib/devScaffold.sh"
# shellcheck source=lib/nativeAbi.sh
source "$SCRIPT_DIR/lib/nativeAbi.sh"

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
# wait_for_health <url> — polls <url> for HTTP 200, up to 10 attempts ~0.75s
# apart. Returns 0 on success, 1 on timeout. Shared by both targets' health
# checks; each caller prints its own success/failure messaging since the
# access URLs and log sources differ between prod and dev.
# ---------------------------------------------------------------------------
wait_for_health() {
  local url="$1"
  local max_attempts=10
  local attempt=0
  local http_code

  echo "▶ Waiting for server at ${url}…"

  while [[ $attempt -lt $max_attempts ]]; do
    attempt=$(( attempt + 1 ))

    http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "$url" 2>/dev/null || true)

    if [[ "$http_code" == "200" ]]; then
      return 0
    fi

    echo "  Attempt ${attempt}/${max_attempts}: got '${http_code}', retrying…"
    # Sleep between 0.5s and 1s to avoid hammering the service during startup
    sleep 0.75
  done

  return 1
}

# ---------------------------------------------------------------------------
# Parse flags
# ---------------------------------------------------------------------------
SKIP_CHECKS="${SKIP_CHECKS:-0}"
TARGET_ARG=""

for arg in "$@"; do
  case "$arg" in
    --skip-checks)
      SKIP_CHECKS=1
      ;;
    --target=dev|--target=prod)
      TARGET_ARG="${arg#--target=}"
      ;;
    --target=*)
      echo "✗ Unknown --target value: '${arg#--target=}' (expected 'dev' or 'prod')" >&2
      exit 1
      ;;
  esac
done

if [[ -n "$TARGET_ARG" ]]; then
  SLIPSTREAM_TARGET="$TARGET_ARG"
fi

# ---------------------------------------------------------------------------
# Resolve target FIRST, before any other phase — and hard-guard prod.
#
# A linked worktree can NEVER deploy 'prod': not via --target=prod, not via
# SLIPSTREAM_TARGET=prod, no exceptions. This check runs against the
# requested value directly (not slipstream_resolve_target's output, which
# would just silently coerce a linked worktree to 'dev') so an explicit
# attempt to target prod from a linked worktree is a loud error, not a
# silent downgrade.
# ---------------------------------------------------------------------------
if [[ "${SLIPSTREAM_TARGET:-}" == "prod" ]] && slipstream_is_linked_worktree; then
  echo "✗ Refusing to deploy target=prod from a linked git worktree." >&2
  echo "  This checkout is a linked worktree ($(git rev-parse --show-toplevel 2>/dev/null || echo "$REPO_ROOT"))," >&2
  echo "  not the main checkout. Production can only be deployed from the main" >&2
  echo "  checkout (~/.repositories/slipstream) — this guard is deliberate and" >&2
  echo "  cannot be overridden by a flag or environment variable from here." >&2
  echo "  Run 'pnpm deploy' (no --target, or --target=dev) to deploy this" >&2
  echo "  worktree's own isolated dev instance instead." >&2
  exit 1
fi

TARGET="$(slipstream_resolve_target)"

if slipstream_is_linked_worktree; then
  echo "▶ target: dev (linked worktree — production is protected)"
elif [[ "$TARGET" == "dev" ]]; then
  echo "▶ target: dev (SLIPSTREAM_TARGET=dev requested from the main checkout)"
else
  echo "▶ target: prod"
fi

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

# ===========================================================================
# Dev path — isolated per-worktree instance. Never touches production.
# ===========================================================================
if [[ "$TARGET" == "dev" ]]; then
  # -------------------------------------------------------------------------
  # a. Prune stale slots (best-effort — a failure here must not fail the deploy)
  # -------------------------------------------------------------------------
  echo "▶ Pruning stale dev slots…"
  node "$SCRIPT_DIR/dev-slot.mjs" prune || true

  # -------------------------------------------------------------------------
  # b. Allocate (or reuse) this worktree's dev slot
  # -------------------------------------------------------------------------
  echo "▶ Acquiring dev slot for ${REPO_ROOT}…"
  eval "$(node "$SCRIPT_DIR/dev-slot.mjs" acquire --root "$REPO_ROOT")"

  echo "  Slug: ${SLIPSTREAM_SLOT_SLUG}  Port: ${SLIPSTREAM_SLOT_PORT}  TS port: ${SLIPSTREAM_SLOT_TS_PORT}"

  # -------------------------------------------------------------------------
  # c. Re-materialize the shared dev scaffolding (systemd template + wrapper
  # + dev-slots dir) so a fresh worktree is self-healing with no 'pnpm setup'
  # re-run. Same content as scripts/setup.sh — both source
  # scripts/lib/devScaffold.sh so there is exactly one copy.
  # -------------------------------------------------------------------------
  echo "▶ Materializing dev-instance scaffolding…"
  slipstream_install_dev_scaffold

  # -------------------------------------------------------------------------
  # d. Write this slot's env file, preserving an existing SLIPSTREAM_TOKEN
  # -------------------------------------------------------------------------
  SLOT_ENV_FILE="${HOME}/.config/slipstream/dev-slots/${SLIPSTREAM_SLOT_SLUG}.env"

  EXISTING_TOKEN=""
  if [[ -f "$SLOT_ENV_FILE" ]]; then
    EXISTING_TOKEN="$(grep '^SLIPSTREAM_TOKEN=' "$SLOT_ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)" || true
  fi

  if [[ -n "$EXISTING_TOKEN" ]]; then
    SLOT_TOKEN="$EXISTING_TOKEN"
  elif command -v openssl &>/dev/null; then
    SLOT_TOKEN="$(openssl rand -hex 16)"
  elif command -v xxd &>/dev/null; then
    SLOT_TOKEN="$(head -c16 /dev/urandom | xxd -p | tr -d '\n')"
  else
    echo "✗ Neither openssl nor xxd is available — cannot generate a dev SLIPSTREAM_TOKEN." >&2
    exit 1
  fi

  mkdir -p "$SLIPSTREAM_SLOT_DATA_DIR"
  chmod 700 "$SLIPSTREAM_SLOT_DATA_DIR"

  # -------------------------------------------------------------------------
  # Derive the main worktree's checkout path structurally (never hardcoded)
  # so the sandbox can ro-bind-protect production's repo — see
  # electron/services/agentSandbox.ts's prodRepoRoot handling.
  # `git rev-parse --git-common-dir` gives `<main>/.git` for both the main
  # worktree and any linked worktree; its dirname is the main worktree root.
  # Skip the key entirely if it can't be derived (best-effort, never fatal).
  # -------------------------------------------------------------------------
  PROD_REPO_ROOT=""
  GIT_COMMON_DIR_RAW="$(git rev-parse --git-common-dir 2>/dev/null)" || true
  if [[ -n "$GIT_COMMON_DIR_RAW" ]]; then
    if GIT_COMMON_DIR_ABS="$(cd "$GIT_COMMON_DIR_RAW" 2>/dev/null && pwd)"; then
      PROD_REPO_ROOT="$(dirname "$GIT_COMMON_DIR_ABS")"
    fi
  fi

  cat > "$SLOT_ENV_FILE" <<EOF
SLIPSTREAM_TOKEN=${SLOT_TOKEN}
SLIPSTREAM_BIND=127.0.0.1
SLIPSTREAM_PORT=${SLIPSTREAM_SLOT_PORT}
SLIPSTREAM_SERVE=tailscale
SLIPSTREAM_DATA_DIR=${SLIPSTREAM_SLOT_DATA_DIR}
SLIPSTREAM_DEV_ROOT=${REPO_ROOT}
SLIPSTREAM_SANDBOX=bwrap
SLIPSTREAM_PROD_DATA_DIR=${HOME}/.config/slipstream
EOF
  if [[ -n "$PROD_REPO_ROOT" ]]; then
    echo "SLIPSTREAM_PROD_REPO_ROOT=${PROD_REPO_ROOT}" >> "$SLOT_ENV_FILE"
  fi
  echo "ELECTRON_RUN_AS_NODE=1" >> "$SLOT_ENV_FILE"
  chmod 600 "$SLOT_ENV_FILE"
  echo "✔ Slot env written: ${SLOT_ENV_FILE}"

  # -------------------------------------------------------------------------
  # e. Verify native modules (better-sqlite3, node-pty) load under Electron's
  # ABI, and self-heal if not. Every checkout's node_modules comes from
  # 'pnpm install', which builds these against plain Node's ABI; only an
  # explicit '@electron/rebuild' (which 'pnpm setup' runs for the main
  # checkout) targets Electron's ABI instead — and nothing did that for a
  # freshly-created worktree. Without this, the dev daemon crash-loops in
  # openDb() with ERR_DLOPEN_FAILED (docs/NATIVE-MODULES.md). Dev path only —
  # prod's native modules are handled once by 'pnpm setup' on the main
  # checkout and never touched here.
  # -------------------------------------------------------------------------
  echo "▶ Checking native modules (better-sqlite3, node-pty) against Electron's ABI…"
  if ! slipstream_native_abi_ok "$REPO_ROOT"; then
    echo "  ✗ Native modules are built for Node's ABI, not Electron's — the daemon"
    echo "    runs under Electron, so it can't load them as-is (ERR_DLOPEN_FAILED)."
    echo "  ▶ Rebuilding for Electron's ABI (first time in a worktree: a few"
    echo "    minutes; a no-op check like this one is instant afterward)…"
    if ! slipstream_native_rebuild "$REPO_ROOT"; then
      echo ""
      echo "✗ Native module rebuild failed." >&2
      echo "  Run manually: pnpm dlx @electron/rebuild --force --only better-sqlite3,node-pty" >&2
      echo "  See docs/NATIVE-MODULES.md for troubleshooting." >&2
      exit 1
    fi
    if ! slipstream_native_abi_ok "$REPO_ROOT"; then
      echo ""
      echo "✗ Native modules still don't load under Electron's ABI after rebuilding." >&2
      echo "  Run manually: pnpm dlx @electron/rebuild --force --only better-sqlite3,node-pty" >&2
      echo "  See docs/NATIVE-MODULES.md for troubleshooting." >&2
      exit 1
    fi
    echo "  ✔ Native modules now load under Electron's ABI."
  else
    echo "  ✔ Native modules already match Electron's ABI."
  fi

  # -------------------------------------------------------------------------
  # f. Restart this slot's service instance
  # -------------------------------------------------------------------------
  # NOT systemd-escape'd: SLIPSTREAM_SLOT_SLUG (from slugForRoot() in
  # scripts/lib/devSlots.mjs) is already restricted to [A-Za-z0-9_.-], which
  # is a valid systemd template instance name verbatim. Escaping it here
  # would desync the unit's `%i` instance name from the plain-slug env
  # filename this same function wrote above (dev-slots/<slug>.env) — that
  # mismatch is exactly what breaks the restart for any hyphenated slug.
  # Keep in sync with devUnitName() in scripts/lib/devSlots.mjs.
  DEV_UNIT="slipstream-dev@${SLIPSTREAM_SLOT_SLUG}.service"

  echo "▶ Restarting ${DEV_UNIT}…"
  if ! systemctl --user restart "$DEV_UNIT" 2>/dev/null; then
    echo ""
    echo "✗ 'systemctl --user restart ${DEV_UNIT}' failed."
    echo "  Recent logs for ${DEV_UNIT}:"
    echo ""
    journalctl --user -u "$DEV_UNIT" -n 30 --no-pager 2>/dev/null || \
      echo "  (journalctl unavailable — check service logs manually)"
    exit 1
  fi

  # -------------------------------------------------------------------------
  # g. Health check
  # -------------------------------------------------------------------------
  DEV_HEALTH_URL="http://127.0.0.1:${SLIPSTREAM_SLOT_PORT}/healthz"

  if wait_for_health "$DEV_HEALTH_URL"; then
    echo ""
    echo "✔ Dev instance (${SLIPSTREAM_SLOT_SLUG}) is up and healthy!"
    echo "  Health URL : ${DEV_HEALTH_URL}"
    echo "  Access URL : http://127.0.0.1:${SLIPSTREAM_SLOT_PORT}/"
  else
    echo ""
    echo "✗ Dev instance (${SLIPSTREAM_SLOT_SLUG}) did not become healthy after 10 attempts."
    echo "  Recent logs for ${DEV_UNIT}:"
    echo ""
    journalctl --user -u "$DEV_UNIT" -n 30 --no-pager 2>/dev/null || \
      echo "  (journalctl unavailable — check service logs manually)"
    exit 1
  fi

  # -------------------------------------------------------------------------
  # h. Tailscale HTTPS serve on this slot's own tsPort — never :443.
  # Best-effort: unlike prod, a missing/failing tailscale does not fail the
  # dev deploy, since the dev instance is already reachable locally.
  # -------------------------------------------------------------------------
  echo ""
  echo "▶ Publishing dev instance over Tailscale HTTPS (:${SLIPSTREAM_SLOT_TS_PORT})…"

  DEV_TS_DNS=""
  if ! command -v tailscale &>/dev/null; then
    echo "  (tailscale not installed — skipping remote HTTPS publish for this dev instance;"
    echo "   it's still reachable locally at http://127.0.0.1:${SLIPSTREAM_SLOT_PORT}/)"
  elif ! tailscale serve --bg --https="${SLIPSTREAM_SLOT_TS_PORT}" "http://127.0.0.1:${SLIPSTREAM_SLOT_PORT}"; then
    echo "  ⚠  'tailscale serve --https=${SLIPSTREAM_SLOT_TS_PORT}' failed — continuing without remote HTTPS."
    echo "     The dev instance is still reachable locally at http://127.0.0.1:${SLIPSTREAM_SLOT_PORT}/."
  else
    DEV_TS_DNS="$(ts_dns)"
    if [[ -n "$DEV_TS_DNS" ]]; then
      echo "  ✔ Tailscale HTTPS serve is active on :${SLIPSTREAM_SLOT_TS_PORT}"
      echo "    Tailnet URL: https://${DEV_TS_DNS}:${SLIPSTREAM_SLOT_TS_PORT}/"
      print_onboarding_qr "https://${DEV_TS_DNS}:${SLIPSTREAM_SLOT_TS_PORT}/?token=${SLOT_TOKEN}"
    else
      echo "  ✔ Tailscale HTTPS serve is active on :${SLIPSTREAM_SLOT_TS_PORT} (could not derive tailnet DNS name)"
    fi
  fi

  # -------------------------------------------------------------------------
  # i. Summary — no Phase 6 (APK publish) on the dev path.
  # -------------------------------------------------------------------------
  echo ""
  echo "══════════════════════════════════════════════════════════════"
  echo "✔ Dev deploy complete!"
  echo "  Slug        : ${SLIPSTREAM_SLOT_SLUG}"
  echo "  Port        : ${SLIPSTREAM_SLOT_PORT}"
  echo "  TS port     : ${SLIPSTREAM_SLOT_TS_PORT}"
  echo "  Data dir    : ${SLIPSTREAM_SLOT_DATA_DIR}"
  echo "  Local URL   : http://127.0.0.1:${SLIPSTREAM_SLOT_PORT}/"
  if [[ -n "$DEV_TS_DNS" ]]; then
    echo "  Tailnet URL : https://${DEV_TS_DNS}:${SLIPSTREAM_SLOT_TS_PORT}/"
  fi
  echo ""
  echo "  Production on :7421 was NOT touched."
  echo "══════════════════════════════════════════════════════════════"
  exit 0
fi

# ===========================================================================
# Prod path — unchanged from the pre-dev-target behavior of this script.
# ===========================================================================

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

if wait_for_health "$HEALTH_URL"; then
  echo ""
  echo "✔ Slipstream is up and healthy!"
  echo "  Health URL : ${HEALTH_URL}"
  echo "  Access URL : http://${BIND}:${PORT}/"
  echo ""
  echo "  If you're connecting from a mobile device or another machine, reload"
  echo "  the browser tab to pick up the latest UI."
else
  echo ""
  echo "✗ Server did not become healthy after 10 attempts."
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

#!/usr/bin/env bash
# setup.sh — one-time, idempotent per-machine bootstrap for Slipstream
#
# Usage: pnpm setup   (or: bash scripts/setup.sh)
#
# What it does (prep only — does NOT build or start the service):
#   a. Detects Linux or macOS; fails on anything else
#   b. Checks prereqs (pnpm required; node 22+, claude, tailscale, openssl warned/noted)
#   c. pnpm install + @electron/rebuild for native ABI; verifies electron binary
#   d. Generates ~/.config/slipstream/server.env (token + bind + port) if absent
#   e. Installs systemd unit (Linux) or LaunchAgent plist (macOS); enables but does NOT start
#   f. Tailscale cert detection + admin-console guidance (informational only)
#   g. Summary: what's next is 'pnpm deploy'

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# ---------------------------------------------------------------------------
# Node 22 enforcement — needed for native module ABI compatibility with Electron 33
# ---------------------------------------------------------------------------
with_node22() {
  if node -e "process.exit(Number(/^v22/.test(process.version))?0:1)" 2>/dev/null; then
    "$@"
  elif command -v mise &>/dev/null; then
    echo "  Using Node 22 via mise…"
    mise install node@22 2>/dev/null || true
    mise exec node@22 -- "$@"
  else
    echo "✗ Node 22 is required but $(node --version 2>/dev/null || echo 'none') was detected."
    exit 1
  fi
}

echo ""
echo "▶ Slipstream setup"
echo "  Repo: $REPO_ROOT"
echo ""

# ---------------------------------------------------------------------------
# a. OS detection
# ---------------------------------------------------------------------------
OS="$(uname -s)"
case "$OS" in
  Linux)
    echo "✔ OS: Linux"
    ;;
  Darwin)
    echo "✔ OS: macOS (Darwin)"
    ;;
  *)
    echo "✗ Unsupported OS: $OS"
    echo "  Slipstream setup supports Linux and macOS only."
    exit 1
    ;;
esac

# ---------------------------------------------------------------------------
# b. Prereq checks
# ---------------------------------------------------------------------------
echo ""
echo "▶ Checking prerequisites…"

# pnpm — required
if ! command -v pnpm &>/dev/null; then
  echo "✗ pnpm is not installed — required."
  echo "  Install: https://pnpm.io/installation"
  exit 1
fi
echo "✔ pnpm: $(pnpm --version)"

# node — warn if older than 22
if command -v node &>/dev/null; then
  NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
  if [[ "$NODE_MAJOR" -lt 22 ]]; then
    echo "⚠  node $(node --version) detected — Node 22+ is required for native module builds."
    echo "   The setup script will use Node 22 via mise for install steps."
  else
    echo "✔ node: $(node --version)"
  fi
else
  echo "⚠  node not found on PATH — required to run pnpm scripts."
fi

# claude CLI — warn if missing
if ! command -v claude &>/dev/null; then
  echo "⚠  claude not found on PATH."
  echo "   Needed to actually run agents. Install Claude Code and authenticate:"
  echo "   https://docs.anthropic.com/claude-code"
else
  echo "✔ claude: $(claude --version 2>/dev/null | head -1 || echo 'found')"
fi

# tailscale — warn if missing
if ! command -v tailscale &>/dev/null; then
  echo "⚠  tailscale not found on PATH."
  echo "   Needed for HTTPS access from phone/other devices; 'pnpm deploy' Phase 5 requires it."
  echo "   Install: https://tailscale.com/download"
  TAILSCALE_AVAILABLE=0
else
  echo "✔ tailscale: found"
  TAILSCALE_AVAILABLE=1
fi

# openssl — needed for token generation; fall back to /dev/urandom+xxd; fail if neither
TOKEN_CMD=""
if command -v openssl &>/dev/null; then
  echo "✔ openssl: found (will use for token generation)"
  TOKEN_CMD="openssl"
elif command -v xxd &>/dev/null; then
  echo "⚠  openssl not found — will use /dev/urandom + xxd for token generation."
  TOKEN_CMD="xxd"
else
  echo "✗ Neither openssl nor xxd is available — cannot generate a secure token."
  echo "  Install openssl or xxd and re-run setup."
  exit 1
fi

# ---------------------------------------------------------------------------
# b2. Remote access choice (Tailscale HTTPS, or local-only)
# ---------------------------------------------------------------------------
echo ""
echo "▶ Remote access setup"

SERVE_CHOICE="none"
if [[ ! -t 0 ]]; then
  echo "  (non-interactive shell — defaulting to local-only; SLIPSTREAM_SERVE=none)"
  echo "  Re-run 'pnpm setup' in a terminal to enable Tailscale remote access."
  SERVE_CHOICE="none"
else
  printf '  Set up remote phone access via Tailscale HTTPS? [y/N] '
  read -r _serve_reply || _serve_reply=""
  case "$_serve_reply" in
    [yY]|[yY][eE][sS])
      SERVE_CHOICE="tailscale"
      ;;
    *)
      SERVE_CHOICE="none"
      ;;
  esac
fi

if [[ "$SERVE_CHOICE" == "tailscale" ]]; then
  echo "✔ Remote access: Tailscale HTTPS (SLIPSTREAM_SERVE=tailscale)"
  if [[ "${TAILSCALE_AVAILABLE:-0}" != "1" ]]; then
    echo "⚠  tailscale is not on PATH yet."
    echo "   Tailscale is a system-level CLI, not a pnpm/npm package — install it from:"
    echo "     https://tailscale.com/download"
    echo "   You'll also need HTTPS Certificates enabled for your tailnet:"
    echo "     https://login.tailscale.com/admin/dns"
    echo "   ('pnpm deploy' will enforce this later; setup just records your choice.)"
  fi
else
  echo "✔ Remote access: local-only (SLIPSTREAM_SERVE=none)"
  echo "  ▶ The server stays bound to 127.0.0.1 — reachable on this machine only."
  echo "    To reach it from a phone (PWA install + push need an HTTPS origin), put your"
  echo "    own HTTPS in front of http://127.0.0.1:\$PORT — e.g. a Cloudflare Tunnel, or a"
  echo "    reverse proxy (Caddy/nginx) with a Let's Encrypt cert. 'pnpm deploy' will skip Tailscale."
fi

# ---------------------------------------------------------------------------
# c. pnpm install + native rebuild
# ---------------------------------------------------------------------------
echo ""
echo "▶ Installing dependencies (pnpm install)…"
with_node22 pnpm install

echo ""
echo "▶ Rebuilding native modules for Electron's ABI…"
echo "  (better-sqlite3 and node-pty must match Electron's Node ABI, not the system Node ABI)"
with_node22 pnpm dlx @electron/rebuild --force --only better-sqlite3,node-pty

ELECTRON_BIN="$REPO_ROOT/node_modules/electron/dist/electron"
if [[ -f "$ELECTRON_BIN" ]]; then
  echo "✔ Electron binary found: $ELECTRON_BIN"
else
  echo ""
  echo "⚠  Electron binary not found at: $ELECTRON_BIN"
  echo "   This can happen on Node 24 where electron's install.js exits mid-extraction."
  echo "   Manual fix:"
  echo "     1. Find the cached zip: ~/.cache/electron/<hash>/electron-*.zip"
  echo "        (run: ls ~/.cache/electron/)"
  echo "     2. Unzip it into node_modules/electron/dist/"
  echo "        (run: unzip -o ~/.cache/electron/<hash>/electron-*.zip -d $REPO_ROOT/node_modules/electron/dist/)"
  echo "     3. Write 'electron' to node_modules/electron/path.txt"
  echo "        (run: echo 'electron' > $REPO_ROOT/node_modules/electron/path.txt)"
  echo "     4. Re-run: pnpm dlx @electron/rebuild --force --only better-sqlite3,node-pty"
  echo ""
  echo "   See CLAUDE.md § 'Troubleshooting native setup' for full details."
fi

# ---------------------------------------------------------------------------
# d. Generate server.env if absent
# ---------------------------------------------------------------------------
echo ""
CONFIG_DIR="${HOME}/.config/slipstream"
ENV_FILE="$CONFIG_DIR/server.env"

mkdir -p "$CONFIG_DIR"

if [[ -f "$ENV_FILE" ]]; then
  echo "✔ server.env exists (leaving token untouched): $ENV_FILE"
  # Honor the remote-access choice without disturbing the token or other keys.
  if grep -q '^SLIPSTREAM_SERVE=' "$ENV_FILE"; then
    # Portable in-place edit (works on both GNU and BSD sed via a temp file).
    _tmp_env="$(mktemp)"
    sed "s/^SLIPSTREAM_SERVE=.*/SLIPSTREAM_SERVE=${SERVE_CHOICE}/" "$ENV_FILE" > "$_tmp_env"
    cat "$_tmp_env" > "$ENV_FILE"
    rm -f "$_tmp_env"
    echo "✔ Updated SLIPSTREAM_SERVE=${SERVE_CHOICE} in existing server.env"
  else
    printf 'SLIPSTREAM_SERVE=%s\n' "$SERVE_CHOICE" >> "$ENV_FILE"
    echo "✔ Appended SLIPSTREAM_SERVE=${SERVE_CHOICE} to existing server.env"
  fi
else
  echo "▶ Generating $ENV_FILE…"

  if [[ "$TOKEN_CMD" == "openssl" ]]; then
    TOKEN="$(openssl rand -hex 16)"
  else
    TOKEN="$(head -c16 /dev/urandom | xxd -p | tr -d '\n')"
  fi

  cat > "$ENV_FILE" <<EOF
SLIPSTREAM_TOKEN=${TOKEN}
SLIPSTREAM_BIND=127.0.0.1
SLIPSTREAM_PORT=7421
SLIPSTREAM_SERVE=${SERVE_CHOICE}
ELECTRON_RUN_AS_NODE=1
EOF

  chmod 600 "$ENV_FILE"
  echo "✔ server.env written and locked to 600: $ENV_FILE"
  echo "  (keep this file safe — it holds your auth token)"
fi

# ---------------------------------------------------------------------------
# e. Install service definition
# ---------------------------------------------------------------------------
echo ""
echo "▶ Installing service definition…"

SERVE_WRAPPER="$REPO_ROOT/scripts/serve-with-env.sh"

if [[ "$OS" == "Linux" ]]; then
  SYSTEMD_DIR="${HOME}/.config/systemd/user"
  SERVICE_FILE="$SYSTEMD_DIR/slipstream.service"
  mkdir -p "$SYSTEMD_DIR"

  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Slipstream headless WS server (web/mobile access over Tailscale)
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${REPO_ROOT}
ExecStart=${SERVE_WRAPPER}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF

  echo "✔ Service file written: $SERVICE_FILE"

  if command -v systemctl &>/dev/null; then
    systemctl --user daemon-reload
    echo "✔ systemd user daemon reloaded"
    systemctl --user enable slipstream.service
    echo "✔ slipstream.service enabled (will start at login)"
    echo "  Service is NOT started now — run 'pnpm deploy' to build and start it."
  else
    echo "⚠  systemctl not found — skipping daemon-reload and enable."
    echo "   Once systemd is available, run:"
    echo "     systemctl --user daemon-reload"
    echo "     systemctl --user enable slipstream.service"
  fi

elif [[ "$OS" == "Darwin" ]]; then
  LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
  PLIST_FILE="$LAUNCH_AGENTS_DIR/com.slipstream.server.plist"
  LOG_DIR="${HOME}/Library/Logs"
  mkdir -p "$LAUNCH_AGENTS_DIR" "$LOG_DIR"

  cat > "$PLIST_FILE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.slipstream.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>${SERVE_WRAPPER}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${REPO_ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/slipstream.out.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/slipstream.err.log</string>
</dict>
</plist>
EOF

  echo "✔ LaunchAgent plist written: $PLIST_FILE"

  GUI_UID="$(id -u)"
  # Load idempotently: bootout first (ignore error), then bootstrap; fall back to launchctl load
  launchctl bootout "gui/${GUI_UID}" "$PLIST_FILE" 2>/dev/null || true
  if launchctl bootstrap "gui/${GUI_UID}" "$PLIST_FILE" 2>/dev/null; then
    echo "✔ LaunchAgent bootstrapped (registered; NOT started yet)"
  else
    echo "⚠  launchctl bootstrap unavailable — falling back to launchctl load -w"
    launchctl load -w "$PLIST_FILE" 2>/dev/null || true
    echo "✔ LaunchAgent loaded (registered)"
  fi
  echo "  Service is NOT started now — run 'pnpm deploy' to build and start it."
fi

# ---------------------------------------------------------------------------
# f. Tailscale cert detection (informational only)
# ---------------------------------------------------------------------------
echo ""
if [[ "${TAILSCALE_AVAILABLE:-0}" == "1" ]]; then
  echo "▶ Checking Tailscale HTTPS certificate availability…"
  TS_STATUS="$(tailscale status --json 2>/dev/null || true)"
  if [[ -n "$TS_STATUS" ]]; then
    TS_DNS="$(printf '%s' "$TS_STATUS" | grep -o '"DNSName": *"[^"]*"' | head -1 | sed 's/.*"DNSName": *"//; s/\.\?"$//')" || true
    if [[ -n "$TS_DNS" ]]; then
      echo "  Tailnet DNS name: $TS_DNS"
      CERT_CHECK="$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "https://${TS_DNS}/" 2>/dev/null)" || CERT_CHECK=""
      if [[ "$CERT_CHECK" == "200" ]] || [[ "$CERT_CHECK" == "401" ]] || [[ "$CERT_CHECK" == "403" ]]; then
        echo "✔ HTTPS appears reachable (cert likely valid)"
      else
        echo "⚠  HTTPS check returned '${CERT_CHECK}' — HTTPS Certificates may not be enabled yet."
        echo "   Action required: go to https://login.tailscale.com/admin/dns"
        echo "   and enable 'HTTPS Certificates' for your tailnet."
        echo "   (Required for PWA install and push notifications on mobile.)"
      fi
    else
      echo "⚠  Could not determine tailnet DNS name — Tailscale may not be authenticated."
      echo "   Run 'tailscale up' to connect, then check:"
      echo "   https://login.tailscale.com/admin/dns → enable HTTPS Certificates"
    fi
  else
    echo "⚠  Could not read Tailscale status — ensure Tailscale is running ('tailscale up')."
  fi
else
  echo "  (Tailscale not installed — skipping cert check. Install Tailscale for HTTPS access.)"
fi

# ---------------------------------------------------------------------------
# g. Final summary
# ---------------------------------------------------------------------------
echo ""
echo "══════════════════════════════════════════════════════════════"
echo "✔ Setup complete!"
echo ""
echo "  Config:  $ENV_FILE"
echo "  Token:   (see SLIPSTREAM_TOKEN in server.env)"
echo ""
if [[ "$SERVE_CHOICE" == "tailscale" ]]; then
  echo "  Next step: run 'pnpm deploy' to build the app, start the"
  echo "  service, and publish it over Tailscale HTTPS."
else
  echo "  Next step: run 'pnpm deploy' to build the app and start the"
  echo "  service. Tailscale publishing is OFF (SLIPSTREAM_SERVE=none) —"
  echo "  the app will be local-only at http://127.0.0.1:7421/."
fi
echo ""
echo "  For desktop development: 'pnpm dev' (no setup needed for that)."
echo "══════════════════════════════════════════════════════════════"
echo ""

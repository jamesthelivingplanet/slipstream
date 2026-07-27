#!/usr/bin/env bash
# devScaffold.sh — materializes the per-machine scaffolding shared by every
# per-worktree "dev" instance: the slipstream-dev@.service systemd template,
# the dev-serve.sh wrapper it execs, and the ~/.config/slipstream/dev-slots
# directory where per-slot env files live.
#
# Sourced (not executed) by BOTH scripts/setup.sh and scripts/deploy.sh so
# there is exactly one copy of this content — deploy.sh calls it on every
# dev deploy so a fresh worktree is self-healing with no 'pnpm setup' re-run;
# setup.sh calls it once up front so a freshly-cloned machine has it too.
#
# Linux/systemd only. On macOS this is a no-op that prints a one-line note —
# per-worktree dev instances aren't wired up for launchd yet.

# ---------------------------------------------------------------------------
# slipstream_install_dev_scaffold — idempotent; safe to call on every deploy.
# ---------------------------------------------------------------------------
slipstream_install_dev_scaffold() {
  local os
  os="$(uname -s)"

  if [[ "$os" != "Linux" ]]; then
    echo "  (per-worktree dev instances are Linux/systemd-only for now — skipping on ${os})"
    return 0
  fi

  local config_dir="${HOME}/.config/slipstream"
  local systemd_dir="${HOME}/.config/systemd/user"
  local service_file="${systemd_dir}/slipstream-dev@.service"
  local serve_script="${config_dir}/dev-serve.sh"
  local slots_dir="${config_dir}/dev-slots"

  mkdir -p "$systemd_dir" "$config_dir"

  cat > "$service_file" <<EOF
[Unit]
Description=Slipstream dev instance (%i)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=%h/.config/slipstream/dev-slots/%i.env
ExecStart=%h/.config/slipstream/dev-serve.sh
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF

  cat > "$serve_script" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

: "${SLIPSTREAM_DEV_ROOT:?SLIPSTREAM_DEV_ROOT must be set (the worktree's repo root)}"

cd "$SLIPSTREAM_DEV_ROOT"
exec "$SLIPSTREAM_DEV_ROOT/node_modules/electron/dist/electron" "$SLIPSTREAM_DEV_ROOT/dist-electron/server.js"
EOF
  chmod 755 "$serve_script"

  mkdir -p "$slots_dir"
  chmod 700 "$slots_dir"

  if command -v systemctl &>/dev/null; then
    systemctl --user daemon-reload
  fi
}

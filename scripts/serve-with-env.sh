#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${HOME}/.config/slipstream/server.env"
if [[ -f "$ENV_FILE" ]]; then set -a; source "$ENV_FILE"; set +a; fi

# The systemd user unit starts at user-manager start, before Hyprland's
# autostart runs `systemctl --user import-environment` — so after a reboot
# this daemon inherits systemd's bare PATH=/usr/local/bin:/usr/bin, not the
# login PATH. Agent PTYs inherit this daemon's PATH, so a short one makes
# `claude`/node/pnpm/bun unresolvable and every agent spawn exit 1. Prepend
# the standard per-user tool dirs here, idempotently, after the env-file
# source so an explicit PATH= in server.env is augmented, not discarded.
for dir in "$HOME/.local/bin" "$HOME/.local/share/mise/shims"; do
  if [[ -d "$dir" ]]; then
    case ":$PATH:" in
      *":$dir:"*) ;;
      *) PATH="$dir:$PATH" ;;
    esac
  fi
done
export PATH

exec "$REPO_ROOT/node_modules/electron/dist/electron" "$REPO_ROOT/dist-electron/server.js"

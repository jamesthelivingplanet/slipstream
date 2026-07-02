#!/usr/bin/env bash
# node22.sh — single source of truth for Node 22 enforcement.
#
# Node 22 is required for native module ABI compatibility with Electron 33.
# Sourced by scripts/setup.sh and scripts/deploy.sh. Defines with_node22, which
# runs its arguments under Node 22, switching via mise → nvm → pnpm (pnpm env)
# if the active node isn't already v22.

with_node22() {
  if node -e "process.exit(Number(/^v22/.test(process.version))?0:1)" 2>/dev/null; then
    "$@"
  elif command -v mise &>/dev/null; then
    echo "  Using Node 22 via mise…"
    mise install node@22 2>/dev/null || true
    mise exec node@22 -- "$@"
  elif [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
    echo "  Using Node 22 via nvm…"
    # shellcheck disable=SC1091
    \. "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    nvm install 22 2>/dev/null || true
    nvm exec 22 "$@"
  elif command -v pnpm &>/dev/null; then
    echo "  Using Node 22 via pnpm (pnpm env)…"
    pnpm env use -g 22
    "$@"
  else
    echo "✗ Node 22 is required but $(node --version 2>/dev/null || echo 'none') was detected."
    echo "  Install Node 22 directly, or install mise, nvm, or pnpm so this script can switch to it."
    exit 1
  fi
}

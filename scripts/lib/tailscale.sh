#!/usr/bin/env bash
# tailscale.sh — shared Tailscale helpers. Sourced, not executed; functions
# only, no top-level side effects.

# ---------------------------------------------------------------------------
# ts_dns — echoes the tailnet DNS name for this machine (without trailing
# dot), or empty if tailscale is absent / not logged in / status can't be
# parsed. Never fails the caller's script (safe under set -e).
# ---------------------------------------------------------------------------
ts_dns() {
  if ! command -v tailscale &>/dev/null; then
    return 0
  fi

  local dns
  dns="$(tailscale status --json 2>/dev/null | grep -o '"DNSName": *"[^"]*"' | head -1 | sed 's/.*"DNSName": *"//; s/\.\?"$//')" || true
  echo "$dns"
}

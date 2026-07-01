---
name: setup
description: Set up Slipstream on a fresh machine — installs deps, rebuilds native modules for Electron's ABI, generates an auth token, and installs the background service (systemd on Linux / launchd on macOS), then optionally publishes it over Tailscale HTTPS so you can reach it from your phone as an installable PWA with push notifications. Use when bootstrapping the app on a new machine, onboarding someone else, or when `pnpm setup` / `pnpm deploy` need guiding.
disable-model-invocation: true
---

## Prerequisites

- **Node 22** — `setup.sh`/`deploy.sh` require it on PATH. If a different version is active,
  they'll switch via `mise` or `nvm` automatically (whichever is installed); if neither is
  installed, setup exits with an error and you must install/switch to Node 22 yourself
- **pnpm** — required; must be on PATH before running any scripts
- **`claude` CLI** — must be on PATH and authenticated; the app spawns `claude --dangerously-skip-permissions`
- **Tailscale** (only if you want phone/remote access) — system-level CLI from https://tailscale.com/download, logged in (`tailscale up`). On macOS use the Homebrew CLI (`brew install tailscale`), **not** the App Store GUI app.

## One-time setup

Run in a real terminal (interactive prompts are used):

```sh
pnpm setup
```

The script detects Linux or macOS and fails on other OSes. It checks that prerequisites are
present, then asks:

```
Set up remote phone access via Tailscale HTTPS? [y/N]
```

In a non-interactive shell the default is `none`. If you are running inside a Claude Code
session, use `! pnpm setup` so the output (including the prompt) lands in the conversation,
or open your own terminal.

What `pnpm setup` produces:

- Runs `pnpm install` then rebuilds native modules for Electron's ABI:
  ```sh
  pnpm dlx @electron/rebuild --force --only better-sqlite3,node-pty
  ```
- Writes `~/.config/slipstream/server.env` (chmod 600) containing:
  `SLIPSTREAM_TOKEN`, `SLIPSTREAM_BIND=127.0.0.1`, `SLIPSTREAM_PORT=7421`,
  `SLIPSTREAM_SERVE=tailscale|none`, `ELECTRON_RUN_AS_NODE=1`
- On **Linux**: writes `~/.config/systemd/user/slipstream.service` and enables it
  (`systemctl --user daemon-reload && systemctl --user enable slipstream.service`)
- On **macOS**: writes `~/Library/LaunchAgents/com.slipstream.server.plist` and bootstraps
  it with `launchctl`
- Prints "Next step: run 'pnpm deploy'" — it does **not** start the service

`pnpm setup` is idempotent and safe to re-run. It never overwrites an existing
`SLIPSTREAM_TOKEN`.

If native-module or Electron-binary errors appear, see **Troubleshooting native setup** in
[CLAUDE.md](../../CLAUDE.md).

## If using Tailscale — enable HTTPS certificates

This step is required before `tailscale serve` will work, and before the PWA install and
push notifications will function on your phone.

1. Go to https://login.tailscale.com/admin/dns
2. Enable **HTTPS Certificates** for the tailnet

This is an admin-console toggle and cannot be done automatically by the script.

## Deploy / start

After setup, and for every subsequent release:

```sh
pnpm deploy
```

Phases:

1. **Quality gates** — `pnpm check` (svelte-check) + `pnpm test`
2. **Build** — `pnpm build`
3. **Restart service**
   - Linux: `systemctl --user restart slipstream.service`
   - macOS: `launchctl kickstart -k "gui/$(id -u)/com.slipstream.server"`
4. **Health check** — polls `http://${SLIPSTREAM_BIND}:${SLIPSTREAM_PORT}/healthz`
   (default `http://127.0.0.1:7421/healthz`)
5. **Tailscale serve** (only if `SLIPSTREAM_SERVE=tailscale`) — runs:
   ```sh
   tailscale serve --bg --https=443 "http://127.0.0.1:${PORT}"
   ```
   and prints `https://<machine>.<tailnet>.ts.net/`. Skipped entirely when
   `SLIPSTREAM_SERVE=none`.

**With `SLIPSTREAM_SERVE=none`** the app is reachable only at `http://127.0.0.1:7421`
locally. Remote or phone access requires a BYO HTTPS origin — e.g. a Cloudflare Tunnel, or
a reverse proxy with Let's Encrypt in front of port 7421.

To skip quality gates for a hot fix:

```sh
SKIP_CHECKS=1 pnpm deploy
# or equivalently:
pnpm deploy --skip-checks
```

## Verify on the device

1. Open the URL printed by `pnpm deploy` — the Tailscale HTTPS URL on your phone, or
   `http://127.0.0.1:7421` in a local browser
2. Enter `SLIPSTREAM_TOKEN` (from `~/.config/slipstream/server.env`) when prompted
3. Use the in-app nudge to **Install app** (PWA) and **Turn on notifications**

Push notifications and PWA install only work over HTTPS or localhost — they will not work
over plain `http://` on a remote origin.

## Troubleshooting

- **Native modules / Electron ABI errors** → see **Troubleshooting native setup** in
  [CLAUDE.md](../../CLAUDE.md)
- **`No handler registered for ...`** → native rebuild needed:
  ```sh
  pnpm dlx @electron/rebuild --force --only better-sqlite3,node-pty
  ```
- **Install/notifications nudge not showing** → must be a secure context (HTTPS or
  localhost); plain `http://` on a remote IP will not work
- **Linux service status / logs**:
  ```sh
  systemctl --user status slipstream.service
  journalctl --user -u slipstream
  ```
- **macOS service status / logs**:
  ```sh
  launchctl print gui/$(id -u)/com.slipstream.server
  # logs at:
  ~/Library/Logs/slipstream.err.log
  ```

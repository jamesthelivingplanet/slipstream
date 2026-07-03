---
name: setup
description: Set up Slipstream on a fresh machine — installs deps, rebuilds native modules for Electron's ABI, generates an auth token, and installs the background service (systemd on Linux / launchd on macOS), then optionally publishes it over Tailscale HTTPS so you can reach it from your phone as an installable PWA with push notifications. Use when bootstrapping the app on a new machine, onboarding someone else, or when `pnpm setup` / `pnpm deploy` need guiding.
disable-model-invocation: true
---

## Prerequisites

- **Node 22** — `setup.sh`/`deploy.sh` require it on PATH. If a different version is active,
  they'll switch automatically via `mise` → `nvm` → `pnpm env use -g 22` (the first one
  available); since pnpm is always a prerequisite, this last fallback means the scripts can
  provision Node 22 themselves even on a machine with no other Node manager. `package.json`
  pins `"engines": { "node": "22.x" }` and `.npmrc` sets `engine-strict=true`, so installing
  under the wrong Node version fails fast at install time with a clear engine-mismatch line
  instead of a cryptic native-build ABI error
  (The shared `with_node22` function now lives in `scripts/lib/node22.sh`.)
- **pnpm** — required; must be on PATH before running any scripts
- **`claude` CLI** — must be on PATH and authenticated; the app spawns `claude --dangerously-skip-permissions`
- **Tailscale** (only if you want phone/remote access) — system-level CLI from https://tailscale.com/download, logged in (`tailscale up`). On macOS use the Homebrew CLI (`brew install tailscale`), **not** the App Store GUI app.

## One-time setup

Interactive (asks about Tailscale):

```sh
pnpm setup
```

The script detects Linux or macOS and fails on other OSes. It checks that prerequisites are
present, then asks:

```
Set up remote phone access via Tailscale HTTPS? [y/N]
```

In a non-interactive shell (no flag passed) the default is `none`.

**Non-interactive** — pass the remote-access choice directly and it skips the prompt
entirely:

```sh
pnpm setup -- --serve=none        # local-only
pnpm setup -- --serve=tailscale   # Tailscale HTTPS
```

If you (Claude) already know which the user wants — e.g. they said they don't want/have
Tailscale, or explicitly asked for local-only — run `pnpm setup -- --serve=none` (or
`=tailscale`) yourself; there's no need to hand off to the user for that prompt. Only fall
back to telling the user to run `! pnpm setup` interactively when their preference is
genuinely unknown and you want them to answer it themselves.

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

At the end of both the local-only and Tailscale success paths, `pnpm deploy` prints a
tokenized onboarding URL (`?token=<SLIPSTREAM_TOKEN>`) and, if `qrencode` is installed, a
scannable terminal QR code for it (`print_onboarding_qr` in `scripts/deploy.sh`). If no
`SLIPSTREAM_TOKEN` is found in `server.env`, it skips the QR/tokenized URL and prints a
note instead — install `qrencode` (e.g. `apt install qrencode` / `brew install qrencode`)
to get the QR code.

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

## Desktop packaging

`pnpm package` (`pnpm build && electron-builder --publish never`) builds installers into
`release/` — an AppImage on Linux, a `.dmg` on macOS — configured in
`electron-builder.yml` at the repo root. `npmRebuild: true` there means electron-builder
rebuilds native modules (`better-sqlite3`, `node-pty`) for Electron's ABI automatically as
part of packaging, so you don't need a manual `@electron/rebuild` step first.

## Alternative deploy path: published Docker image

In addition to `pnpm deploy` (systemd/launchd) and the Tailscale-sidecar pod
(`docker-compose.yml`, see `docs/POD-DEPLOY.md`), CI publishes the production server image
to the GitLab Container Registry (`registry.gitlab.com/ajlebaron/slipstream:latest`)
automatically on every merge to the default branch. See the README's "Run the published
image directly" section for a plain `docker run` invocation.

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

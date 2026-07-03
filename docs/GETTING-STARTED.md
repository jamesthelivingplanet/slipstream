# Getting started: fresh machine → phone-connected

One continuous walkthrough from a brand-new machine to running an agent and watching
it from your phone. This pulls together pieces spread across [README.md](../README.md),
[POD-DEPLOY.md](POD-DEPLOY.md), and `scripts/setup.sh` — read those for full detail on
any one step; this page is the connective tissue.

## 1. Prerequisites

- **Node 22+** — required for native module ABI compatibility with the pinned Electron
  version. `node --version`.
- **pnpm** — https://pnpm.io/installation.
- **The `claude` CLI** on your `PATH`, authenticated — Slipstream spawns
  `claude --dangerously-skip-permissions` per agent. Install: https://docs.anthropic.com/claude-code.
- **Tailscale** — only needed if you want HTTPS phone access (recommended). Install:
  https://tailscale.com/download. Skip this if you're going local-only or the
  Docker/pod route (below), which brings its own Tailscale sidecar.

## 2. Clone and run setup

```sh
git clone <your-fork-or-remote-url> slipstream
cd slipstream
pnpm setup
```

`pnpm setup` is idempotent (safe to re-run) and does **not** build or start anything yet —
it's machine bootstrap only:

1. Checks the prereqs above (warns, doesn't fail, on optional ones).
2. Runs `pnpm install`, then rebuilds `better-sqlite3` and `node-pty` for Electron's ABI
   via `@electron/rebuild` — these are native modules and must match Electron's Node ABI,
   not your system Node's.
3. Prompts for remote access (see step 3) and writes `~/.config/slipstream/server.env`
   with a fresh random `SLIPSTREAM_TOKEN` — generated once, never clobbered on re-run.
4. Installs (but does not start) the background service: a systemd user unit on Linux
   (`~/.config/systemd/user/slipstream.service`), a LaunchAgent on macOS.

If native modules or the Electron binary give you trouble on a fresh machine, see
**Troubleshooting native setup** in [CLAUDE.md](../CLAUDE.md) — it covers the Node 24
extraction quirk and the manual `@electron/rebuild` fallback.

## 3. Choose how you'll reach it remotely

`pnpm setup` asks this interactively (or pass `--serve=tailscale|none` non-interactively).
The choice is saved as `SLIPSTREAM_SERVE` in `server.env` and read by `pnpm deploy`.

- **Tailscale HTTPS** (recommended for phone access) — publishes the app at
  `https://<machine>.<tailnet>.ts.net/` via `tailscale serve --https=443`. Requires HTTPS
  Certificates enabled for your tailnet (one-time, admin console:
  https://login.tailscale.com/admin/dns). HTTPS is required for PWA install and push
  notifications.
- **Local-only** — the server binds `127.0.0.1`, reachable only on this machine. To still
  reach it from a phone, put your own HTTPS in front of it (Cloudflare Tunnel, or a
  reverse proxy like Caddy/nginx with a Let's Encrypt cert).
- **Pod / Docker** — instead of running on your dev machine at all, run the daemon on a
  server you own with a one-command Docker Compose path that includes a Tailscale
  sidecar. This is the better fit if you want the daemon always-on somewhere other than
  your laptop. Skip steps 4–5 below and follow [docs/POD-DEPLOY.md](POD-DEPLOY.md)
  end-to-end instead, then resume at step 6.

## 4. Deploy

```sh
pnpm deploy
```

This runs the quality gates (`pnpm check` + `pnpm test`), builds the app, restarts the
`slipstream` service, and waits for the health check. If you chose Tailscale in step 3,
it then runs `tailscale serve --https=443` to publish the app. If you chose local-only,
it stops after the health check.

To skip the quality gates during a hot fix: `SKIP_CHECKS=1 pnpm deploy`.

## 5. Open it on your phone

1. On your phone (joined to the same tailnet, if using Tailscale), open the URL:
   `https://<your-machine>.<tailnet>.ts.net/` (Tailscale) or your own reverse-proxy URL
   (local-only + bring-your-own-HTTPS).
2. Paste the `SLIPSTREAM_TOKEN` from `~/.config/slipstream/server.env` when prompted.
3. Tap **Add to Home Screen** (iOS Safari) or **Install App** (Android Chrome) to install
   it as a PWA.
4. Allow notifications when prompted — you'll get pushed when an agent finishes or needs
   your attention.

## 6. Verify end-to-end

1. In the app (desktop or phone), **Add repo** and pick a local git repo (desktop) or
   register one by remote URL (pod/server deployments, which clone on demand).
2. Create a new agent, pick the repo, and **Start**. Slipstream cuts a fresh git
   worktree, assigns a dev port, and streams the live `claude` PTY into the terminal.
3. Watch it run from your phone — the same session, live, over the PWA connection.
4. When the agent finishes or needs input, confirm you get a push notification.

That's the full loop. For the daemon-on-a-pod variant of steps 3–6, see
[docs/POD-DEPLOY.md](POD-DEPLOY.md). For gotchas around native modules, the preload
bridge, and the dev-vs-daemon rebuild cycle, see [CLAUDE.md](../CLAUDE.md).

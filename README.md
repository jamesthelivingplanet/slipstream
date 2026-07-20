# Slipstream

A desktop console for running and watching **many coding agents at once** — one
agent per task, each `claude --dangerously-skip-permissions` running in its own git
worktree. Start them, watch them, and jump to whichever one needs you.

It also runs as a **headless server** you reach from a browser or phone as an
installable PWA, with push notifications when an agent changes status.

> The full agent loop is wired (register a repo → create an agent → start it in a
> fresh worktree → live terminal), the daemon survives app-close, and a one-command
> Docker path runs it on a pod you drive from your phone. See
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design.

> New here? Start with [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) — a single
> fresh-machine → phone-connected walkthrough.

## What it is

Two-pane desktop app: a list of **agents** on the left, the selected agent's **terminal**
on the right. You import git repos, create an agent (blank or from a ticket), pick a repo,
and **Start** — Slipstream cuts a worktree, assigns a sticky dev port, and streams the live
agent PTY into the terminal. Built to manage a fleet of them concurrently.

The desktop is a **thin client** of a local daemon (spawned on first launch, reused after):
agents live in the daemon process, so they keep running when you close the window. The same
daemon can run headlessly on any machine (Linux or macOS) and serve the UI to any browser
over Tailscale HTTPS. Once loaded, browsers can install it as a PWA and receive push
notifications when an agent finishes or needs your attention.

## Stack

- **Electron** (main process: PTYs, git, SQLite) · also runs headless via `ELECTRON_RUN_AS_NODE=1`
- **Svelte 4 + Vite + Tailwind**, shadcn-style design with live theming
- **xterm.js** terminals · **node-pty** processes · **better-sqlite3** persistence
- **Web Push** (VAPID) for agent status notifications · **WebSocket** server for the browser client
- **TypeScript**, **pnpm**, **vitest** (unit + real-git integration), **Playwright** (e2e drivers)
- **Tailscale** for zero-config HTTPS on your tailnet (required for PWA install + push)

## Quickstart (desktop dev)

Prereqs: Node 22+, pnpm, the `claude` CLI on your PATH (to actually run agents).

```sh
pnpm install          # native build scripts are allowlisted in pnpm-workspace.yaml
pnpm dev              # launch Vite + Electron
pnpm dev:backend      # after editing server.ts / electron backend: rebuild + restart the daemon
pnpm check            # svelte-check typecheck
pnpm test             # vitest: unit + real-git worktree integration
pnpm test:coverage    # vitest with a v8 coverage report (text + html + cobertura)
```

`pnpm dev` does not hot-reload the backend daemon — run `pnpm dev:backend` after editing
`server.ts` or `electron/services/*` / `electron/core/*` code for the change to take effect.

If a fresh machine has trouble with native modules or the Electron binary, see the
**Troubleshooting** section in [CLAUDE.md](CLAUDE.md) — it covers Electron binary
extraction, `@electron/rebuild` for the ABI, and Node 24 quirks.

## Secrets & data directory

Secrets (Linear API key, GitHub/GitLab tokens) are stored in the SQLite `config` table
inside the app's data directory. On desktop, they're encrypted at rest with the OS keychain
via Electron `safeStorage` when available. The headless server (`pnpm serve`, and the
detached daemon) runs under `ELECTRON_RUN_AS_NODE`, where safeStorage isn't reachable, so
there secrets stay plaintext in `<dataDir>/slipstream.db`, protected only by the data
directory's 0700 permissions. Full detail in [docs/SECURITY.md](docs/SECURITY.md) §6.

## Run it on your phone / as a server

The headless server runs on any machine (Linux/macOS) and serves the UI to any browser.
During `pnpm setup` you choose how it's reached from other devices: **Tailscale HTTPS**
(recommended for phone access) or **local-only**. The choice is saved as `SLIPSTREAM_SERVE`
in `~/.config/slipstream/server.env` and read by `pnpm deploy`.

### One-time setup (per machine)

```sh
pnpm setup
```

This is idempotent — safe to re-run. It will:

1. Check prereqs (`pnpm`, Node 22+, `claude`, `tailscale`, `openssl`)
2. Run `pnpm install` and rebuild native modules for Electron's ABI (`@electron/rebuild`)
3. Generate `~/.config/slipstream/server.env` with a random `SLIPSTREAM_TOKEN` (only if absent — never clobbers an existing token)
4. Install and enable the background service:
   - **Linux**: writes `~/.config/systemd/user/slipstream.service`, runs `systemctl --user enable`
   - **macOS**: writes `~/Library/LaunchAgents/com.slipstream.server.plist`, bootstraps it with `launchctl`

### Remote access options

**Tailscale HTTPS** (recommended for phone access) — `SLIPSTREAM_SERVE=tailscale`:
- Tailscale is a **system-level CLI**, not a pnpm/npm package. Install it from
  [https://tailscale.com/download](https://tailscale.com/download).
- Enable **HTTPS Certificates** for your tailnet (one-time admin step):
  [https://login.tailscale.com/admin/dns](https://login.tailscale.com/admin/dns).
- `pnpm deploy` then runs `tailscale serve --https=443` to publish the app at
  `https://<your-machine>.<tailnet>.ts.net/`. HTTPS is required for PWA install + push.
- **macOS**: the Mac App Store GUI app does **not** ship the CLI — install via Homebrew
  (`brew install tailscale`) or the standalone pkg.

**Local-only** — `SLIPSTREAM_SERVE=none`:
- The server stays bound to `127.0.0.1` — reachable on the host machine only.
- `pnpm deploy` skips the Tailscale phase and succeeds.
- To reach it from a phone (PWA install + push need an HTTPS origin), bring your own:
  a Cloudflare Tunnel, or a reverse proxy (Caddy/nginx) with a Let's Encrypt cert in
  front of `http://127.0.0.1:7421`.

### Run the published image directly

CI publishes the production server image to the GitLab Container Registry on every merge
to `master`. If you don't need the Tailscale sidecar, run it directly:

```sh
docker run -d \
  -e SLIPSTREAM_TOKEN=your-token \
  -e ANTHROPIC_API_KEY=your-key \
  -v slipstream-data:/home/slipstream \
  -p 7421:7421 \
  registry.gitlab.com/ajlebaron/slipstream:latest
```

The volume persists `/home/slipstream` (SQLite DB, worktrees, logs) across restarts. This
gives you local/LAN access only — for full phone access over HTTPS, use the
docker-compose (Tailscale-sidecar) path below instead.

### Deploy to a pod (Docker)

To run Slipstream on a server you own and drive it from your phone, use the
one-command Docker path: it brings up the daemon plus a Tailscale sidecar that
publishes it over HTTPS on your tailnet.

```sh
cp .env.pod.example .env   # fill in SLIPSTREAM_TOKEN, ANTHROPIC_API_KEY, TS_AUTHKEY
docker compose up -d --build
```

Full walkthrough — prerequisites, secrets, phone setup, and updates — in
[docs/POD-DEPLOY.md](docs/POD-DEPLOY.md).

### Each release

```sh
pnpm deploy
```

This runs the quality gates (`pnpm check` + `pnpm test`), builds the app, restarts the
service, and waits for the health check. If `SLIPSTREAM_SERVE=tailscale`, it then runs
`tailscale serve --https=443` to publish the app at `https://<your-machine>.<tailnet>.ts.net/`;
if `SLIPSTREAM_SERVE=none`, it stops after the health check (local-only).

Mobile devices: after the first deploy, open that URL in Safari/Chrome, tap **Add to Home
Screen** (iOS) or **Install App** (Android), and allow notifications when prompted.

To skip quality gates during a hot fix:
```sh
SKIP_CHECKS=1 pnpm deploy
```

## Repo layout

```
electron/                 main process (and headless server entry point)
  main.ts                 window + local-daemon spawn/reuse (Electron desktop mode)
  server.ts               headless WS server entry (ELECTRON_RUN_AS_NODE mode)
  preload.ts              contextBridge → window.__slipstreamDaemon / __slipstreamNative (CJS)
  ipc.ts                  IpcDeps interface shared by rpc.ts + server.ts
  shared/contract.ts      types, service interfaces, IPC channels, SlipstreamApi  (the seam)
  shared/agentCli.ts      centralized claude/opencode CLI flags + timing constants
  shared/wire.ts          WS wire protocol (req/res/push envelopes)
  core/                   rpc.ts (transport-free router), auth.ts (identity), services.ts
                          (factory), daemonManager.ts (spawn/reuse local daemon), bootstrap.ts
  services/               repoRegistry + repoResolve (self-heal/clone), worktreeManager,
                          sessionManager, agentBackend (claude + opencode), statusDetector +
                          statusSentinel, sessionReaper (GC/cost guard), writeCoordinator
                          (multi-client write lock), outputBuffer + scrollbackStore (durable),
                          sessionStore + sessionPersistence, transcripts, portBroker,
                          pushService, runLogger, configStore, claudeTrust, cliProbe,
                          editorLauncher, appRunner, diagnostics, gitDriver, mcpConfig/mcpHealth
  tickets/                ITicketProvider impls: emptyProvider, linearProvider
  db/db.ts                better-sqlite3 (schema inlined; numbered migrations)
  mcp/                    MCP integration
src/                      Svelte renderer (runs in browser + Electron)
  main.ts                 bootElectron()/bootWeb() — sets window.slipstream before importing App
  App.svelte, app.css     shell + shadcn token system
  lib/components/         AgentList, AgentConfig, TerminalView, NewAgentDialog, SettingsModal
                          (+ settings/ tab split), ThemeMenu, Toasts, TokenGate, ConfirmDialog,
                          McpStatus, TicketStatusBar, ResponsivePanel, InstallNudge
  lib/                    stores, ipc, wsApi, term, theme, toast, push, reconcile, responsive,
                          ticketFilter, branch, icons, types
scripts/
  deploy.sh               build + restart service + tailscale serve (pnpm deploy)
  setup.sh                one-time machine bootstrap (pnpm setup)
  serve-with-env.sh       sources server.env and execs the server; called by systemd/launchd
  build-server.mjs        esbuild script for the headless server bundle
  check-preload-cjs.mjs   post-build guard: preload output has no top-level ESM import/export
  e2e/                    Playwright drivers (smoke-add-repo + restart-recovery are the CI gates)
prototype.html            original design reference (not used at runtime)
```

## Docs

- [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) — fresh-machine → phone-connected walkthrough
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — data model, the contract seam, services, daemon/process model, web mode, decisions
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — dev loop: daemon rebuild cycle, tests, agent-run logs, e2e drivers
- [docs/NATIVE-MODULES.md](docs/NATIVE-MODULES.md) — native ABI rebuild + fresh-machine troubleshooting
- [docs/SECURITY.md](docs/SECURITY.md) — auth model, `?token=`-in-logs threat + deferred one-time-ticket fix, secrets at rest, sandbox
- [docs/IDENTITY-SEAM.md](docs/IDENTITY-SEAM.md) — the `ownerId` seam that keeps a future multi-user tier additive
- [docs/POD-DEPLOY.md](docs/POD-DEPLOY.md) — one-command Docker + Tailscale pod deploy
- [docs/VERIFYING-DESKTOP-DAEMON.md](docs/VERIFYING-DESKTOP-DAEMON.md) — manual verify recipe for the thin-client daemon
- [CLAUDE.md](CLAUDE.md) — contributor notes: commands, conventions, and a gotcha index that links to the above

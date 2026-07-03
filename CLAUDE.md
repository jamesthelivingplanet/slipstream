# CLAUDE.md

Hard-won, non-obvious notes for this repo — start with
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/ROADMAP.md](docs/ROADMAP.md).

Use **pnpm**. Run `pnpm check` (svelte-check), `pnpm test`, and `pnpm lint` (eslint +
`prettier --check`) before committing — `pnpm lint` gates the MR, so don't skip it; use
`pnpm lint:fix` to auto-fix formatting. `pnpm deploy` builds, then restarts the systemd
`slipstream.service` and hits a healthz check.

If a change touches `scripts/setup.sh`, `scripts/deploy.sh`, `package.json` (scripts/engines),
or how the app is bootstrapped/deployed, check whether `.claude/skills/setup/SKILL.md` still
describes the current behavior and update it in the same change.

## Conventions

- **The contract is the seam.** `electron/shared/contract.ts` defines all DTOs, service
  interfaces, IPC channels, and `SlipstreamApi`. Implement against it; coordinate any change
  to it. Services never import each other — they're wired only in `electron/main.ts`.
- **Guard backend calls** in the renderer with `hasBackend` (from `src/lib/ipc.ts`) so the
  UI still runs in a plain browser for design work.
- **No mock data.** The app is real-data-only; ticket sources go behind `ITicketProvider`.
- **Svelte 4** (legacy stores, `$store`, `on:click`) — not Svelte 5. Reuse the shadcn
  classes/tokens in `src/app.css` over ad-hoc styles.
- Parallelizable work splits cleanly along `electron/` vs `src/` (disjoint dirs).

## Gotchas (hard-won)

- **ESM preload**: `preload.ts` builds to `preload.mjs`. It only loads with
  `sandbox: false` (set in `main.ts`) **and** ESM output — `vite.config.ts` forces
  `output.format: 'es'`. Symptom if broken: `window.slipstream` is `undefined`,
  `Add repo`/everything silently no-ops (falls back to mock-less empty state). This
  invariant is enforced as a post-build check (`scripts/check-preload-esm.mjs`), run in
  the GitLab CI `build` job and in `deploy.sh` phase 2 (moved out of vitest per FLO-80).
- **Bundled main has no sibling files.** Anything `main.js` needs at runtime must be
  inlined or bundled — e.g. the DB schema is a `SCHEMA` string in `db.ts`, not a `.sql`
  file (which the bundler won't copy). Symptom if broken: `No handler registered for ...`
  because `openDb` threw before `registerIpc` ran.
- **Native modules** (`node-pty`, `better-sqlite3`) are built for **Electron's ABI**, so
  node-run tests can't import `db.ts`/`sessionManager.ts`. Tests cover pure logic +
  real-git integration instead.
- **Rebuild natives for Electron, not Node.** `pnpm rebuild better-sqlite3 node-pty` — and
  any change to the Node version pnpm runs scripts on (e.g. switching Node via `mise`/`nvm`) —
  compiles them against the *current Node's* ABI, which Electron then refuses to load.
  Symptom: `better_sqlite3.node … compiled against … NODE_MODULE_VERSION 127 … requires 130`
  (127 = Node 22, 130 = Electron 33). That throw happens in `openDb()`, so `registerIpc()`
  never runs → `No handler registered for 'repos:list'`. Always finish a native rebuild with
  `pnpm dlx @electron/rebuild --force --only better-sqlite3,node-pty`.
- **vitest uses `vitest.config.ts`** (not the Vite config) so tests don't run through the
  Electron plugin (which rewrites `child_process` into a require-shim that breaks ESM).
- **`ELECTRON_RUN_AS_NODE` + native ABI**: `pnpm serve` runs
  `ELECTRON_RUN_AS_NODE=1 electron dist-electron/server.js`. This reuses Electron's Node
  binary so `better-sqlite3` and `node-pty` (built for Electron's ABI) load without a
  separate rebuild. In `ELECTRON_RUN_AS_NODE` mode the Electron `app` API is unavailable
  — which is why `resolveDataDir()` in `electron/core/services.ts` derives the data path
  from `os.homedir()` / env vars rather than `app.getPath('userData')`.
- **`window.slipstream` must be set before `App`/`ipc.ts` loads**: in web mode `src/main.ts`
  assigns `window.slipstream` and `window.__slipstreamWeb = true` and only _then_ does
  `await import('./App.svelte')`. This is intentional — `ipc.ts` has a module-level
  `hasBackend = !!window.slipstream`. If App is imported first (or the order changes),
  `hasBackend` is `false` and all backend calls silently no-op.
- **`SLIPSTREAM_TOKEN` is required**: the headless server (`pnpm serve`) refuses to start if
  the env var is unset. Without it there is no authentication on the WebSocket endpoint.
- **Agent-run logs**: every session spawn and exit is logged to
  `<dataDir>/logs/<sessionId>.log` (spawn: cmd + args + cwd + prompt; exit: code + signal +
  status + last 2KB of PTY output). Process-level errors land in `<dataDir>/logs/server.log`.
  When debugging a red "errored" bubble, read the per-session log first — it shows the exit
  code and the tail of what the agent printed before dying. See `electron/services/runLogger.ts`.
- **Repo paths are frozen at registration time**: `repoRegistry.ts` stores `path: absPath`
  and never re-validates it. If a repo directory is moved or renamed (e.g. the
  `flotilla` → `slipstream` rename), the DB row still points at the dead path and every
  agent run against it fails silently — deep in `worktrees.create`, no clear error, just the
  red bubble. Fix: update `repos.path` in SQLite, or re-register the repo. FLO-40 will make
  repos resolve dynamically by remote URL instead of trusting a frozen path.
- **`--slipstream-daemon=` additionalArguments**: `main.ts` passes the daemon URL + token to
  the renderer via `additionalArguments: ['--slipstream-daemon=<base64>']`. The preload
  reads `process.argv` (not `ipcRenderer`) to parse this arg and exposes it as
  `window.__slipstreamDaemon = { url, token }`. `src/main.ts` detects `__slipstreamDaemon`
  and calls `bootElectron()` (which runs `createWsApi`) rather than `bootWeb()`. If
  `window.__slipstreamDaemon` is absent, the app falls back to web mode. Symptom if broken:
  `window.slipstream` is undefined and all backend calls silently no-op.
- **The daemon survives app-close.** `main.ts` spawns the local daemon `detached + unref()`d,
  so quitting the desktop does **not** stop it — it keeps the PTYs alive and keeps holding the
  port recorded in `<dataDir>/daemon.json`. On next launch `ensureLocalDaemon` finds it via
  `/healthz` and **reuses** it. To fully reset (free the port, drop live sessions, pick up new
  daemon/server code): kill the daemon process (it's the `ELECTRON_RUN_AS_NODE` `server.js`
  listening on the `daemon.json` port), or launch with `SLIPSTREAM_DAEMON_EPHEMERAL=1` to tie
  its lifetime to the window. Symptom if forgotten: relaunch reattaches to stale sessions, or
  "port in use", or backend edits seem to have no effect.
- **`pnpm dev` builds `server.js` once, up front — it does not hot-reload.** The `dev` script
  is `node scripts/build-server.mjs && vite`; the daemon is the *built* `dist-electron/server.js`.
  Vite hot-reloads the renderer and restarts `main`, but a restarted `main` just *reuses* the
  already-running daemon (via `/healthz`). So edits to `server.ts` or any `electron/services/*`
  / `electron/core/*` code the daemon runs **won't take effect** until you rebuild server.js
  *and* kill the running daemon so a fresh one spawns. Renderer-only work doesn't need this.
- **Identity seam (`ownerId`)**: every RPC request carries a resolved `Identity` (today
  always `{ id: 'local' }` via `resolveIdentity` in `electron/core/auth.ts`). `createRpc`
  filters enumerations and guards single-item reads by `ownerId`; it's a deliberate no-op
  for the single user (legacy rows coalesce to `'local'`). Don't add a read of a
  `sessions`/`repos` row without scoping it by owner. See `docs/IDENTITY-SEAM.md`.

## Troubleshooting native setup

pnpm 11 no longer reads the `pnpm` field in `package.json`; the build-script allowlist lives
in `pnpm-workspace.yaml` under `allowBuilds:` (a map of `pkg: true`). On a fresh/odd machine:

```sh
pnpm rebuild esbuild electron better-sqlite3 node-pty   # run native build scripts
# Electron binary "failed to install": its postinstall didn't extract the zip. On Node 24,
# install.js can exit mid-extraction (leaving only dist/locales) — pin Node 22 or, failing
# that, manually unzip the cached ~/.cache/electron/<hash>/electron-*.zip into
# node_modules/electron/dist/ and write "electron" to node_modules/electron/path.txt
node node_modules/electron/install.js                   # re-run; if it no-ops, unzip manually
pnpm dlx @electron/rebuild --force --only better-sqlite3,node-pty   # match Electron ABI
```

## e2e drivers

`scripts/e2e/*.mjs` launch the **built** app via Playwright in an isolated
`--user-data-dir`, stub the native folder dialog, drive a flow, and screenshot to `/tmp`.
They require a display (not headless). Build first (`pnpm build`), then
`node scripts/e2e/<flow>.mjs`. Do **not** drive `Start agent` with a real repo unless you
intend to spawn an autonomous `claude`.

Every driver launches with `env: { SLIPSTREAM_DAEMON_EPHEMERAL: '1' }` so the daemon dies on
`app.close()` — without it, each run would leave an orphan daemon holding a port. The one
exception is `daemon-survival-flow.mjs`, which deliberately omits the flag to prove the daemon
outlives the UI and is reused on relaunch (so it leaves a daemon running — kill it afterward).

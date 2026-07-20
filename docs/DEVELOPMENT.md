# Development loop

Day-to-day reference for working in this repo: the dev server / daemon rebuild
cycle, the test setup, reading agent-run logs, and the e2e drivers. The
always-on command summary and conventions live in [../CLAUDE.md](../CLAUDE.md);
the design lives in [ARCHITECTURE.md](ARCHITECTURE.md); native-build pain lives
in [NATIVE-MODULES.md](NATIVE-MODULES.md).

## `pnpm dev` does not hot-reload the backend daemon

The `dev` script is `node scripts/build-server.mjs && vite`; the daemon is the
*built* `dist-electron/server.js`. Vite hot-reloads the renderer and restarts
`main`, but a restarted `main` just *reuses* the already-running daemon (via
`/healthz`).

So edits to `server.ts` or any `electron/services/*` / `electron/core/*` code the
daemon runs **won't take effect** until you rebuild server.js *and* kill the
running daemon so a fresh one spawns.

Use **`pnpm dev:backend`** to do this in one step — it rebuilds `server.js`,
kills the daemon on the `daemon.json` port, and respawns a fresh one so your
backend edits take effect (reload the app window if it's open). Renderer-only
work doesn't need this.

## The daemon survives app-close

`main.ts` spawns the local daemon `detached + unref()`d, so quitting the desktop
does **not** stop it — it keeps the PTYs alive and keeps holding the port
recorded in `<dataDir>/daemon.json`. On next launch `ensureLocalDaemon` finds it
via `/healthz` and **reuses** it.

To fully reset (free the port, drop live sessions, pick up new daemon/server
code): kill the daemon process (it's the `ELECTRON_RUN_AS_NODE` `server.js`
listening on the `daemon.json` port), or launch with
`SLIPSTREAM_DAEMON_EPHEMERAL=1` to tie its lifetime to the window —
`pnpm dev:backend` automates the rebuild+kill+respawn part of this for the
normal dev loop. Symptom if forgotten: relaunch reattaches to stale sessions, or
"port in use", or backend edits seem to have no effect.

`SLIPSTREAM_DAEMON_EPHEMERAL=1` is a dev-only env flag (used by the e2e drivers)
— the systemd `pnpm serve` service and the Docker/pod image never set it, and
`main.ts` only reads it from the environment, so it can't leak into production
daemon startup.

## Tests: vitest uses `vitest.config.ts`

vitest uses `vitest.config.ts` (not the Vite config) so tests don't run through
the Electron plugin (which rewrites `child_process` into a require-shim that
breaks ESM).

## Debugging: agent-run logs

Every session spawn and exit is logged to `<dataDir>/logs/<sessionId>.log`
(spawn: cmd + args + cwd + prompt; exit: code + signal + status + last 2KB of
PTY output). Process-level errors land in `<dataDir>/logs/server.log`.

When debugging a red "errored" bubble, read the per-session log first — it shows
the exit code and the tail of what the agent printed before dying. See
`electron/services/runLogger.ts`.

## e2e drivers

`scripts/e2e/*.mjs` launch the **built** app via Playwright in an isolated
`--user-data-dir`, stub the native folder dialog, drive a flow, and screenshot
to `/tmp`. They require a display (not headless). Build first (`pnpm build`),
then `node scripts/e2e/<flow>.mjs`. Do **not** drive `Start agent` with a real
repo unless you intend to spawn an autonomous `claude`.

Every driver launches with `env: { SLIPSTREAM_DAEMON_EPHEMERAL: '1' }` so the
daemon dies on `app.close()` — without it, each run would leave an orphan daemon
holding a port. The one exception is `daemon-survival-flow.mjs`, which
deliberately omits the flag to prove the daemon outlives the UI and is reused on
relaunch (so it leaves a daemon running — kill it afterward).

- **`smoke-add-repo.mjs`** is the CI smoke driver — no screenshots, asserts
  `window.slipstream` is present and the repo count increases after Add repo,
  and exits nonzero on any failed assertion. It runs unattended in the
  `e2e-smoke` GitLab CI job under `xvfb-run`, on a nightly schedule and
  `when: manual` on merge requests.

- **`restart-recovery-flow.mjs`** is the headless restart/crash-recovery CI
  driver (FLO-135) — the only path that exercises reconnect/replay/restart.
  Unlike the drivers above it needs **no display and no Electron**: it runs
  the daemon directly (`ELECTRON_RUN_AS_NODE` server.js) and drives the web UI
  with Playwright chromium. A stub `claude` on PATH emits a marker; the driver
  SIGKILLs the daemon, restarts against the same data dir, and asserts the
  orphaned session is marked `interrupted` (`restoreInterruptedSessions` on
  boot) and its scrollback replays via `getSessionBuffer`. Runs in the
  `e2e-restart` GitLab CI job, scheduled + `when: manual`, alongside
  `e2e-smoke`.

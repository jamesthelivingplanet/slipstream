# Development loop

Day-to-day reference for working in this repo: the dev server / daemon rebuild
cycle, the test setup, reading agent-run logs, and the e2e drivers. The
always-on command summary and conventions live in [../CLAUDE.md](../CLAUDE.md);
the design lives in [ARCHITECTURE.md](ARCHITECTURE.md); native-build pain lives
in [NATIVE-MODULES.md](NATIVE-MODULES.md).

## Dev vs prod deploy targets

If you're working in a linked git worktree (e.g. a per-ticket worktree under
`.claude/worktrees/`), this is day-one: `pnpm deploy` from there can **never**
reach production. It always deploys an isolated instance scoped to that
worktree. This matters the moment you run `pnpm deploy` or `pnpm dev` for the
first time from a worktree — read this before you go looking for your change
on port 7421.

|              | prod                              | dev                                          |
| ------------ | ---------------------------------- | --------------------------------------------- |
| checkout     | main worktree only                 | any linked worktree                           |
| systemd unit | `slipstream.service`               | `slipstream-dev@<slug>.service` (template)    |
| env file     | `~/.config/slipstream/server.env`  | `~/.config/slipstream/dev-slots/<slug>.env`   |
| port         | 7421                               | allocated from 7431 up                        |
| data dir     | `~/.config/slipstream`             | `~/.local/share/slipstream-dev/<slug>`        |
| tailscale    | `serve --https=443`                | `serve --https=<tsPort>`, allocated from 8443 up |
| APK publish  | yes (phase 6)                      | no                                            |

**Target resolution is structural, not path matching.** `scripts/lib/target.sh`
compares `git rev-parse --absolute-git-dir` against the absolute
`--git-common-dir`: for the main worktree they're the same path; for a linked
worktree the git-dir lives under `<common-dir>/worktrees/<name>`, so they
differ. Different ⇒ linked worktree ⇒ target is always `dev`. Nothing about
this depends on where the clone happens to live on disk.

**Hard guard.** From a linked worktree, `--target=prod` or
`SLIPSTREAM_TARGET=prod` makes `pnpm deploy` exit 1 immediately — no flag or
env var can override it. Production can only ever be deployed from the main
checkout.

Dev instances are tracked in a slot registry,
`~/.config/slipstream/dev-slots.json` (slug → port/tsPort/dataDir). Ports 7421
and 443 are permanently reserved in that registry so a dev slot can never
claim prod's. `pnpm deploy` prunes slots whose worktree directory no longer
exists, so `git worktree remove` cleans up after itself with no git hook
required.

New commands:

- **`pnpm dev:slots`** — lists every registered dev slot (slug, port, tsPort,
  root, whether the worktree still exists).
- **`pnpm dev:down`** — stops and disables *this worktree's* systemd unit,
  removes its env file, and releases its slot from the registry.

`pnpm dev` / `pnpm dev:backend` also pick up on this from a linked worktree:
they run through `scripts/dev.mjs`, which sets `SLIPSTREAM_DATA_DIR` to the
worktree's own dev data dir — so a `pnpm dev` session in a worktree can no
longer open production's `slipstream.db`. From the main worktree, behavior is
unchanged.

### Three enforcement layers — know the division of labour

These are three independent, differently-scoped guards. None of them
individually blocks everything; be precise about which one is doing what:

1. **`deploy.sh` target guard** — stops `pnpm deploy` itself from reaching
   prod from a worktree (see the hard guard above). This is the only layer
   that actually prevents a *deploy*.
2. **PreToolUse hook** (`.claude/settings.json` → `scripts/guard-prod.mjs` →
   `scripts/lib/prodGuard.mjs`) — stops an agent from bypassing `deploy.sh`
   with raw bash: mutating `systemctl` on `slipstream.service`, running
   `tailscale serve`/`funnel` on port 443, or writing under
   `~/.config/slipstream` or `~/.repositories/slipstream`. It's a
   best-effort **textual** guard, not a shell parser, and it's deliberately
   biased toward false negatives so it never wrongly blocks a legitimate
   command. It does **not** stop a determined bypass (`eval`, base64,
   subshells, etc.) — it isn't meant to.
3. **bwrap** (`electron/services/agentSandbox.ts`, opt-in via
   `SLIPSTREAM_SANDBOX=bwrap`) — **filesystem containment only**: hides
   prod's data dir and makes the prod checkout read-only inside a sandboxed
   agent PTY's mount namespace. It **cannot** block `systemctl` or
   `tailscale`, because the systemd user bus and the network namespace stay
   shared by design — a dev deploy launched from inside an agent PTY needs
   both. New dev slots enable it by default. Enabling it for **production**
   requires manually adding `SLIPSTREAM_SANDBOX=bwrap` to
   `~/.config/slipstream/server.env` and restarting the service — without
   that manual step, agents spawned by the prod daemon are not contained.

### How do I actually use this

From inside a linked worktree:

```sh
pnpm deploy                # builds, then deploys THIS worktree's dev instance
```

The summary at the end prints your slug, port, tsPort, and data dir. To find
it again later, or to check on other worktrees' instances:

```sh
pnpm dev:slots
```

Reach it locally at `http://127.0.0.1:<port>/`, or over Tailscale (if
`tailscale` is installed) at the tailnet HTTPS URL printed at the end of the
deploy — `https://<machine>.<tailnet>.ts.net:<tsPort>/`. Both are printed
again by `pnpm dev:slots` (port only; re-run `pnpm deploy` to get the
Tailscale URL restated).

When you're done with the worktree:

```sh
pnpm dev:down               # stops+disables this worktree's unit,
                             # removes its env file, releases its slot
```

`git worktree remove` also cleans up the slot registry entry automatically on
the next `pnpm deploy` anywhere (via the prune step), but `pnpm dev:down`
stops the running service immediately instead of waiting for that.

### Dev data dirs live outside `~/.config/slipstream` — on purpose

Dev instance **data dirs** live under `~/.local/share/slipstream-dev/<slug>`,
never nested under `~/.config/slipstream` (prod's data dir). This is required
for bwrap containment to work correctly: bwrap's `--tmpfs` over prod's data
dir (see layer 3 above) would shadow anything living underneath it, including
a dev instance's own `sessions/<sid>` bind mount that the daemon's
`fs.watch`-based status sentinel depends on. Per-slot **env files** are the
exception and intentionally stay under
`~/.config/slipstream/dev-slots/<slug>.env` — only the data dir moves out.

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

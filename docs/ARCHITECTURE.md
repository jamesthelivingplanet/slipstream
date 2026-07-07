# Architecture

Slipstream is an Electron app with a clear split: a **main process** that owns everything
privileged (PTYs, git, SQLite, ticket sources) and a **Svelte renderer** that talks to it
only through a typed bridge. The single source of truth for that boundary is
[`electron/shared/contract.ts`](../electron/shared/contract.ts).

## Process model

```
Renderer (Svelte)  ──window.slipstream──▶  wsApi  ──WebSocket /rpc──▶  daemon (server.ts)
   xterm, stores     (createWsApi)        ws://127.0.0.1:<port>        createRpc → services
        ▲                                                                    │
        └──────────────── session:data / session:status (push) ─────────────┘

Electron main  ──spawns──▶  daemon (ELECTRON_RUN_AS_NODE=1, server.js)
  daemonManager              survives app-close unless SLIPSTREAM_DAEMON_EPHEMERAL=1
```

- **`electron/core/daemonManager.ts`** resolves or spawns the local daemon. On startup,
  `main.ts` calls `resolveDaemonConfig` (reads `daemon.json` from `userData`, or falls back
  to `SLIPSTREAM_DAEMON_URL` for remote mode) and then `ensureLocalDaemon` (polls `/healthz`;
  spawns `server.js` via `ELECTRON_RUN_AS_NODE=1` if not already running). The daemon is
  `detached + unref()`d by default so it outlives the app; set `SLIPSTREAM_DAEMON_EPHEMERAL=1`
  to tie its lifetime to the window.
- **`preload.ts`** no longer exposes `window.slipstream`. Instead it reads the
  `--slipstream-daemon=<base64>` argument passed via `additionalArguments` and exposes:
  - `window.__slipstreamDaemon` — `{ url, token }` (the WS URL + bearer token)
  - `window.__slipstreamNative` — `{ pickFolder() }` backed by `ipcRenderer.invoke(IPC.pickRepo)`
- **`src/main.ts`** detects `window.__slipstreamDaemon` and calls `bootElectron()`, which
  calls `createWsApi({ url, token })` and assigns `window.slipstream` **before** importing
  `App.svelte` (preserving the `hasBackend` ordering invariant).
- **`ipc.ts`** retains the `IpcDeps` interface (used by `rpc.ts` and `server.ts`) but the
  `registerIpc` Electron adapter has been removed — the renderer now reaches all services
  over WebSocket, the same path as web mode.

> ⚠️ The preload is CJS (`preload.cjs`), compiled via `output.format: 'cjs'` +
> `entryFileNames: '[name].cjs'` in `vite.config.ts` (package.json has
> `"type": "module"`, so the `.cjs` extension is what forces CJS loading). This
> lets the `BrowserWindow` run with `sandbox: true` — restored per FLO-84 now
> that the preload only parses `--slipstream-daemon=` and exposes the folder
> picker. If the bundler ever emits a top-level ESM `import`/`export` into the
> output, the sandboxed preload fails to load and the bridge silently fails.

## Data model (`contract.ts`)

- **RepoDTO** — `{ id, org, name, base, path }` (base = main/master/develop).
- **WorktreeInfo** — `{ branch, path, dirty, ahead, behind, added, deleted }`.
- **SessionDTO** — `{ id (uuid), tid, title, prompt, repoId, branch, status, port?, createdAt }`.
- **TicketDTO** — `{ id, tid, src, title, repoHint? }`.
- **PromptTemplateDTO** — `{ id (uuid), repoId, name, body, createdAt, ownerId? }` (FLO-98
  reusable per-repo kickoff prompts).
- **SessionStatus** — `idle | running | needs | done | errored`.
- **SessionOutcomeDTO** — `{ sessionId, result (success|partial|failure), summary, details?, reportedAt }`
  (FLO-97): the agent's own structured final summary of a run, durable in SQLite.

## Main-process services

| Service | Responsibility |
|---------|----------------|
| `repoRegistry` | Register/list/get/remove repos in SQLite. `register` **validates** the folder is a git work tree with commits (else throws); idempotent. |
| `worktreeManager` | `pathFor`/`create`/`status`/`list`/`remove`. **Guarded remove** refuses dirty or unmerged worktrees unless forced. Diff stats + ahead/behind via git. |
| `sessionManager` | Spawns `claude --dangerously-skip-permissions "<prompt>"` via **node-pty** in the worktree cwd; emits `data`/`status`/`exit`; `write`/`resize`/`kill`. |
| `statusDetector` | Classifies a session from PTY output + lifecycle: recent output → `running`; idle + question-like tail → `needs`; exit 0 → `done`, non-zero → `errored`. Coarse heuristics, unit-tested. |
| `portBroker` | `floo claim <service>` in the worktree cwd → sticky port; injected as env. Swallowed if `floo` is absent. |
| ticket provider | `ITicketProvider.listTickets()`. Currently `createEmptyProvider()` (returns `[]`); real Jira/Linear slot in behind the same interface. |
| `promptTemplates` | `IPromptTemplateStore` — per-repo reusable kickoff prompt templates (FLO-98), synchronous CRUD over the `prompt_templates` table; owner-scoped in `rpc.ts`. |

## Renderer

- **Stores** (`lib/stores.ts`): `repos`, `sessions`, `tickets`, `selectedId`, plus
  `settingsOpen`/`dialogOpen`. `initFromBackend()` fills repos+tickets from the backend and
  clears sessions (real sessions start empty). Actions: `registerRepo`, `removeRepoById`,
  `createBlankAgent`, `createAgentFromTicket`, `startAgent`, `setSessionStatus`, etc.
- **`lib/ipc.ts`**: thin `hasBackend`-guarded wrappers over `window.slipstream`, so the UI
  still renders in a plain browser (no backend) for design work.
- **`TerminalView.svelte`**: in `liveMode` (`hasBackend`) it pipes `onSessionData → term`,
  `term.onData → writeSession`, resize → `resizeSession`, and `onSessionStatus →
  setSessionStatus`. Otherwise it runs a local simulation (browser/demo).
- **Toasts** (`lib/toast.ts` + `Toasts.svelte`): success/error feedback, auto-dismiss.
- Design tokens + component CSS live in `src/app.css` (shadcn-style HSL variables;
  `data-mode` light/dark, `data-accent` swatches).

## Filesystem conventions

- **Root** = Electron `app.getPath('userData')`. DB at `root/slipstream.db`.
- **Worktrees**: `~/.worktrees/<org>-<name>/<branch>`.
- **Branches**: always cut from the repo's base branch.
- Repos are referenced **in place** by absolute path (we don't relocate them).

## Web mode (headless server)

The same Svelte renderer can run in a plain browser (e.g. a phone over Tailscale) by
replacing the Electron IPC transport with a WebSocket. The process model:

```
Browser (Svelte)  ──window.slipstream──▶  wsApi  ──WebSocket /rpc──▶  server.ts
   xterm, stores     (createWsApi)       ws://host:7421              createRpc → same services
        ▲                                                                  │
        └──────────────── session:data / session:status (push) ───────────┘
```

### Refactored seams

- **`electron/core/services.ts`** — `createServices(root)` extracts service wiring from
  `main.ts` so both the Electron entry and the headless server share one factory.
  `resolveDataDir()` reproduces `app.getPath('userData')` in plain Node (no Electron API):
  honors `SLIPSTREAM_DATA_DIR`, else `~/.config/slipstream` on Linux (XDG), macOS Library, or
  `%APPDATA%` on Windows. `createServices` calls `mkdirSync(root, {recursive:true})` so a
  fresh data directory never crashes on first run.
- **`electron/core/rpc.ts`** — `createRpc(deps, emit)`: transport-free request router
  containing all channel-dispatch logic. The Electron IPC adapter (`electron/ipc.ts`) and
  the WS server both call it. `emit` is a callback the caller provides to forward push
  events (`session:data`, `session:status`) to the appropriate transport. Unit-testable in
  plain Node.

### Wire protocol (`electron/shared/wire.ts`)

Three envelope types over a single WebSocket at `/rpc`:

| Type | Direction | Shape |
|------|-----------|-------|
| `WireReq` | client → server | `{t:'req', id, channel, args[]}` |
| `WireRes` | server → client | `{t:'res', id, ok, result\|error}` |
| `WirePush` | server → client | `{t:'push', channel, args[]}` |

`channel` values are the `IPC.*` constants from `contract.ts`. Requests correlate with
responses by `id` (UUID). Pushes are unsolicited (PTY data/status events).

### `createServer` (`electron/server/server.ts`)

HTTP serves the built `dist/` SPA (with SPA fallback) + `GET /healthz`.  
WebSocket at `/rpc` authenticates on upgrade via `?token=` query param or
`Authorization: Bearer` header against `SLIPSTREAM_TOKEN`; rejects with HTTP 401 before the
upgrade completes (close code 4001 on the client). Refuses to start with no token.

Env vars:

| Variable | Default | Purpose |
|----------|---------|---------|
| `SLIPSTREAM_TOKEN` | — (required) | Bearer secret; server exits if unset |
| `SLIPSTREAM_BIND` | `127.0.0.1` | Bind address (set to Tailscale IP to expose on tailnet) |
| `SLIPSTREAM_PORT` | `7421` | Listen port |
| `SLIPSTREAM_DATA_DIR` | platform userData | Override data directory |

### Renderer web boot (`src/main.ts` + `src/lib/wsApi.ts`)

`src/main.ts` detects the absence of `window.slipstream` (no preload) and runs `bootWeb()`:
resolves a token from `?token=` query param (stored in localStorage, stripped from URL) or
shows a `TokenGate` login component. Once a token is in hand, `createWsApi({url, token})`
constructs the WS-backed `SlipstreamApi` — with pre-open request queueing, per-request 30 s
timeout, and exponential auto-reconnect. `window.slipstream` and `window.__slipstreamWeb=true`
are assigned **before** `App.svelte` is dynamically imported, so `ipc.ts`'s module-level
`hasBackend = !!window.slipstream` evaluates `true`. `pickAndRegisterRepo` returns `null` on
web (no native dialog); the Settings → Repositories tab shows an "add by absolute path"
input instead, gated by `window.__slipstreamWeb`.

### Access model

Intended to be reached over a **Tailscale** tailnet (`SLIPSTREAM_BIND` = tailnet IP).
Tailscale encrypts the tunnel, so the server speaks plain HTTP — no TLS needed.
The bearer token provides application-layer authentication on top.

> Not intended for public internet exposure.

### Session locality

PTY sessions live in the daemon process. Because the daemon survives app-close (it is
`detached + unref()`d), sessions persist between Electron launches. A new Electron window
reconnects to the same daemon over WebSocket and replays buffered output via
`IPC.getSessionBuffer`. Set `SLIPSTREAM_DAEMON_EPHEMERAL=1` to revert to the old behavior
(daemon killed on `before-quit`).

### Session lifecycle is client-independent

PTY sessions are owned by the backend process, not by any WebSocket client. A client
disconnect (`ws` `close`/`error`) triggers only `rpc.dispose()` in `electron/server/server.ts`,
which detaches that client's `data`/`status` event listeners and clears its coalescing flush
timer — it never reaps a PTY. PTYs are ended solely by:

- explicit `IPC.killSession` → `sessions.kill()` in `electron/core/rpc.ts`,
- `attachRemoteControl` replacement (same file),
- `sessions.killAll()` called from `electron/main.ts` on Electron's `before-quit` event
  (full process shutdown), or
- the **session reaper** (`electron/services/sessionReaper.ts`, FLO-52) — a 60s daemon
  timer that reaps a session via `sessions.reap()` when it matches the configurable
  `GcPolicy` (abandoned/idle/aged, or auto-stop on `done`). A reap kills the PTY, persists
  the session as `reaped` (a visible sidebar record), and logs the reason to `server.log`.
  Policy is edited under Settings → Behavior → "Session cleanup" and stored in the `gc.policy`
  config key.

A late-reconnecting client recovers missed output by calling `IPC.getSessionBuffer`, which
returns the session's `OutputBuffer` snapshot (`electron/services/outputBuffer.ts`) — a
bounded ring-buffer of the last 256 KB of PTY output.

### Structured session outcomes (FLO-97)

The 256 KB output ring-buffer is scrollback, not a record — it truncates, and it's not
queryable. FLO-97 gives agents a way to leave a durable, structured final summary: the app
MCP's `report_outcome` tool (`electron/mcp/appMcp.ts`) writes an `outcome.json` sentinel next
to `status.json`/`pr.json` in `<dataDir>/sessions/<id>/`. `sessionManager.ts`'s existing
fs.watch on that directory picks it up, parses it with `outcomeSentinel.ts` (mirrors
`statusSentinel.ts`), and emits a typed `outcome` event; `sessionPersistence.ts` (FLO-69)
subscribes at the daemon level and upserts it into the `session_outcomes` table
(`electron/db/migrations.ts` migration 3) via `outcomeStore.ts` — so it survives with zero
clients attached, same as status/PR persistence. `IPC.getSessionOutcome` and
`IPC.listSessionHistory` (`electron/core/rpc.ts`) read it back, with a disk-fallback that
re-parses `outcome.json` directly when the store misses (covers the daemon-restart race where
an agent finishes before the watcher reattaches) and backfills the store on a successful read.
`listSessionHistory` joins every owned `SessionDTO` with its outcome and transcript usage
(FLO-94) into a `SessionHistoryEntry[]`, most recent first — this is what powers the History
view (browse by repo, compare prompts/outcomes).

## Key decisions

- **Electron + Svelte** over Tauri — `node-pty` is the proven path for many concurrent
  terminals.
- **Desktop-as-thin-client**: Electron main spawns a local daemon child and the renderer
  talks to it over WebSocket — the same transport as web mode. The daemon survives app-close
  (detached + unref) so agents keep running with the UI closed.
- **No mock data** — the app is real-data-only; ticket access is behind `ITicketProvider`.
- **Schema is inlined** in `db.ts` (the bundler doesn't copy a `.sql` file next to the
  bundled `main.js`).
- **Native modules** (`node-pty`, `better-sqlite3`) are built for Electron's ABI, so the
  node-run test suite covers pure logic + real-git integration rather than importing them.

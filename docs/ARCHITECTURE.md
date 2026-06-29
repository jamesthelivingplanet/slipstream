# Architecture

Slipstream is an Electron app with a clear split: a **main process** that owns everything
privileged (PTYs, git, SQLite, ticket sources) and a **Svelte renderer** that talks to it
only through a typed bridge. The single source of truth for that boundary is
[`electron/shared/contract.ts`](../electron/shared/contract.ts).

See also: [Positioning](POSITIONING.md) · [Roadmap](ROADMAP.md).

## Process model

```
Renderer (Svelte)  ──window.slipstream──▶  preload  ──ipcRenderer──▶  main (ipcMain)
   xterm, stores                          (contextBridge)            services + node-pty
        ▲                                                                  │
        └────────────── session:data / session:status (push) ─────────────┘
```

- **`preload.ts`** exposes `window.slipstream` (the `SlipstreamApi`) via `contextBridge`,
  forwarding to `ipcRenderer.invoke/send` keyed by the `IPC` channel constants.
- **`ipc.ts` / `registerIpc(win, deps)`** registers the `ipcMain` handlers and forwards
  PTY `data`/`status` events to the renderer with `win.webContents.send(...)`.
- **`main.ts`** constructs the concrete services and calls `registerIpc`. It is the only
  place that wires implementations together; services never import each other.

> ⚠️ The preload is ESM (`preload.mjs`). Electron only loads an ESM preload when
> `sandbox: false`, and the bundler must emit ESM (`output.format: 'es'`) or it writes
> `require()` into a `.mjs` and the bridge silently fails to load.

## Data model (`contract.ts`)

- **RepoDTO** — `{ id, org, name, base, path, remoteUrl? }`. `path` is the current on-disk checkout (no longer frozen at registration); `remoteUrl` is the git origin URL used as stable identity to self-heal a moved/renamed checkout (FLO-40).
- **WorktreeInfo** — `{ branch, path, dirty, ahead, behind, added, deleted }`.
- **SessionDTO** — `{ id (uuid), tid, title, prompt, repoId, branch, status, port?, systemPrompt?, agentKind?, opencodeSid?, createdAt }`. `agentKind: BackendKind` selects the agent backend.
- **TicketDTO** — `{ id, tid, src, title, description?, done, repoHint?, status? }`. `src: 'jira' | 'linear'`; `done` = workflow state is completed; `status?: WorkflowState`.
- **BackendKind** — `'claude-code' | 'opencode'`.
- **WorkflowState** — `{ id, name, type? }` (linear `type`: `backlog|unstarted|started|completed|canceled`).
- **SessionStatus** — `idle | running | needs | done | errored`.

## Main-process services

| Service | Responsibility |
|---------|----------------|
| `repoRegistry` | Register/list/get/remove repos in SQLite. `register` validates the folder is a git work tree with commits; idempotent; backfills `remoteUrl` for legacy rows. `resolvePath(id)` resolves the repo's current on-disk path by matching `remoteUrl` against sibling directories, self-healing the DB when the checkout was moved/renamed (FLO-40). Also exposes `getSettings`/`setSettings` for per-repo config. |
| `worktreeManager` | `pathFor`/`create`/`status`/`list`/`remove`. **Guarded remove** refuses dirty or unmerged worktrees unless forced. Diff stats + ahead/behind via git. |
| `sessionManager` | Backend-aware PTY manager. **`claude-code`** (default) spawns `claude --dangerously-skip-permissions …` via node-pty in the worktree cwd. **`opencode`** spawns `opencode --port <p> …`, delivering the system prompt via an `AGENTS.md` file and the user prompt via `--prompt`. Beyond `start`/`write`/`resize`/`kill`/`killAll`, exposes `resume` (restart a persisted session), `attachRemoteControl` (spawns claude with `--remote-control` to re-attach a live session), and `getBuffer` (replay the `OutputBuffer`). Status: claude-code uses `statusDetector` PTY heuristics; opencode polls the embedded server's messages (`setOpencodeSid` begins polling). |
| `statusDetector` | Classifies a session from PTY output + lifecycle: recent output → `running`; idle + question-like tail → `needs`; exit 0 → `done`, non-zero → `errored`. Coarse heuristics, unit-tested. |
| `portBroker` | `floo claim <service>` in the worktree cwd → sticky port; injected as env. Swallowed if `floo` is absent. |
| `configStore` | SQLite `config` table storing the Linear API key and editor config (`EditorConfig`). |
| `sessionStore` | Persists `SessionDTO` metadata to SQLite so sessions survive restart. PTY processes are not persisted — only metadata. |
| `ticket provider` | `linearProvider` (`createLinearProvider`, behind `ITicketProvider`). Reads a personal API key from `configStore` and queries Linear's GraphQL over `fetch`. Methods: `listTickets`, `getTicketStatus`/`setTicketStatus`, `startTicket` (moves ticket to "In Progress" when an agent starts — FLO-26), `resetTicket` (moves it back to "To Do" on cleanup — FLO-35). |
| `appRunner` | `run`: spawns the repo's configured start command as a detached shell process in the worktree cwd. |
| `editorLauncher` | `openInEditor`: launches the configured desktop or mobile editor on a worktree path. |
| `pushService` | Web-push / VAPID subscriptions and notification preferences. Notifies connected browsers when agent status changes. |
| `runLogger` | Per-session agent-run logs under `<dataDir>/logs/<sessionId>.log` (spawn: cmd + args + cwd + prompt; exit: code + signal + status + last 2 KB of PTY output). Process-level errors in `<dataDir>/logs/server.log`. |

## Agent backends

`sessionManager` supports two backends, selected per-session via `agentKind`:

- **`claude-code`** (default) — spawns `claude --dangerously-skip-permissions …` via node-pty. The system prompt is passed as a CLI argument; status is classified by `statusDetector` from PTY output heuristics.
- **`opencode`** — spawns `opencode --port <p> …`. The system prompt is written to an `AGENTS.md` file in the worktree; the user prompt is passed via `--prompt`. Status is driven by polling the embedded opencode server's message API (`setOpencodeSid` begins polling once the server session id is known).

**Remote-control attach** (`attachRemoteControl` / `--remote-control`): spawns claude with `--remote-control` so the UI can re-attach to or take over a running claude session. For opencode, the equivalent is resuming via `--session <sid>`.

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

- **Root** = resolved by `resolveDataDir()` in `electron/core/services.ts` (not a direct `app.getPath('userData')` call — headless mode has no Electron `app`): honors `SLIPSTREAM_DATA_DIR`, else platform userData (`~/.config/slipstream` XDG on Linux, macOS Library, `%APPDATA%` on Windows). DB at `root/slipstream.db`.
- **Worktrees**: `~/.worktrees/<org>-<name>/<branch>`.
- **Branches**: always cut from the repo's base branch.
- Repos are referenced **in place**; the stored `path` is the last-known checkout and is **re-resolved by `remoteUrl` on access** (self-healing via `repoRegistry.resolvePath`) — so a moved or renamed checkout no longer breaks agent runs.

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

PTY sessions live in whichever process spawned them. The standalone server (`pnpm serve`)
is its own backend and does **not** share live sessions with a separately-running desktop
app. Unifying them (desktop app as thin client of one daemon) is the "background daemon"
item on the ROADMAP; see [Daemon migration](DAEMON-MIGRATION.md).

## Key decisions

- **Electron + Svelte** over Tauri — `node-pty` is the proven path for many concurrent
  terminals.
- **PTYs are tied to app lifetime**; only metadata is persisted to SQLite. A background
  daemon for surviving app-close is a later phase.
- **No mock data** — the app is real-data-only; ticket access is behind `ITicketProvider`.
- **Schema is inlined** in `db.ts` (the bundler doesn't copy a `.sql` file next to the
  bundled `main.js`).
- **Native modules** (`node-pty`, `better-sqlite3`) are built for Electron's ABI, so the
  node-run test suite covers pure logic + real-git integration rather than importing them.

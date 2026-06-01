# Architecture

Flotilla is an Electron app with a clear split: a **main process** that owns everything
privileged (PTYs, git, SQLite, ticket sources) and a **Svelte renderer** that talks to it
only through a typed bridge. The single source of truth for that boundary is
[`electron/shared/contract.ts`](../electron/shared/contract.ts).

## Process model

```
Renderer (Svelte)  ──window.flotilla──▶  preload  ──ipcRenderer──▶  main (ipcMain)
   xterm, stores                          (contextBridge)            services + node-pty
        ▲                                                                  │
        └────────────── session:data / session:status (push) ─────────────┘
```

- **`preload.ts`** exposes `window.flotilla` (the `FlotillaApi`) via `contextBridge`,
  forwarding to `ipcRenderer.invoke/send` keyed by the `IPC` channel constants.
- **`ipc.ts` / `registerIpc(win, deps)`** registers the `ipcMain` handlers and forwards
  PTY `data`/`status` events to the renderer with `win.webContents.send(...)`.
- **`main.ts`** constructs the concrete services and calls `registerIpc`. It is the only
  place that wires implementations together; services never import each other.

> ⚠️ The preload is ESM (`preload.mjs`). Electron only loads an ESM preload when
> `sandbox: false`, and the bundler must emit ESM (`output.format: 'es'`) or it writes
> `require()` into a `.mjs` and the bridge silently fails to load.

## Data model (`contract.ts`)

- **RepoDTO** — `{ id, org, name, base, path }` (base = main/master/develop).
- **WorktreeInfo** — `{ branch, path, dirty, ahead, behind, added, deleted }`.
- **SessionDTO** — `{ id (uuid), tid, title, prompt, repoId, branch, status, port?, createdAt }`.
- **TicketDTO** — `{ id, tid, src, title, repoHint? }`.
- **SessionStatus** — `idle | running | needs | done | errored`.

## Main-process services

| Service | Responsibility |
|---------|----------------|
| `repoRegistry` | Register/list/get/remove repos in SQLite. `register` **validates** the folder is a git work tree with commits (else throws); idempotent. |
| `worktreeManager` | `pathFor`/`create`/`status`/`list`/`remove`. **Guarded remove** refuses dirty or unmerged worktrees unless forced. Diff stats + ahead/behind via git. |
| `sessionManager` | Spawns `claude --dangerously-skip-permissions "<prompt>"` via **node-pty** in the worktree cwd; emits `data`/`status`/`exit`; `write`/`resize`/`kill`. |
| `statusDetector` | Classifies a session from PTY output + lifecycle: recent output → `running`; idle + question-like tail → `needs`; exit 0 → `done`, non-zero → `errored`. Coarse heuristics, unit-tested. |
| `portBroker` | `floo claim <service>` in the worktree cwd → sticky port; injected as env. Swallowed if `floo` is absent. |
| ticket provider | `ITicketProvider.listTickets()`. Currently `createEmptyProvider()` (returns `[]`); real Jira/Linear slot in behind the same interface. |

## Renderer

- **Stores** (`lib/stores.ts`): `repos`, `sessions`, `tickets`, `selectedId`, plus
  `settingsOpen`/`dialogOpen`. `initFromBackend()` fills repos+tickets from the backend and
  clears sessions (real sessions start empty). Actions: `registerRepo`, `removeRepoById`,
  `createBlankAgent`, `createAgentFromTicket`, `startAgent`, `setSessionStatus`, etc.
- **`lib/ipc.ts`**: thin `hasBackend`-guarded wrappers over `window.flotilla`, so the UI
  still renders in a plain browser (no backend) for design work.
- **`TerminalView.svelte`**: in `liveMode` (`hasBackend`) it pipes `onSessionData → term`,
  `term.onData → writeSession`, resize → `resizeSession`, and `onSessionStatus →
  setSessionStatus`. Otherwise it runs a local simulation (browser/demo).
- **Toasts** (`lib/toast.ts` + `Toasts.svelte`): success/error feedback, auto-dismiss.
- Design tokens + component CSS live in `src/app.css` (shadcn-style HSL variables;
  `data-mode` light/dark, `data-accent` swatches).

## Filesystem conventions

- **Root** = Electron `app.getPath('userData')`. DB at `root/flotilla.db`.
- **Worktrees**: `root/.worktrees/<org>-<name>/<branch>`.
- **Branches**: always cut from the repo's base branch.
- Repos are referenced **in place** by absolute path (we don't relocate them).

## Web mode (headless server)

The same Svelte renderer can run in a plain browser (e.g. a phone over Tailscale) by
replacing the Electron IPC transport with a WebSocket. The process model:

```
Browser (Svelte)  ──window.flotilla──▶  wsApi  ──WebSocket /rpc──▶  server.ts
   xterm, stores     (createWsApi)       ws://host:7421              createRpc → same services
        ▲                                                                  │
        └──────────────── session:data / session:status (push) ───────────┘
```

### Refactored seams

- **`electron/core/services.ts`** — `createServices(root)` extracts service wiring from
  `main.ts` so both the Electron entry and the headless server share one factory.
  `resolveDataDir()` reproduces `app.getPath('userData')` in plain Node (no Electron API):
  honors `FLOTILLA_DATA_DIR`, else `~/.config/flotilla` on Linux (XDG), macOS Library, or
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
`Authorization: Bearer` header against `FLOTILLA_TOKEN`; rejects with HTTP 401 before the
upgrade completes (close code 4001 on the client). Refuses to start with no token.

Env vars:

| Variable | Default | Purpose |
|----------|---------|---------|
| `FLOTILLA_TOKEN` | — (required) | Bearer secret; server exits if unset |
| `FLOTILLA_BIND` | `127.0.0.1` | Bind address (set to Tailscale IP to expose on tailnet) |
| `FLOTILLA_PORT` | `7421` | Listen port |
| `FLOTILLA_DATA_DIR` | platform userData | Override data directory |

### Renderer web boot (`src/main.ts` + `src/lib/wsApi.ts`)

`src/main.ts` detects the absence of `window.flotilla` (no preload) and runs `bootWeb()`:
resolves a token from `?token=` query param (stored in localStorage, stripped from URL) or
shows a `TokenGate` login component. Once a token is in hand, `createWsApi({url, token})`
constructs the WS-backed `FlotillaApi` — with pre-open request queueing, per-request 30 s
timeout, and exponential auto-reconnect. `window.flotilla` and `window.__flotillaWeb=true`
are assigned **before** `App.svelte` is dynamically imported, so `ipc.ts`'s module-level
`hasBackend = !!window.flotilla` evaluates `true`. `pickAndRegisterRepo` returns `null` on
web (no native dialog); the Settings → Repositories tab shows an "add by absolute path"
input instead, gated by `window.__flotillaWeb`.

### Access model

Intended to be reached over a **Tailscale** tailnet (`FLOTILLA_BIND` = tailnet IP).
Tailscale encrypts the tunnel, so the server speaks plain HTTP — no TLS needed.
The bearer token provides application-layer authentication on top.

> Not intended for public internet exposure.

### Session locality

PTY sessions live in whichever process spawned them. The standalone server (`pnpm serve`)
is its own backend and does **not** share live sessions with a separately-running desktop
app. Unifying them (desktop app as thin client of one daemon) is the "background daemon"
item on the ROADMAP.

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

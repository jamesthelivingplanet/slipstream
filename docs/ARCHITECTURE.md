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

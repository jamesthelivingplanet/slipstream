# Flotilla

A desktop console for running and watching **many Claude Code agents at once** — one
agent per task, each `claude --dangerously-skip-permissions` running in its own git
worktree. Start them, watch them, and jump to whichever one needs you.

> Status: Phase 1 functional. The full agent loop is wired (register a repo → create an
> agent → start it in a fresh worktree → live terminal). See [docs/ROADMAP.md](docs/ROADMAP.md)
> for what's done and what's next.

## What it is

Two-pane desktop app: a list of **agents** on the left, the selected agent's **terminal**
on the right. You import git repos, create an agent (blank or from a ticket), pick a repo,
and **Start** — Flotilla cuts a worktree, assigns a sticky dev port, and streams the live
`claude` PTY into the terminal. Built to manage a fleet of them concurrently.

## Stack

- **Electron** (main process: PTYs, git, SQLite, IPC)
- **Svelte 4 + Vite + Tailwind**, shadcn-style design with live theming
- **xterm.js** terminals · **node-pty** processes · **better-sqlite3** persistence
- **TypeScript**, **pnpm**, **vitest** (unit + real-git integration), **Playwright** (e2e drivers)
- Sibling: [`floo`](https://github.com/) provides sticky `(repo, service)` → port via `floo claim`

## Quickstart

Prereqs: Node 20+, pnpm 10, the `claude` CLI on your PATH (to actually run agents), and
optionally `floo` (for dev-server ports).

```sh
pnpm install          # native build scripts are allowlisted (pnpm.onlyBuiltDependencies)
pnpm dev              # launch Vite + Electron
pnpm build            # production build (renderer + main + preload)
pnpm test             # vitest: unit + real-git worktree integration
pnpm check            # svelte-check typecheck
```

If a fresh machine has trouble with native modules / the Electron binary, see the
**Troubleshooting** section in [CLAUDE.md](CLAUDE.md) (Electron binary extraction,
`@electron/rebuild` for the ABI, etc.).

## Repo layout

```
electron/                 main process
  main.ts                 window + service wiring
  preload.ts              contextBridge → window.flotilla (ESM)
  ipc.ts                  registerIpc(): ipcMain handlers
  shared/contract.ts      types, service interfaces, IPC channels, FlotillaApi  (the seam)
  services/               repoRegistry, worktreeManager, sessionManager, statusDetector, portBroker
  db/db.ts                better-sqlite3 (schema inlined)
  tickets/                ITicketProvider impls (emptyProvider; real providers TBD)
src/                      Svelte renderer
  App.svelte, app.css     shell + shadcn token system
  lib/components/         AgentList, AgentConfig, TerminalView, NewAgentDialog, ThemeMenu, SettingsModal, Toasts
  lib/                    stores, ipc (client), types, branch, icons, theme, term, toast
scripts/e2e/              Playwright drivers (manual; launch the built app, screenshot flows)
prototype.html            original design reference (not used at runtime)
```

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — data model, the contract seam, services, IPC, conventions, decisions
- [docs/ROADMAP.md](docs/ROADMAP.md) — status by phase, what's next, known refinements
- [CLAUDE.md](CLAUDE.md) — agent/contributor notes: commands, conventions, gotchas

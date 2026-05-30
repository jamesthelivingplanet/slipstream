import { ipcMain, BrowserWindow } from 'electron'
import type {
  IRepoRegistry,
  IWorktreeManager,
  ISessionManager,
  IPortBroker,
  ITicketProvider,
  RepoDTO,
} from './shared/contract.js'
import { IPC } from './shared/contract.js'

export interface IpcDeps {
  repos: IRepoRegistry
  worktrees: IWorktreeManager
  sessions: ISessionManager
  ports: IPortBroker
  tickets: ITicketProvider
}

/** Convert a ticket title to a branch-safe slug, e.g. "Dark mode flickers" → "dark-mode-flickers" */
function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

/**
 * Register all IPC handlers for the renderer bridge.
 * Session event forwarding (data/status) is set up once here.
 */
export function registerIpc(win: BrowserWindow, deps: IpcDeps): void {
  // Tracks which repo+branch each session owns so cleanup can remove the worktree.
  const sessionMeta = new Map<string, { repo: RepoDTO; branch: string }>()

  // ── Repos ──────────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.listRepos, () => deps.repos.list())

  ipcMain.handle(IPC.registerRepo, (_e, absPath: string) =>
    deps.repos.register(absPath),
  )

  // ── Tickets ────────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.listTickets, () => deps.tickets.listTickets())

  // ── Sessions ───────────────────────────────────────────────────────────────

  ipcMain.handle(
    IPC.startSession,
    async (
      _e,
      input: { tid: string; title: string; prompt: string; repoId: string },
    ) => {
      const { tid, title, prompt, repoId } = input

      const repo = await deps.repos.get(repoId)
      if (!repo) throw new Error(`Unknown repo: ${repoId}`)

      const branch = `${tid}-${slug(title)}`
      await deps.worktrees.create(repo, branch)
      const cwd = deps.worktrees.pathFor(repo, branch)

      let port: number | undefined
      try {
        port = await deps.ports.claim(cwd, 'web')
      } catch {
        port = undefined
      }

      const session = deps.sessions.start({
        tid,
        title,
        prompt,
        repo,
        branch,
        cwd,
        env: port !== undefined ? { PORT: String(port) } : undefined,
      })

      sessionMeta.set(session.id, { repo, branch })

      return { ...session, port }
    },
  )

  // fire-and-forget writes/resizes use `on` (one-way)
  ipcMain.on(IPC.writeSession, (_e, id: string, data: string) =>
    deps.sessions.write(id, data),
  )

  ipcMain.on(
    IPC.resizeSession,
    (_e, id: string, cols: number, rows: number) =>
      deps.sessions.resize(id, cols, rows),
  )

  ipcMain.handle(IPC.killSession, (_e, id: string) => {
    deps.sessions.kill(id)
  })

  ipcMain.handle(
    IPC.cleanupSession,
    async (_e, id: string, opts?: { force?: boolean }) => {
      const meta = sessionMeta.get(id)
      if (!meta) return { removed: false, reason: 'session not found' }
      const result = await deps.worktrees.remove(meta.repo, meta.branch, opts)
      if (result.removed) sessionMeta.delete(id)
      return result
    },
  )

  // ── Forward session events to renderer ────────────────────────────────────

  deps.sessions.on('data', (sessionId, chunk) => {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.sessionData, sessionId, chunk)
    }
  })

  deps.sessions.on('status', (sessionId, status) => {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.sessionStatus, sessionId, status)
    }
  })
}

import type { IpcDeps } from '../ipc.js'
import { IPC } from '../shared/contract.js'
import type { RepoDTO } from '../shared/contract.js'

/** Convert a ticket title to a branch-safe slug, e.g. "Dark mode flickers" → "dark-mode-flickers" */
function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

export interface Rpc {
  /** Route one request by IPC channel name. Returns the result or throws. */
  handle(channel: string, args: unknown[]): Promise<unknown>
  /** Remove session event listeners. */
  dispose(): void
}

/**
 * Transport-free RPC core — no Electron imports.
 * `emit` is called when a push event (session data/status) should be sent to the client.
 */
export function createRpc(
  deps: IpcDeps,
  emit: (channel: string, ...args: unknown[]) => void,
): Rpc {
  // Tracks which repo+branch each session owns so cleanup can remove the worktree.
  const sessionMeta = new Map<string, { repo: RepoDTO; branch: string }>()

  function onData(sessionId: string, chunk: string): void {
    emit(IPC.sessionData, sessionId, chunk)
  }
  function onStatus(sessionId: string, status: string): void {
    emit(IPC.sessionStatus, sessionId, status)
  }

  deps.sessions.on('data', onData)
  deps.sessions.on('status', onStatus)

  async function handle(channel: string, args: unknown[]): Promise<unknown> {
    switch (channel) {
      case IPC.listRepos:
        return deps.repos.list()

      case IPC.registerRepo:
        return deps.repos.register(args[0] as string)

      case IPC.removeRepo:
        return deps.repos.remove(args[0] as string)

      case IPC.listTickets:
        return deps.tickets.listTickets()

      case IPC.startSession: {
        const input = args[0] as { tid: string; title: string; prompt: string; repoId: string }
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
      }

      case IPC.writeSession:
        deps.sessions.write(args[0] as string, args[1] as string)
        return undefined

      case IPC.resizeSession:
        deps.sessions.resize(args[0] as string, args[1] as number, args[2] as number)
        return undefined

      case IPC.killSession:
        deps.sessions.kill(args[0] as string)
        return undefined

      case IPC.cleanupSession: {
        const id = args[0] as string
        const opts = args[1] as { force?: boolean } | undefined
        const meta = sessionMeta.get(id)
        if (!meta) return { removed: false, reason: 'session not found' }
        const result = await deps.worktrees.remove(meta.repo, meta.branch, opts)
        if (result.removed) sessionMeta.delete(id)
        return result
      }

      case IPC.pickRepo:
        throw new Error('pickRepo is not supported without a desktop window')

      default:
        throw new Error(`Unknown channel: ${channel}`)
    }
  }

  function dispose(): void {
    // EventEmitter doesn't expose typed removeListener on the contract interface,
    // so we cast to access the standard Node EventEmitter API.
    const em = deps.sessions as unknown as {
      removeListener(event: string, listener: (...a: unknown[]) => void): void
    }
    em.removeListener('data', onData as (...a: unknown[]) => void)
    em.removeListener('status', onStatus as (...a: unknown[]) => void)
  }

  return { handle, dispose }
}

import type { IpcDeps } from '../ipc.js'
import { IPC } from '../shared/contract.js'
import type { RepoDTO, ISessionStore, SessionStatus, CreateTicketInput } from '../shared/contract.js'
import { branchFor } from '../shared/branch.js'
import { buildSystemPrompt } from '../shared/promptComposer.js'

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

  // Tracks persisted status to avoid redundant DB writes on every data chunk.
  const persistedStatus = new Map<string, string>()

  function onData(sessionId: string, chunk: string, seq: number): void {
    emit(IPC.sessionData, sessionId, chunk, seq)
  }
  function onStatus(sessionId: string, status: string): void {
    emit(IPC.sessionStatus, sessionId, status)
    // Persist status change to DB (only when it actually changes)
    const prev = persistedStatus.get(sessionId)
    if (prev !== undefined && prev !== status) {
      const persisted = deps.sessionStore.get(sessionId)
      if (persisted) {
        deps.sessionStore.upsert({ ...persisted, status: status as SessionStatus })
        persistedStatus.set(sessionId, status)
      }
    }
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
        const input = args[0] as { tid: string; title: string; prompt: string; repoId: string; description?: string }
        const { tid, title, prompt, repoId, description } = input

        const repo = await deps.repos.get(repoId)
        if (!repo) throw new Error(`Unknown repo: ${repoId}`)

        const branch = branchFor(tid, title)
        await deps.worktrees.create(repo, branch)
        const cwd = deps.worktrees.pathFor(repo, branch)

        let port: number | undefined
        try {
          port = await deps.ports.claim(cwd, 'web')
        } catch {
          port = undefined
        }

        const systemPrompt = buildSystemPrompt({ tid, title, description })

        const session = deps.sessions.start({
          tid,
          title,
          prompt,
          repo,
          branch,
          cwd,
          env: port !== undefined ? { PORT: String(port) } : undefined,
          systemPrompt,
        })

        sessionMeta.set(session.id, { repo, branch })
        deps.sessionStore.upsert({ ...session, port })
        persistedStatus.set(session.id, 'running')

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
        let meta = sessionMeta.get(id)
        if (!meta) {
          // Post-restart: try to reconstruct from sessionStore
          const persisted = deps.sessionStore.get(id)
          if (!persisted) return { removed: false, reason: 'session not found' }
          const repo = await deps.repos.get(persisted.repoId)
          if (!repo) return { removed: false, reason: 'session not found' }
          meta = { repo, branch: persisted.branch }
        }
        const result = await deps.worktrees.remove(meta.repo, meta.branch, opts)
        if (result.removed) {
          sessionMeta.delete(id)
          deps.sessionStore.delete(id)
          persistedStatus.delete(id)
        }
        return result
      }

      case IPC.listSessions:
        return deps.sessionStore.list()

      case IPC.resumeSession: {
        const id = args[0] as string
        if (deps.sessions.has(id)) {
          return deps.sessionStore.get(id) ?? { id, status: 'running' }
        }
        const persisted = deps.sessionStore.get(id)
        if (!persisted) throw new Error(`Session not found: ${id}`)
        const repo = await deps.repos.get(persisted.repoId)
        if (!repo) throw new Error(`Repo not found: ${persisted.repoId}`)
        const cwd = deps.worktrees.pathFor(repo, persisted.branch)
        let port: number | undefined
        try { port = await deps.ports.claim(cwd, 'web') } catch { port = undefined }
        const dto = deps.sessions.resume({ session: persisted, cwd, env: port !== undefined ? { PORT: String(port) } : undefined })
        sessionMeta.set(id, { repo, branch: persisted.branch })
        persistedStatus.set(id, 'running')
        deps.sessionStore.upsert({ ...dto, port })
        return { ...dto, port }
      }

      case IPC.attachRemoteControl: {
        const id = args[0] as string
        const persisted = deps.sessionStore.get(id)
        if (!persisted) throw new Error(`Session not found: ${id}`)
        const repo = await deps.repos.get(persisted.repoId)
        if (!repo) throw new Error(`Repo not found: ${persisted.repoId}`)
        const cwd = deps.worktrees.pathFor(repo, persisted.branch)
        let port: number | undefined
        try { port = await deps.ports.claim(cwd, 'web') } catch { port = undefined }
        const dto = deps.sessions.attachRemoteControl({ session: persisted, cwd, env: port !== undefined ? { PORT: String(port) } : undefined })
        sessionMeta.set(id, { repo, branch: persisted.branch })
        persistedStatus.set(id, 'running')
        deps.sessionStore.upsert({ ...dto, port })
        return { ...dto, port }
      }

      case IPC.getSessionBuffer:
        return deps.sessions.getBuffer(args[0] as string)

      case IPC.getLinearKey:
        return deps.config.get('linear.apiKey') ?? null

      case IPC.setLinearKey:
        deps.config.set('linear.apiKey', args[0] as string)
        return undefined

      case IPC.listTicketTeams:
        return deps.tickets.listTeams()

      case IPC.createTicket:
        return deps.tickets.createTicket(args[0] as CreateTicketInput)

      case IPC.getTicketStatus:
        return deps.tickets.getTicketStatus(args[0] as string)

      case IPC.setTicketStatus:
        return deps.tickets.setTicketStatus(args[0] as string, args[1] as string)

      case IPC.pickRepo:
        throw new Error('pickRepo is not supported without a desktop window')

      default:
        throw new Error(`Unknown channel: ${channel}`)
    }
  }

  function dispose(): void {
    deps.sessions.off('data', onData)
    deps.sessions.off('status', onStatus)
  }

  return { handle, dispose }
}

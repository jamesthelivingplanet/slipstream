import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { IpcDeps } from '../ipc.js'
import { IPC } from '../shared/contract.js'
import type {
  BackendKind,
  RepoDTO,
  SessionDTO,
  Identity,
  EditorConfig,
  RepoSettings,
  NotifyPrefs,
  PushSubscriptionDTO,
  WriteLockState,
  GcPolicy,
  TicketSource,
} from '../shared/contract.js'
import { branchFor } from '../shared/branch.js'
import { buildSystemPrompt } from '../shared/promptComposer.js'
import { captureOpencodeSessionId } from '../services/opencodeSessions.js'
import { LOCAL_IDENTITY } from './auth.js'
import {
  buildAppMcpConfig,
  buildOpencodeMcpConfig,
  writeAppMcpConfig,
} from '../services/mcpConfig.js'
import { readGcPolicy, writeGcPolicy } from '../services/sessionReaper.js'
import { checkAppMcp, lastMcpActivity } from '../services/mcpHealth.js'
import { diagnoseRepos, realRepoProbes } from '../services/diagnostics.js'
import { findOnPath, binForKind } from '../services/cliProbe.js'

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
  opts: { coalesceMs?: number; identity?: Identity; clientId?: string } = {},
): Rpc {
  const coalesceMs = opts.coalesceMs ?? 40
  const identity = opts.identity ?? LOCAL_IDENTITY
  const clientId = opts.clientId ?? randomUUID()
  const coord = deps.writeCoordinator

  function lockState(id: string): WriteLockState {
    if (!coord) return { sessionId: id, canWrite: true, viewers: 1 }
    return { sessionId: id, canWrite: coord.canWrite(id, clientId), viewers: coord.viewers(id) }
  }
  // Owner filter — a no-op in the single-user tier (every row is 'local').
  // The seam scopes all reads so a future multi-user tier isolates owners.
  const ownedByCaller = (row: { ownerId?: string }): boolean =>
    (row.ownerId ?? 'local') === identity.id

  // Treat a persisted session as owned-or-absent: callers may only act on
  // sessions they own. Returns undefined for missing OR other-owner rows so
  // handlers surface an identical "not found" to both — no existence leak.
  function ownedSession(id: string): SessionDTO | undefined {
    const s = deps.sessionStore.get(id)
    return s && ownedByCaller(s) ? s : undefined
  }

  // Resolve a repo the caller owns, or throw the same "Unknown repo" error
  // used for a missing repo (no existence leak across owners).
  async function requireOwnedRepo(repoId: string): Promise<RepoDTO> {
    const repo = await deps.repos.get(repoId)
    if (!repo || !ownedByCaller(repo)) throw new Error(`Unknown repo: ${repoId}`)
    return repo
  }

  // Tracks which repo+branch each session owns so cleanup can remove the worktree.
  const sessionMeta = new Map<string, { repo: RepoDTO; branch: string }>()

  // Per-session output coalescing: batch session:data bursts and flush on a
  // short timer so a chatty PTY doesn't flood the transport with one message
  // per chunk. Status events are never coalesced.
  const pendingData = new Map<string, { parts: string[]; seq: number }>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  function flushData(): void {
    flushTimer = null
    for (const [id, entry] of pendingData) {
      if (entry.parts.length > 0) {
        emit(IPC.sessionData, id, entry.parts.join(''), entry.seq)
      }
    }
    pendingData.clear()
  }

  function onData(sessionId: string, chunk: string, seq: number): void {
    const cur = pendingData.get(sessionId)
    if (cur) {
      cur.parts.push(chunk)
      cur.seq = seq
    } else {
      pendingData.set(sessionId, { parts: [chunk], seq })
    }
    if (coalesceMs <= 0) {
      flushData()
    } else if (!flushTimer) {
      flushTimer = setTimeout(flushData, coalesceMs)
    }
  }
  function onStatus(sessionId: string, status: string): void {
    emit(IPC.sessionStatus, sessionId, status)
  }

  function onPr(id: string, url: string): void {
    emit(IPC.sessionPr, id, url)
  }

  deps.sessions.on('data', onData)
  deps.sessions.on('status', onStatus)
  deps.sessions.on('pr', onPr)

  function onLockChange(sessionId: string): void {
    if (!coord!.isViewer(sessionId, clientId)) return
    emit(IPC.sessionWriteLock, lockState(sessionId))
  }
  if (coord) coord.on('change', onLockChange)

  async function handle(channel: string, args: unknown[]): Promise<unknown> {
    switch (channel) {
      case IPC.listRepos:
        return (await deps.repos.list()).filter(ownedByCaller)

      case IPC.registerRepo:
        return deps.repos.register(args[0] as string, identity.id)

      case IPC.registerRepoByUrl:
        return deps.repos.registerByUrl(args[0] as string, identity.id)

      case IPC.removeRepo: {
        const id = args[0] as string
        await requireOwnedRepo(id)
        return deps.repos.remove(id)
      }

      case IPC.listTickets:
        return deps.tickets.listTickets()

      case IPC.startSession: {
        const input = args[0] as {
          tid: string
          title: string
          prompt: string
          repoId: string
          description?: string
          agentKind?: BackendKind
          sessionId?: string
          src?: TicketSource
        }
        const { tid, title, prompt, repoId, description } = input
        const agentKind = input.agentKind

        const repo = await deps.repos.resolvePath(repoId)
        if (!ownedByCaller(repo)) throw new Error(`Unknown repo: ${repoId}`)

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

        let opencodePort: number | undefined
        if (agentKind === 'opencode') {
          try {
            opencodePort = await deps.ports.claim(cwd, 'opencode')
          } catch {
            opencodePort = undefined
          }
        }

        const sessionId = input.sessionId ?? randomUUID()
        let mcpConfigPath: string | undefined
        const startEnv: Record<string, string> = {}
        if (port !== undefined) startEnv.PORT = String(port)
        if (deps.appMcp) {
          mcpConfigPath = path.join(deps.appMcp.configDir, `${sessionId}.json`)
          const config = buildAppMcpConfig({
            appMcpJsPath: deps.appMcp.appMcpJsPath,
            electronPath: deps.appMcp.electronPath,
            dataDir: deps.appMcp.dataDir,
            sessionId,
            base: repo.base,
            branch,
          })
          await writeAppMcpConfig(mcpConfigPath, config)

          if (agentKind === 'opencode') {
            startEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify(
              buildOpencodeMcpConfig({
                appMcpJsPath: deps.appMcp.appMcpJsPath,
                electronPath: deps.appMcp.electronPath,
                dataDir: deps.appMcp.dataDir,
                sessionId,
                base: repo.base,
                branch,
              }),
            )
          }
        }

        const startedAt = Date.now()
        const session = deps.sessions.start({
          tid,
          title,
          prompt,
          repo,
          branch,
          cwd,
          env: Object.keys(startEnv).length > 0 ? startEnv : undefined,
          systemPrompt,
          agentKind,
          opencodePort,
          sessionId,
          mcpConfigPath,
          src: input.src,
        })

        sessionMeta.set(session.id, { repo, branch })
        deps.sessionStore.upsert({
          ...session,
          port,
          agentKind: agentKind ?? 'claude-code',
          ownerId: identity.id,
        })

        if (agentKind === 'opencode' && opencodePort) {
          void captureOpencodeSessionId(opencodePort, startedAt - 1000).then((sid) => {
            if (!sid) return
            deps.sessions.setOpencodeSid(session.id, sid)
            const cur = deps.sessionStore.get(session.id)
            if (cur) deps.sessionStore.upsert({ ...cur, opencodeSid: sid })
          })
        }

        // FLO-26: move the linked ticket to the provider's "In Progress" state
        // when the agent starts. Best-effort — a ticket-API failure must not
        // break the agent launch. Follow-up: handle stop/complete/error
        // transitions (out of scope for FLO-26).
        try {
          await deps.tickets.startTicket(tid)
        } catch {
          // ignore: ticket provider unavailable or transition not applicable
        }

        return { ...session, port }
      }

      case IPC.writeSession: {
        const id = args[0] as string
        if (!ownedSession(id)) return undefined
        if (coord && !coord.noteWrite(id, clientId)) return undefined
        deps.sessions.write(id, args[1] as string)
        return undefined
      }

      case IPC.resizeSession: {
        const id = args[0] as string
        if (!ownedSession(id)) return undefined
        if (coord && !coord.canWrite(id, clientId)) return undefined
        deps.sessions.resize(id, args[1] as number, args[2] as number)
        return undefined
      }

      case IPC.attachSession: {
        const id = args[0] as string
        if (!ownedSession(id)) return lockState(id)
        coord?.attach(id, clientId)
        return lockState(id)
      }

      case IPC.detachSession: {
        const id = args[0] as string
        if (!ownedSession(id)) return undefined
        coord?.detach(id, clientId)
        return undefined
      }

      case IPC.takeWrite: {
        const id = args[0] as string
        if (!ownedSession(id)) return lockState(id)
        coord?.take(id, clientId)
        return lockState(id)
      }

      case IPC.killSession: {
        const id = args[0] as string
        if (!ownedSession(id)) return undefined
        deps.sessions.kill(id)
        return undefined
      }

      case IPC.cleanupSession: {
        const id = args[0] as string
        const opts = args[1] as { force?: boolean } | undefined
        const persisted = ownedSession(id)
        let meta = sessionMeta.get(id)
        if (!meta) {
          // Post-restart: try to reconstruct from sessionStore
          if (!persisted) return { removed: false, reason: 'session not found' }
          const repo = await deps.repos.get(persisted.repoId)
          if (!repo) return { removed: false, reason: 'session not found' }
          meta = { repo, branch: persisted.branch }
        }
        const result = await deps.worktrees.remove(meta.repo, meta.branch, opts)
        if (result.removed) {
          sessionMeta.delete(id)
          deps.sessionStore.delete(id)

          // FLO-35: move the linked ticket back to "To Do" when the agent run
          // is deleted, so the next agent can pick it up. Best-effort — a
          // ticket-API failure must not break the cleanup.
          const tid = persisted?.tid
          if (tid) {
            try {
              await deps.tickets.resetTicket(tid)
            } catch {
              // ignore: ticket provider unavailable or transition not applicable
            }
          }
        }
        return result
      }

      case IPC.listSessions:
        return deps.sessionStore.list().filter(ownedByCaller)

      case IPC.resumeSession: {
        const id = args[0] as string
        const owned = ownedSession(id)
        if (deps.sessions.has(id) && owned) {
          return owned
        }
        const persisted = owned
        if (!persisted) throw new Error(`Session not found: ${id}`)
        const repo = await deps.repos.resolvePath(persisted.repoId)
        const cwd = deps.worktrees.pathFor(repo, persisted.branch)
        let port: number | undefined
        try {
          port = await deps.ports.claim(cwd, 'web')
        } catch {
          port = undefined
        }
        let opencodePort: number | undefined
        if (persisted.agentKind === 'opencode') {
          try {
            opencodePort = await deps.ports.claim(cwd, 'opencode')
          } catch {
            opencodePort = undefined
          }
        }
        const resumeEnv: Record<string, string> = {}
        if (port !== undefined) resumeEnv.PORT = String(port)
        if (persisted.agentKind === 'opencode' && deps.appMcp) {
          resumeEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify(
            buildOpencodeMcpConfig({
              appMcpJsPath: deps.appMcp.appMcpJsPath,
              electronPath: deps.appMcp.electronPath,
              dataDir: deps.appMcp.dataDir,
              sessionId: id,
              base: repo.base,
              branch: persisted.branch,
            }),
          )
        }
        const dto = deps.sessions.resume({
          session: persisted,
          cwd,
          env: Object.keys(resumeEnv).length > 0 ? resumeEnv : undefined,
          opencodePort,
        })
        sessionMeta.set(id, { repo, branch: persisted.branch })
        deps.sessionStore.upsert({ ...dto, port })
        return { ...dto, port }
      }

      case IPC.attachRemoteControl: {
        const id = args[0] as string
        const persisted = ownedSession(id)
        if (!persisted) throw new Error(`Session not found: ${id}`)
        const repo = await deps.repos.resolvePath(persisted.repoId)
        const cwd = deps.worktrees.pathFor(repo, persisted.branch)
        let port: number | undefined
        try {
          port = await deps.ports.claim(cwd, 'web')
        } catch {
          port = undefined
        }
        let opencodePort: number | undefined
        if (persisted.agentKind === 'opencode') {
          try {
            opencodePort = await deps.ports.claim(cwd, 'opencode')
          } catch {
            opencodePort = undefined
          }
        }
        const remoteEnv: Record<string, string> = {}
        if (port !== undefined) remoteEnv.PORT = String(port)
        if (persisted.agentKind === 'opencode' && deps.appMcp) {
          remoteEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify(
            buildOpencodeMcpConfig({
              appMcpJsPath: deps.appMcp.appMcpJsPath,
              electronPath: deps.appMcp.electronPath,
              dataDir: deps.appMcp.dataDir,
              sessionId: id,
              base: repo.base,
              branch: persisted.branch,
            }),
          )
        }
        const dto = deps.sessions.attachRemoteControl({
          session: persisted,
          cwd,
          env: Object.keys(remoteEnv).length > 0 ? remoteEnv : undefined,
          opencodePort,
        })
        sessionMeta.set(id, { repo, branch: persisted.branch })
        deps.sessionStore.upsert({ ...dto, port })
        return { ...dto, port }
      }

      case IPC.getSessionBuffer: {
        const id = args[0] as string
        if (!ownedSession(id)) throw new Error(`Session not found: ${id}`)
        return deps.sessions.getBuffer(id)
      }

      case IPC.worktreeStatus: {
        const repoId = args[0] as string
        const branch = args[1] as string
        const repo = await requireOwnedRepo(repoId)
        return deps.worktrees.status(repo, branch)
      }

      case IPC.getLinearKey:
        return deps.config.get('linear.apiKey') ?? null

      case IPC.setLinearKey:
        deps.config.set('linear.apiKey', args[0] as string)
        return undefined

      case IPC.getTicketStatus:
        return deps.tickets.getTicketStatus(args[0] as string)

      case IPC.setTicketStatus:
        return deps.tickets.setTicketStatus(args[0] as string, args[1] as string)

      case IPC.getEditorConfig:
        return {
          command: deps.config.get('editor.command') ?? 'code',
          mobileCommand: deps.config.get('editor.mobileCommand') ?? '',
        }

      case IPC.setEditorConfig: {
        const cfg = args[0] as EditorConfig
        deps.config.set('editor.command', cfg.command ?? '')
        deps.config.set('editor.mobileCommand', cfg.mobileCommand ?? '')
        return undefined
      }

      case IPC.openInEditor: {
        const input = args[0] as { repoId: string; branch: string; mobile?: boolean }
        const repo = await requireOwnedRepo(input.repoId)
        const cwd = deps.worktrees.pathFor(repo, input.branch)
        const desktop = deps.config.get('editor.command') ?? 'code'
        const mobileCmd = (deps.config.get('editor.mobileCommand') ?? '').trim()
        const command = input.mobile && mobileCmd ? mobileCmd : desktop
        if (!command.trim())
          throw new Error('No editor configured. Set one in Settings → Behavior.')
        await deps.editor.open(command, cwd)
        return undefined
      }

      case IPC.getRepoSettings: {
        const id = args[0] as string
        await requireOwnedRepo(id)
        return deps.repos.getSettings(id)
      }

      case IPC.setRepoSettings: {
        const id = args[0] as string
        await requireOwnedRepo(id)
        return deps.repos.setSettings(id, args[1] as RepoSettings)
      }

      case IPC.runApp: {
        const { repoId, branch } = args[0] as { repoId: string; branch: string }
        const repo = await requireOwnedRepo(repoId)
        const settings = await deps.repos.getSettings(repoId)
        if (!settings.startCmd.trim()) return { started: false, reason: 'no-start-command' }
        const cwd = deps.worktrees.pathFor(repo, branch)
        const key = `${repoId} ${branch}`
        let port: number | undefined
        try {
          port = await deps.ports.claim(cwd, 'web')
        } catch {
          port = undefined
        }
        const { pid, reused } = await deps.appRunner.run(
          key,
          cwd,
          settings.startCmd,
          port !== undefined ? { PORT: String(port) } : undefined,
        )
        return { started: true, port, pid, reused }
      }

      case IPC.stopApp: {
        const { repoId, branch } = args[0] as { repoId: string; branch: string }
        await requireOwnedRepo(repoId)
        const key = `${repoId} ${branch}`
        const stopped = await deps.appRunner.stop(key)
        return { stopped }
      }

      case IPC.appStatus: {
        const { repoId, branch } = args[0] as { repoId: string; branch: string }
        await requireOwnedRepo(repoId)
        const key = `${repoId} ${branch}`
        return { running: deps.appRunner.isRunning(key) }
      }

      case IPC.getVapidPublicKey:
        return deps.push.getVapidPublicKey()

      case IPC.savePushSubscription:
        return deps.push.savePushSubscription(
          args[0] as PushSubscriptionDTO,
          args[1] as NotifyPrefs,
        )

      case IPC.deletePushSubscription:
        return deps.push.deletePushSubscription(args[0] as string)

      case IPC.getPushPrefs:
        return deps.push.getPushPrefs(args[0] as string)

      case IPC.getGitToken: {
        const host = args[0] as string
        if (host !== 'github' && host !== 'gitlab') throw new Error(`Invalid host: ${host}`)
        return deps.config.get(`${host}.token`) ?? null
      }

      case IPC.setGitToken: {
        const host = args[0] as string
        if (host !== 'github' && host !== 'gitlab') throw new Error(`Invalid host: ${host}`)
        deps.config.set(`${host}.token`, args[1] as string)
        return undefined
      }

      case IPC.getGcPolicy:
        return readGcPolicy(deps.config)

      case IPC.setGcPolicy:
        writeGcPolicy(deps.config, args[0] as GcPolicy)
        return undefined

      case IPC.getMcpStatus: {
        if (!deps.appMcp)
          return { up: false, tools: [], checkedAt: Date.now(), error: 'MCP not configured' }
        const res = await checkAppMcp({
          electronPath: deps.appMcp.electronPath,
          appMcpJsPath: deps.appMcp.appMcpJsPath,
          dataDir: deps.appMcp.dataDir,
        })
        const lastActivityAt = await lastMcpActivity(deps.appMcp.dataDir)
        return { ...res, checkedAt: Date.now(), lastActivityAt }
      }

      case IPC.getDiagnostics: {
        const port = Number(process.env.SLIPSTREAM_PORT) || undefined
        const bind = process.env.SLIPSTREAM_BIND ?? '127.0.0.1'
        const dataDir = deps.appMcp?.dataDir ?? ''
        const repos = (await deps.repos.list()).filter(ownedByCaller)
        return {
          daemon: {
            wsUrl: `ws://${bind}:${port}/rpc`,
            httpBase: `http://${bind}:${port}`,
            port,
            pid: process.pid,
            mode: process.env.SLIPSTREAM_DAEMON_URL ? 'remote' : 'local',
            dataDir,
            dbPath: dataDir ? path.join(dataDir, 'slipstream.db') : '',
          },
          versions: {
            node: process.versions.node,
            electron: process.versions.electron,
            v8: process.versions.v8,
            chrome: process.versions.chrome,
          },
          repos: diagnoseRepos(repos, realRepoProbes),
        }
      }

      case IPC.checkAgentCli: {
        const kind = args[0] as BackendKind
        const bin = binForKind(kind)
        const found = findOnPath(bin)
        return { kind, bin, found: found !== null, path: found ?? undefined }
      }

      case IPC.pickRepo:
        throw new Error('pickRepo is not supported without a desktop window')

      default:
        throw new Error(`Unknown channel: ${channel}`)
    }
  }

  function dispose(): void {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    pendingData.clear()
    deps.sessions.off('data', onData)
    deps.sessions.off('status', onStatus)
    deps.sessions.off('pr', onPr)
    if (coord) {
      coord.dropClient(clientId)
      coord.off('change', onLockChange)
    }
  }

  return { handle, dispose }
}

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { IpcDeps } from '../ipc.js'
import { IPC, BACKEND_KINDS } from '../shared/contract.js'
import type {
  BackendKind,
  RepoDTO,
  SessionDTO,
  SessionHistoryEntry,
  SessionOutcomeDTO,
  Identity,
  EditorConfig,
  RepoSettings,
  NotifyPrefs,
  PushSubscriptionDTO,
  WriteLockState,
  GcPolicy,
  SchedulerPolicy,
  TicketSource,
  TicketSourceSettings,
  PromptTemplateDTO,
  WorktreeUpdateMode,
} from '../shared/contract.js'
import { branchFor } from '../shared/branch.js'
import { buildSystemPrompt, buildHandoffPrompt, AGENT_LABELS } from '../shared/promptComposer.js'
import { LOCAL_IDENTITY } from './auth.js'
import { agentSessionEnv } from '../services/agentCliProvision.js'
import { captureOpencodeSessionId } from '../services/opencodeSessions.js'
import { usesEmbeddedServer, KILO_BIN } from '../services/agentBackend.js'
import { readGcPolicy, writeGcPolicy } from '../services/sessionReaper.js'
import { launchSession } from '../services/sessionLauncher.js'
import type { LaunchRequest } from '../services/sessionLauncher.js'
import { readSchedulerPolicy, writeSchedulerPolicy } from '../services/sessionScheduler.js'
import { checkSlipstreamCli, lastCliActivity } from '../services/cliHealth.js'
import { diagnoseRepos, realRepoProbes } from '../services/diagnostics.js'
import { findAgentCli, binForKind } from '../services/cliProbe.js'
import { readSessionUsage, buildUsageSummary } from '../services/usage.js'
import { parseOutcomeSentinel, OUTCOME_SENTINEL_FILE } from '../services/outcomeSentinel.js'

function parseCsv(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
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

  // Resolve a session's structured outcome: prefer the durable store, but
  // fall back to reading the outcome.json sentinel straight off disk. A
  // daemon restart can race the sessionManager's fs.watch — the watcher only
  // starts once a session is live again — so a session that finished and
  // wrote its sentinel while the daemon was down (or between restart and
  // resume) would otherwise appear to have no outcome even though the agent
  // reported one. On a successful disk read, backfill the store so future
  // reads don't need the fallback.
  async function resolveOutcome(sessionId: string): Promise<SessionOutcomeDTO | null> {
    const stored = deps.outcomeStore.get(sessionId)
    if (stored) return stored
    if (!deps.agentCli) return null
    try {
      const filePath = path.join(
        deps.agentCli.dataDir,
        'sessions',
        sessionId,
        OUTCOME_SENTINEL_FILE,
      )
      const content = await fs.promises.readFile(filePath, 'utf8')
      const parsed = parseOutcomeSentinel(content)
      if (!parsed) return null
      const outcome: SessionOutcomeDTO = {
        sessionId,
        result: parsed.result,
        summary: parsed.summary,
        details: parsed.details,
        reportedAt: parsed.ts,
      }
      deps.outcomeStore.upsert(outcome)
      return outcome
    } catch {
      return null
    }
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

  function onExit(id: string, code: number): void {
    emit(IPC.sessionExit, id, code)
  }

  function onAgentEvent(_id: string, event: import('../shared/contract.js').SessionAgentEventDTO) {
    emit(IPC.sessionAgentEvent, event)
  }

  deps.sessions.on('data', onData)
  deps.sessions.on('status', onStatus)
  deps.sessions.on('pr', onPr)
  deps.sessions.on('exit', onExit)
  deps.sessions.on('agentEvent', onAgentEvent)

  function onLockChange(sessionId: string): void {
    if (!coord!.isViewer(sessionId, clientId)) return
    emit(IPC.sessionWriteLock, lockState(sessionId))
  }
  if (coord) coord.on('change', onLockChange)

  async function handle(channel: string, args: unknown[]): Promise<unknown> {
    // Resolves a session's worktree cwd (needed for pi's usage reader, which
    // is keyed on cwd rather than a captured transcript/session id). Fresh
    // per-call repo cache so a batch (usageSummary/listSessionHistory) only
    // resolves each repo once. Never throws — usage reads must not fail a
    // listing just because a repo/worktree can't be resolved right now.
    const repoCache = new Map<string, RepoDTO>()
    async function cwdForSession(s: SessionDTO): Promise<string | null> {
      try {
        let repo = repoCache.get(s.repoId)
        if (!repo) {
          repo = await deps.repos.resolvePath(s.repoId)
          repoCache.set(s.repoId, repo)
        }
        return deps.worktrees.pathFor(repo, s.branch)
      } catch {
        return null
      }
    }

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
        const systemPrompt = buildSystemPrompt({ tid, title, description })

        // FLO-95: the actual worktree/port/PTY launch procedure lives in
        // sessionLauncher.ts so it can run immediately (below the concurrency
        // cap) or later from the scheduler's queue drain. The system prompt is
        // built once here (not in the launcher) and carried on the request so
        // a queued start launches with exactly what was requested.
        const req: LaunchRequest = {
          sessionId: input.sessionId ?? randomUUID(),
          tid,
          title,
          prompt,
          repoId,
          branch,
          systemPrompt,
          agentKind,
          src: input.src,
          ownerId: identity.id,
        }

        const session = deps.scheduler
          ? await deps.scheduler.submit(req)
          : await launchSession(deps, req)

        sessionMeta.set(session.id, { repo, branch })
        return session
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
        // A queued (not-yet-spawned) session has no PTY to kill — cancel it
        // out of the scheduler's queue instead, and record it the same way a
        // kill of a live session would (interrupted: resumable/cleanable).
        if (deps.scheduler?.cancel(id)) {
          const persisted = deps.sessionStore.get(id)
          if (persisted) deps.sessionStore.upsert({ ...persisted, status: 'interrupted' })
          return undefined
        }
        deps.sessions.kill(id)
        return undefined
      }

      case IPC.cleanupSession: {
        const id = args[0] as string
        const opts = args[1] as { force?: boolean } | undefined
        // Cancel first: a queued entry must not be able to launch after its
        // store row is deleted below. (The drain's stale-row guard is the
        // backstop if this races anyway.)
        deps.scheduler?.cancel(id)
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
              await deps.tickets.resetTicket(tid, persisted?.src)
            } catch {
              // ignore: ticket provider unavailable or transition not applicable
            }
          }
        }
        return result
      }

      case IPC.sessionMerged: {
        const id = args[0] as string
        const persisted = ownedSession(id)
        if (!persisted) return { merged: false }
        const repo = await deps.repos.get(persisted.repoId)
        if (!repo) return { merged: false }
        const probe = await deps.worktrees.isMerged(repo, persisted.branch)
        if (probe.merged) return { merged: true, via: probe.via }
        // Rebase/fast-forward merges leave no merge commit and put the branch's
        // original SHAs on base (ahead === 0) — indistinguishable from a fresh
        // branch by git alone, so require the session's recorded PR as evidence.
        if (probe.ahead === 0 && persisted.prUrl) return { merged: true, via: 'pr' }
        return { merged: false }
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
        // A queued session hasn't been spawned yet — the scheduler owns when
        // it launches (spawning it here would let a viewer jump the queue).
        if (persisted.status === 'queued') return persisted
        const repo = await deps.repos.resolvePath(persisted.repoId)
        const cwd = deps.worktrees.pathFor(repo, persisted.branch)
        let port: number | undefined
        try {
          port = await deps.ports.claim(cwd, 'web')
        } catch {
          port = undefined
        }
        let opencodePort: number | undefined
        if (usesEmbeddedServer(persisted.agentKind)) {
          try {
            opencodePort = await deps.ports.claim(cwd, persisted.agentKind ?? 'claude-code')
          } catch {
            opencodePort = undefined
          }
        }
        const dto = deps.sessions.resume({
          session: persisted,
          cwd,
          env: agentSessionEnv(deps.agentCli, {
            sessionId: id,
            base: repo.base,
            branch: persisted.branch,
            port,
          }),
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
        // A queued session hasn't been spawned yet — the scheduler owns when
        // it launches (spawning it here would let a viewer jump the queue).
        if (persisted.status === 'queued') return persisted
        const repo = await deps.repos.resolvePath(persisted.repoId)
        const cwd = deps.worktrees.pathFor(repo, persisted.branch)
        let port: number | undefined
        try {
          port = await deps.ports.claim(cwd, 'web')
        } catch {
          port = undefined
        }
        let opencodePort: number | undefined
        if (usesEmbeddedServer(persisted.agentKind)) {
          try {
            opencodePort = await deps.ports.claim(cwd, persisted.agentKind ?? 'claude-code')
          } catch {
            opencodePort = undefined
          }
        }
        const dto = deps.sessions.attachRemoteControl({
          session: persisted,
          cwd,
          env: agentSessionEnv(deps.agentCli, {
            sessionId: id,
            base: repo.base,
            branch: persisted.branch,
            port,
          }),
          opencodePort,
        })
        sessionMeta.set(id, { repo, branch: persisted.branch })
        deps.sessionStore.upsert({ ...dto, port })
        return { ...dto, port }
      }

      case IPC.handoffSession: {
        const id = args[0] as string
        const agentKind = args[1] as BackendKind
        if (!BACKEND_KINDS.includes(agentKind))
          throw new Error(`Unknown agent kind: ${String(agentKind)}`)
        const persisted = ownedSession(id)
        if (!persisted) throw new Error(`Session not found: ${id}`)
        // A queued session hasn't started — there is nothing to hand off yet.
        if (persisted.status === 'queued')
          throw new Error('Session is queued — it has not started yet')
        const fromKind: BackendKind = persisted.agentKind ?? 'claude-code'
        if (fromKind === agentKind)
          throw new Error(`Session is already running on ${AGENT_LABELS[agentKind]}`)
        const repo = await deps.repos.resolvePath(persisted.repoId)
        const cwd = deps.worktrees.pathFor(repo, persisted.branch)
        let port: number | undefined
        try {
          port = await deps.ports.claim(cwd, 'web')
        } catch {
          port = undefined
        }
        let opencodePort: number | undefined
        if (usesEmbeddedServer(agentKind)) {
          try {
            opencodePort = await deps.ports.claim(cwd, agentKind)
          } catch {
            opencodePort = undefined
          }
        }
        const outcome = await resolveOutcome(id)
        const handoffPrompt = buildHandoffPrompt({
          tid: persisted.tid,
          title: persisted.title,
          prompt: persisted.prompt,
          fromAgent: AGENT_LABELS[fromKind],
          branch: persisted.branch,
          base: repo.base,
          outcomeSummary: outcome?.summary,
        })
        const dto = deps.sessions.handoff({
          session: persisted,
          cwd,
          env: agentSessionEnv(deps.agentCli, {
            sessionId: id,
            base: repo.base,
            branch: persisted.branch,
            port,
          }),
          opencodePort,
          agentKind,
          handoffPrompt,
        })
        // Same async sid capture as sessionLauncher.ts: the embedded-server
        // session id only exists after the TUI boots; status polling starts
        // once it's known.
        if (usesEmbeddedServer(agentKind)) {
          void captureOpencodeSessionId({
            cwd,
            bin: agentKind === 'kilo' ? KILO_BIN : undefined,
          }).then((sid) => {
            if (!sid) return
            deps.sessions.setOpencodeSid(id, sid)
            const cur = deps.sessionStore.get(id)
            if (cur) deps.sessionStore.upsert({ ...cur, opencodeSid: sid })
          })
        }
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

      case IPC.worktreeDiff: {
        const repoId = args[0] as string
        const branch = args[1] as string
        const repo = await requireOwnedRepo(repoId)
        return deps.worktrees.diff(repo, branch)
      }

      case IPC.worktreeUpdateFromBase: {
        const repoId = args[0] as string
        const branch = args[1] as string
        const mode = args[2] as WorktreeUpdateMode
        const repo = await requireOwnedRepo(repoId)
        return deps.worktrees.updateFromBase(repo, branch, { mode })
      }

      case IPC.getLinearKey:
        return deps.config.get('linear.apiKey') ?? null

      case IPC.setLinearKey:
        deps.config.set('linear.apiKey', args[0] as string)
        return undefined

      case IPC.getTicketStatus:
        return deps.tickets.getTicketStatus(args[0] as string, args[1] as TicketSource | undefined)

      case IPC.setTicketStatus:
        return deps.tickets.setTicketStatus(
          args[0] as string,
          args[1] as string,
          args[2] as TicketSource | undefined,
        )

      case IPC.getTicketSettings: {
        const src = args[0] as TicketSource
        if (src === 'linear') {
          const apiKey = deps.config.get('linear.apiKey') ?? ''
          return {
            configured: !!apiKey,
            scopeKeys: parseCsv(deps.config.get('linear.teamKeys')),
            onlyMine: deps.config.get('linear.onlyMine') !== '0',
            apiKey,
            baseUrl: '',
            email: '',
            apiToken: '',
          } satisfies TicketSourceSettings
        }
        if (src === 'jira') {
          const baseUrl = deps.config.get('jira.baseUrl') ?? ''
          const email = deps.config.get('jira.email') ?? ''
          const apiToken = deps.config.get('jira.apiToken') ?? ''
          return {
            configured: !!baseUrl && !!email && !!apiToken,
            scopeKeys: parseCsv(deps.config.get('jira.projectKeys')),
            onlyMine: deps.config.get('jira.onlyMine') !== '0',
            apiKey: '',
            baseUrl,
            email,
            apiToken,
          } satisfies TicketSourceSettings
        }
        throw new Error(`Unknown ticket source: ${src}`)
      }

      case IPC.setTicketSettings: {
        const src = args[0] as TicketSource
        const cfg = args[1] as TicketSourceSettings
        if (src === 'linear') {
          deps.config.set('linear.apiKey', cfg.apiKey ?? '')
          deps.config.set('linear.teamKeys', (cfg.scopeKeys ?? []).join(','))
          deps.config.set('linear.onlyMine', cfg.onlyMine === false ? '0' : '1')
          return undefined
        }
        if (src === 'jira') {
          deps.config.set('jira.baseUrl', cfg.baseUrl ?? '')
          deps.config.set('jira.email', cfg.email ?? '')
          deps.config.set('jira.apiToken', cfg.apiToken ?? '')
          deps.config.set('jira.projectKeys', (cfg.scopeKeys ?? []).join(','))
          deps.config.set('jira.onlyMine', cfg.onlyMine === false ? '0' : '1')
          return undefined
        }
        throw new Error(`Unknown ticket source: ${src}`)
      }

      case IPC.listTicketScopes: {
        const src = args[0] as TicketSource
        const provider = deps.ticketProviders?.[src]
        if (!provider) throw new Error(`Unknown ticket source: ${src}`)
        if (!provider.listScopes) throw new Error('Scope listing not supported')
        return provider.listScopes()
      }

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
        // When this machine is on a tailnet (i.e. Slipstream itself is being
        // reached over Tailscale), mirror the app there too. Best-effort: a
        // failed/unavailable expose must not fail the run.
        let url: string | undefined
        if (port !== undefined && deps.tailscale) {
          try {
            url = (await deps.tailscale.expose(key, port)) ?? undefined
          } catch {
            url = undefined
          }
        }
        return { started: true, port, pid, reused, url }
      }

      case IPC.stopApp: {
        const { repoId, branch } = args[0] as { repoId: string; branch: string }
        await requireOwnedRepo(repoId)
        const key = `${repoId} ${branch}`
        const stopped = await deps.appRunner.stop(key)
        try {
          await deps.tailscale?.unexpose(key)
        } catch {
          // best effort — the serve mount is cheap to leave behind
        }
        return { stopped }
      }

      case IPC.appStatus: {
        const { repoId, branch } = args[0] as { repoId: string; branch: string }
        await requireOwnedRepo(repoId)
        const key = `${repoId} ${branch}`
        const running = deps.appRunner.isRunning(key)
        return { running, url: running ? (deps.tailscale?.urlFor(key) ?? undefined) : undefined }
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

      case IPC.getSchedulerPolicy:
        return readSchedulerPolicy(deps.config)

      case IPC.setSchedulerPolicy:
        writeSchedulerPolicy(deps.config, args[0] as SchedulerPolicy)
        void deps.scheduler?.drain() // raising the cap frees slots immediately
        return undefined

      case IPC.getCliStatus: {
        if (!deps.agentCli)
          return { up: false, commands: [], checkedAt: Date.now(), error: 'CLI not configured' }
        const res = await checkSlipstreamCli({
          electronPath: deps.agentCli.electronPath,
          cliJsPath: deps.agentCli.cliJsPath,
          dataDir: deps.agentCli.dataDir,
        })
        const lastActivityAt = await lastCliActivity(deps.agentCli.dataDir)
        return { ...res, checkedAt: Date.now(), lastActivityAt }
      }

      case IPC.getDiagnostics: {
        const port = Number(process.env.SLIPSTREAM_PORT) || undefined
        const bind = process.env.SLIPSTREAM_BIND ?? '127.0.0.1'
        const dataDir = deps.agentCli?.dataDir ?? ''
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
        const found = findAgentCli(kind)
        return { kind, bin, found: found !== null, path: found ?? undefined }
      }

      case IPC.sessionUsage: {
        const id = args[0] as string
        // Owner-scoped: a missing OR other-owner session surfaces the same
        // "not found" so usage can't leak across owners.
        const session = ownedSession(id)
        if (!session) throw new Error(`Session not found: ${id}`)
        const cwd = session.agentKind === 'pi' ? await cwdForSession(session) : null
        return readSessionUsage(session, { cwd })
      }

      case IPC.usageSummary: {
        const list = deps.sessionStore.list().filter(ownedByCaller)
        const cwds = new Map<string, string | null>()
        await Promise.all(
          list
            .filter((s) => s.agentKind === 'pi')
            .map(async (s) => {
              cwds.set(s.id, await cwdForSession(s))
            }),
        )
        return buildUsageSummary(list, { cwdFor: (s) => cwds.get(s.id) ?? null })
      }

      case IPC.listPromptTemplates: {
        const repoId = args[0] as string
        await requireOwnedRepo(repoId)
        return deps.promptTemplates.list(repoId).filter(ownedByCaller)
      }

      case IPC.savePromptTemplate: {
        const input = args[0] as { id?: string; repoId: string; name: string; body: string }
        await requireOwnedRepo(input.repoId)
        if (!input.name?.trim()) throw new Error('Template name must not be empty')
        if (!input.body?.trim()) throw new Error('Template body must not be empty')
        let id = input.id
        let createdAt = Date.now()
        if (id !== undefined) {
          // Updating an existing template: missing and other-owner rows throw
          // the identical error — no existence leak across owners.
          const existing = deps.promptTemplates.get(id)
          if (!existing || !ownedByCaller(existing)) throw new Error(`Template not found: ${id}`)
          createdAt = existing.createdAt
        } else {
          id = randomUUID()
        }
        const dto: PromptTemplateDTO = {
          id,
          repoId: input.repoId,
          name: input.name.trim(),
          body: input.body,
          createdAt,
          ownerId: identity.id,
        }
        deps.promptTemplates.upsert(dto)
        return dto
      }

      case IPC.deletePromptTemplate: {
        const id = args[0] as string
        // Missing and other-owner rows throw the identical error — no
        // existence leak across owners.
        const existing = deps.promptTemplates.get(id)
        if (!existing || !ownedByCaller(existing)) throw new Error(`Template not found: ${id}`)
        deps.promptTemplates.delete(id)
        return undefined
      }

      case IPC.getSessionOutcome: {
        const id = args[0] as string
        // Owner-scoped: a missing OR other-owner session surfaces the same
        // "not found" so an outcome can't leak across owners.
        if (!ownedSession(id)) throw new Error(`Session not found: ${id}`)
        return resolveOutcome(id)
      }

      case IPC.listSessionAgentEvents: {
        const id = args[0] as string
        // Owner-scoped like getSessionOutcome: missing and other-owner rows
        // surface the same "not found".
        if (!ownedSession(id)) throw new Error(`Session not found: ${id}`)
        return deps.agentEventStore?.list(id) ?? []
      }

      case IPC.listSessionHistory: {
        const sessions = deps.sessionStore.list().filter(ownedByCaller)
        sessions.sort((a, b) => b.createdAt - a.createdAt)
        const piCwds = new Map<string, string | null>()
        await Promise.all(
          sessions
            .filter((s) => s.agentKind === 'pi')
            .map(async (s) => {
              piCwds.set(s.id, await cwdForSession(s))
            }),
        )
        const entries: SessionHistoryEntry[] = []
        for (const session of sessions) {
          const outcome = await resolveOutcome(session.id)
          const rawUsage = readSessionUsage(session, { cwd: piCwds.get(session.id) ?? null })
          const usage = !rawUsage.exists || rawUsage.turns === 0 ? null : rawUsage
          entries.push({ session, outcome, usage })
        }
        return entries
      }

      case IPC.sessionPrStatus: {
        const id = args[0] as string
        // Owner-scoped: a missing OR other-owner session surfaces the same
        // "not found" so PR status can't leak across owners.
        const s = ownedSession(id)
        if (!s) throw new Error(`Session not found: ${id}`)
        if (!deps.prStatus || !s.prUrl) return null
        return deps.prStatus.get(s)
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
    deps.sessions.off('exit', onExit)
    deps.sessions.off('agentEvent', onAgentEvent)
    if (coord) {
      coord.dropClient(clientId)
      coord.off('change', onLockChange)
    }
  }

  return { handle, dispose }
}

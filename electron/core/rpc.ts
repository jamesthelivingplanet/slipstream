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
  AgentArgsConfig,
  RepoSettings,
  NotifyPrefs,
  PushSubscriptionDTO,
  FcmTokenDTO,
  WriteLockState,
  GcPolicy,
  SchedulerPolicy,
  TicketSource,
  TicketSourceSettings,
  PromptTemplateDTO,
  WorktreeUpdateMode,
  GitHost,
  StatusMeta,
} from '../shared/contract.js'
import { GIT_PROVIDERS } from '../services/gitProviders/registry.js'
import { branchFor, isSafeSlug } from '../shared/branch.js'
import { buildSystemPrompt, buildHandoffPrompt, AGENT_LABELS } from '../shared/promptComposer.js'
import { parseAgentArgs } from '../shared/agentCli.js'
import { LOCAL_IDENTITY } from './auth.js'
import { usesEmbeddedServer } from '../services/agentBackend.js'
import { readGcPolicy, writeGcPolicy } from '../services/sessionReaper.js'
import { launchSession, resumeProcedure } from '../services/sessionLauncher.js'
import type { LaunchRequest } from '../services/sessionLauncher.js'
import { readSchedulerPolicy, writeSchedulerPolicy } from '../services/sessionScheduler.js'
import { checkSlipstreamCli, lastCliActivity } from '../services/cliHealth.js'
import { diagnoseRepos, realRepoProbes } from '../services/diagnostics.js'
import { findAgentCli, binForKind } from '../services/cliProbe.js'
import { readSessionUsage, buildUsageSummary } from '../services/usage.js'
import { parseOutcomeSentinel, OUTCOME_SENTINEL_FILE } from '../services/outcomeSentinel.js'
import { transcriptPathFor } from '../services/transcripts.js'
import { parseTranscriptMessages } from '../services/transcriptMessages.js'
import { parsePiChatMessages } from '../services/piChatMessages.js'
import {
  findNewestPiSessionFile,
  piSessionDirFor,
  readPiSessionFile,
} from '../services/piSessions.js'
import { fetchOpencodeMessages, opencodeMessagesToChat } from '../services/opencodeSessions.js'
import { listAgentSkillsFor } from '../services/agentSkills.js'
import { extractScreenQuestion } from '../services/chatQuestion.js'
import type { SessionChatMessageDTO } from '../shared/contract.js'

/** Shared paging for getChatMessages across every backend (TASK-FPH60):
 *  `beforeTs` filters to strictly-older messages (pagination cursor), `limit`
 *  (default 50) caps to the most recent page after that filter. */
function pageChatMessages(
  messages: SessionChatMessageDTO[],
  opts: { beforeTs?: number; limit?: number },
): SessionChatMessageDTO[] {
  let out = messages
  if (opts.beforeTs !== undefined) {
    out = out.filter((m) => m.ts < opts.beforeTs!)
  }
  const limit = opts.limit ?? 50
  if (out.length > limit) out = out.slice(-limit)
  return out
}

const GIT_HOST_IDS = new Set(GIT_PROVIDERS.map((p) => p.meta.id))

function isGitHost(host: unknown): host is GitHost {
  return typeof host === 'string' && GIT_HOST_IDS.has(host as GitHost)
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

  // `branch` reaches `join()`-based worktree paths and shell cwds (worktree
  // status/diff/update, openInEditor, runApp) — reject anything that isn't a
  // plain slug so a `..`/absolute-path payload can't escape `.worktrees/`
  // (FLO-129).
  function requireSafeBranch(branch: string): string {
    if (!isSafeSlug(branch)) throw new Error(`Invalid branch: ${branch}`)
    return branch
  }

  // Negative-cache disk-fallback misses for a bounded window. Scoped inside
  // createRpc's closure (per-connection), NOT module scope: module scope
  // would leak across the per-connection createRpc() instances the test
  // suite creates fresh in every beforeEach, and in production it should
  // track state for this daemon connection, not survive the whole process.
  // A History-panel open loops resolveOutcome over every owned session, so
  // without this a session that never got an outcome (still running, or
  // finished with no sentinel file) re-reads disk on every open, forever.
  // The TTL keeps the restart-race fallback self-healing within a bounded
  // window rather than negative-caching a miss forever.
  const OUTCOME_MISS_TTL_MS = 30_000
  const outcomeMissCache = new Map<string, number>() // sessionId -> cache-until epoch ms

  // Resolve a session's structured outcome: prefer the durable store, but
  // fall back to reading the outcome.json sentinel straight off disk. A
  // daemon restart can race the sessionManager's fs.watch — the watcher only
  // starts once a session is live again — so a session that finished and
  // wrote its sentinel while the daemon was down (or between restart and
  // resume) would otherwise appear to have no outcome even though the agent
  // reported one. On a successful disk read, backfill the store so future
  // reads don't need the fallback.
  //
  // The store lookup always runs first, unconditionally — this lets an
  // outcome written out-of-band by the live sentinelWatcher/sessionPersistence
  // listener (while this connection stays open) surface immediately even if
  // an earlier call negative-cached a miss. Only the disk-read fallback is
  // skipped while a miss is cached.
  async function resolveOutcome(sessionId: string): Promise<SessionOutcomeDTO | null> {
    const stored = deps.outcomeStore.get(sessionId)
    if (stored) return stored
    if (!deps.agentCli) return null

    const missUntil = outcomeMissCache.get(sessionId)
    if (missUntil !== undefined && missUntil > Date.now()) return null

    try {
      const filePath = path.join(
        deps.agentCli.dataDir,
        'sessions',
        sessionId,
        OUTCOME_SENTINEL_FILE,
      )
      const content = await fs.promises.readFile(filePath, 'utf8')
      const parsed = parseOutcomeSentinel(content)
      if (!parsed) {
        outcomeMissCache.set(sessionId, Date.now() + OUTCOME_MISS_TTL_MS)
        return null
      }
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
      outcomeMissCache.set(sessionId, Date.now() + OUTCOME_MISS_TTL_MS)
      return null
    }
  }

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
  function onStatus(sessionId: string, status: string, meta?: StatusMeta): void {
    // Keep the common (no-meta) case at 2 args over the wire — status fires on
    // every PTY chunk, a hot path, and JSON.stringify([...,undefined]) would
    // turn a trailing undefined 4th arg into a `null` anyway.
    if (meta !== undefined) {
      emit(IPC.sessionStatus, sessionId, status, meta)
    } else {
      emit(IPC.sessionStatus, sessionId, status)
    }
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

  function onChatMessage(id: string, msg: import('../shared/contract.js').SessionChatMessageDTO) {
    emit(IPC.sessionChatMessage, id, msg)
  }

  deps.sessions.on('data', onData)
  deps.sessions.on('status', onStatus)
  deps.sessions.on('pr', onPr)
  deps.sessions.on('exit', onExit)
  deps.sessions.on('agentEvent', onAgentEvent)
  deps.sessions.on('chatMessage', onChatMessage)

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
        return deps.tickets.listTickets(
          args[0] as { page?: number; pageSize?: number; query?: string } | undefined,
        )

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
          extraArgs?: string
        }
        const { tid, title, prompt, repoId, description } = input
        const agentKind = input.agentKind

        // TASK-CMZUG: a blank per-run extraArgs falls back to the saved per-agent
        // default (config key agentArgs.<kind>); a non-blank run value overrides it.
        const effectiveExtraArgs =
          input.extraArgs && input.extraArgs.trim()
            ? input.extraArgs
            : deps.config.get(`agentArgs.${agentKind ?? 'claude-code'}`) || undefined

        // TASK-UQF55: validate up front so a malformed arg string errors the
        // start call synchronously (incl. the queued path), not later.
        if (effectiveExtraArgs) parseAgentArgs(effectiveExtraArgs)

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
          extraArgs: effectiveExtraArgs,
        }

        const session = deps.scheduler
          ? await deps.scheduler.submit(req)
          : await launchSession(deps, req)

        return session
      }

      case IPC.writeSession: {
        const id = args[0] as string
        if (!ownedSession(id)) return undefined
        if (coord && !coord.noteWrite(id, clientId)) return undefined
        deps.sessions.write(id, args[1] as string)
        return undefined
      }

      case IPC.syncClipboardImage: {
        const id = args[0] as string
        const dataBase64 = args[1] as string
        if (!ownedSession(id)) throw new Error(`Session not found: ${id}`)
        if (coord && !coord.noteWrite(id, clientId)) return undefined
        if (!deps.clipboardStore) throw new Error('Clipboard storage is not configured')
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64) || dataBase64.length % 4 !== 0) {
          throw new Error('Invalid base64 image data')
        }
        const buf = Buffer.from(dataBase64, 'base64')
        const MAX_CLIPBOARD_BYTES = 10 * 1024 * 1024
        if (buf.length > MAX_CLIPBOARD_BYTES) {
          throw new Error('Clipboard image exceeds the 10 MiB limit')
        }
        deps.clipboardStore.save(id, buf)
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
        if (!persisted) return { removed: false, reason: 'session not found' }
        const repo = await deps.repos.get(persisted.repoId)
        if (!repo) return { removed: false, reason: 'session not found' }
        const result = await deps.worktrees.remove(repo, persisted.branch, opts)
        if (result.removed) {
          deps.sessionStore.delete(id)
          deps.clipboardStore?.delete(id)

          // FLO-35: move the linked ticket back to "To Do" when the agent run
          // is deleted, so the next agent can pick it up. Best-effort — a
          // ticket-API failure must not break the cleanup.
          // TASK-5PVBM: but a run that reached 'done' finished its work — leave
          // the ticket where the agent left it rather than bouncing it back to
          // To Do.
          const tid = persisted.tid
          if (tid && persisted.status !== 'done') {
            try {
              await deps.tickets.resetTicket(tid, persisted.src)
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
        return resumeProcedure(deps, { mode: 'resume', session: persisted })
      }

      case IPC.attachRemoteControl: {
        const id = args[0] as string
        const persisted = ownedSession(id)
        if (!persisted) throw new Error(`Session not found: ${id}`)
        // A queued session hasn't been spawned yet — the scheduler owns when
        // it launches (spawning it here would let a viewer jump the queue).
        if (persisted.status === 'queued') return persisted
        return resumeProcedure(deps, { mode: 'attach', session: persisted })
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
        return resumeProcedure(deps, {
          mode: 'handoff',
          session: persisted,
          agentKind,
          handoffPrompt,
        })
      }

      case IPC.getSessionBuffer: {
        const id = args[0] as string
        if (!ownedSession(id)) throw new Error(`Session not found: ${id}`)
        return deps.sessions.getBuffer(id)
      }

      case IPC.worktreeStatus: {
        const repoId = args[0] as string
        const branch = requireSafeBranch(args[1] as string)
        const repo = await requireOwnedRepo(repoId)
        return deps.worktrees.status(repo, branch)
      }

      case IPC.worktreeDiff: {
        const repoId = args[0] as string
        const branch = requireSafeBranch(args[1] as string)
        const repo = await requireOwnedRepo(repoId)
        return deps.worktrees.diff(repo, branch)
      }

      case IPC.worktreeUpdateFromBase: {
        const repoId = args[0] as string
        const branch = requireSafeBranch(args[1] as string)
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
        const provider = deps.ticketProviders?.[src]
        if (!provider) throw new Error(`Unknown ticket source: ${src}`)
        return provider.getSettings()
      }

      case IPC.setTicketSettings: {
        const src = args[0] as TicketSource
        const cfg = args[1] as TicketSourceSettings
        const provider = deps.ticketProviders?.[src]
        if (!provider) throw new Error(`Unknown ticket source: ${src}`)
        provider.setSettings(cfg)
        return undefined
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

      case IPC.getAgentArgs: {
        const cfg: AgentArgsConfig = {}
        for (const kind of BACKEND_KINDS) {
          const v = deps.config.get(`agentArgs.${kind}`)
          if (v && v.trim()) cfg[kind] = v
        }
        return cfg
      }

      case IPC.setAgentArgs: {
        const cfg = (args[0] ?? {}) as AgentArgsConfig
        const next: Array<[string, string]> = []
        for (const kind of BACKEND_KINDS) {
          const raw = (cfg[kind] ?? '').trim()
          // Validate every value before writing any, so a malformed entry rejects
          // the whole save (same guard startSession applies) without a partial write.
          if (raw) parseAgentArgs(raw)
          next.push([`agentArgs.${kind}`, raw])
        }
        for (const [key, raw] of next) deps.config.set(key, raw)
        return undefined
      }

      case IPC.openInEditor: {
        const input = args[0] as { repoId: string; branch: string; mobile?: boolean }
        const branch = requireSafeBranch(input.branch)
        const repo = await requireOwnedRepo(input.repoId)
        const cwd = deps.worktrees.pathFor(repo, branch)
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
        const { repoId, branch: rawBranch } = args[0] as { repoId: string; branch: string }
        const branch = requireSafeBranch(rawBranch)
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

      case IPC.saveFcmToken:
        return deps.push.saveFcmToken(identity.id, args[0] as FcmTokenDTO)

      case IPC.deleteFcmToken:
        return deps.push.deleteFcmToken(identity.id, args[0] as string)

      case IPC.getGitToken: {
        const host = args[0]
        if (!isGitHost(host)) throw new Error(`Invalid host: ${String(host)}`)
        return deps.config.get(`${host}.token`) ?? null
      }

      case IPC.setGitToken: {
        const host = args[0]
        if (!isGitHost(host)) throw new Error(`Invalid host: ${String(host)}`)
        deps.config.set(`${host}.token`, args[1] as string)
        return undefined
      }

      case IPC.listGitProviders:
        return GIT_PROVIDERS.map((p) => ({ ...p.meta }))

      case IPC.getGitHostConfig: {
        const host = args[0]
        if (!isGitHost(host)) throw new Error(`Invalid host: ${String(host)}`)
        return {
          token: deps.config.get(`${host}.token`) ?? null,
          username: deps.config.get(`${host}.username`) ?? null,
          baseUrl: deps.config.get(`${host}.baseUrl`) ?? null,
        }
      }

      case IPC.setGitHostConfig: {
        const host = args[0]
        if (!isGitHost(host)) throw new Error(`Invalid host: ${String(host)}`)
        const cfg = (args[1] ?? {}) as { token?: string; username?: string; baseUrl?: string }
        if (cfg.token !== undefined) deps.config.set(`${host}.token`, cfg.token)
        if (cfg.username !== undefined) deps.config.set(`${host}.username`, cfg.username)
        if (cfg.baseUrl !== undefined) deps.config.set(`${host}.baseUrl`, cfg.baseUrl)
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
        return await readSessionUsage(session, { cwd })
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
        return await buildUsageSummary(list, { cwdFor: (s) => cwds.get(s.id) ?? null })
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

      case IPC.getChatMessages: {
        const id = args[0] as string
        const opts = (args[1] as { beforeTs?: number; limit?: number } | undefined) ?? {}
        // Owner-scoped like getSessionOutcome/listSessionAgentEvents: missing
        // and other-owner rows surface the same "not found".
        const session = ownedSession(id)
        if (!session) throw new Error(`Session not found: ${id}`)

        const kind = session.agentKind ?? 'claude-code'

        if (kind === 'claude-code') {
          const file = transcriptPathFor(id)
          if (!file) return { available: false, messages: [] }
          let raw: string
          try {
            raw = await fs.promises.readFile(file, 'utf8')
          } catch {
            return { available: false, messages: [] }
          }
          return { available: true, messages: pageChatMessages(parseTranscriptMessages(raw), opts) }
        }

        if (kind === 'pi') {
          const cwd = await cwdForSession(session)
          if (!cwd) return { available: false, messages: [] }
          const file = await findNewestPiSessionFile(piSessionDirFor(cwd))
          if (!file) return { available: false, messages: [] }
          const raw = await readPiSessionFile(file)
          return { available: true, messages: pageChatMessages(parsePiChatMessages(raw), opts) }
        }

        if (usesEmbeddedServer(kind)) {
          const state = deps.sessions.getOpencodeState?.(id)
          if (!state?.port || !state.sid) return { available: false, messages: [] }
          const raw = await fetchOpencodeMessages(state.port, state.sid)
          return { available: true, messages: pageChatMessages(opencodeMessagesToChat(raw), opts) }
        }

        // antigravity/grok have no chat reader (TASK-FPH60) — terminal-only.
        // kilo goes through the embedded-server branch above (opencode + kilo
        // share it — see usesEmbeddedServer).
        return { available: false, messages: [] }
      }

      case IPC.subscribeChat: {
        const id = args[0] as string
        if (!ownedSession(id)) return undefined
        deps.sessions.subscribeChat?.(id, clientId)
        return undefined
      }

      case IPC.unsubscribeChat: {
        const id = args[0] as string
        if (!ownedSession(id)) return undefined
        deps.sessions.unsubscribeChat?.(id, clientId)
        return undefined
      }

      case IPC.listAgentSkills: {
        const id = args[0] as string
        const session = ownedSession(id)
        if (!session) throw new Error(`Session not found: ${id}`)
        const cwd = await cwdForSession(session)
        if (!cwd) return []
        return listAgentSkillsFor(session.agentKind, cwd)
      }

      case IPC.getChatQuestion: {
        const id = args[0] as string
        // Owner-scoped like getChatMessages/listAgentSkills: missing and
        // other-owner rows surface the same "not found".
        const session = ownedSession(id)
        if (!session) throw new Error(`Session not found: ${id}`)
        if (session.status !== 'needs') return null

        // Prefer the agent's own report (status.json sentinel message) when
        // fresh — see sessionManager's getSessionActivity/activityMessage.
        const agentMsg = deps.sessions.getSessionActivity?.(id)
        if (agentMsg) return { text: agentMsg, source: 'agent' }

        // Fall back to the live headless-screen mirror — covers interactive
        // permission prompts, where the agent process is frozen and reports
        // nothing. Only for a LIVE session: getBuffer() falls back to
        // persisted scrollback for a dead one, which isn't a "screen".
        if (!deps.sessions.has(id)) return null
        const { data } = await deps.sessions.getBuffer(id)
        const excerpt = extractScreenQuestion(data)
        if (!excerpt) return null
        return { text: excerpt, source: 'screen' }
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
          const rawUsage = await readSessionUsage(session, { cwd: piCwds.get(session.id) ?? null })
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
    deps.sessions.off('chatMessage', onChatMessage)
    deps.sessions.dropChatClient?.(clientId)
    if (coord) {
      coord.dropClient(clientId)
      coord.off('change', onLockChange)
    }
  }

  return { handle, dispose }
}

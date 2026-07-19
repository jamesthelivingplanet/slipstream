/**
 * WebSocket-backed SlipstreamApi client.
 *
 * createWsApi({ url, token }) returns a SlipstreamApi that talks to the headless
 * WebSocket server via the wire protocol defined in electron/shared/wire.ts.
 *
 * Framework-free (plain TS) — unit-testable against a fake WebSocket.
 */

import type {
  SlipstreamApi,
  BranchMergedDTO,
  PaginatedTickets,
  RepoDTO,
  RepoSettings,
  SessionDTO,
  TicketDTO,
  SessionStatus,
  WorkflowState,
  WorktreeInfo,
  WorktreeDiffDTO,
  WorktreeUpdateMode,
  WorktreeUpdateResultDTO,
  EditorConfig,
  NotifyPrefs,
  PushSubscriptionDTO,
  FcmTokenDTO,
  BackendKind,
  GitHost,
  WriteLockState,
  GcPolicy,
  SchedulerPolicy,
  CliStatusDTO,
  DiagnosticsDTO,
  TicketSource,
  AgentCliCheck,
  ScopeOption,
  TicketSourceSettings,
  SessionUsage,
  UsageSummary,
  PromptTemplateDTO,
  SessionOutcomeDTO,
  SessionHistoryEntry,
  SessionAgentEventDTO,
  PrStatusDTO,
  GitProviderInfoDTO,
  GitHostConfigDTO,
} from '../../electron/shared/contract.js'
import type { WireReq, WireRes, WirePush } from '../../electron/shared/wire.js'
import { IPC } from '../../electron/shared/contract.js'
import { genId } from './id.js'

const REQUEST_TIMEOUT_MS = 30_000
const RECONNECT_DELAYS = [500, 1000, 2000, 5000, 10000]
// Application-level heartbeat: the browser WebSocket API can't observe ws-protocol
// ping/pong frames, so we send a JSON { t: 'ping' } and expect a { t: 'pong' } back.
// If no pong arrives within PONG_TIMEOUT_MS, the connection is treated as half-dead
// and force-closed to trigger the existing reconnect path.
const HEARTBEAT_INTERVAL_MS = 15_000
const PONG_TIMEOUT_MS = 10_000
// Foreground fast-probe (visibilitychange/online/pageshow): a much shorter
// deadline than the regular heartbeat's PONG_TIMEOUT_MS — the user is looking
// at the screen right now, so we want to detect a half-dead socket and kick
// off reconnect in ~3s instead of waiting out the next full heartbeat cycle.
const FOREGROUND_PONG_TIMEOUT_MS = 3_000

export interface WsApiOpts {
  url: string // e.g. ws://host:port/rpc
  token: string
  /** Override WebSocket constructor (for tests). */
  WebSocketCtor?: typeof WebSocket
  /** Called when the server rejects with 401 (close code 4001 or initial open error). */
  onAuthError?: () => void
}

type PendingReq = {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  channel: string
  // Undefined until the frame is actually sent — see armTimeout(). Requests that are
  // only queued (socket down) must not start ticking down while sitting in the queue.
  timer: ReturnType<typeof setTimeout> | undefined
}

type DataCb = (id: string, data: string, seq: number) => void
type StatusCb = (id: string, status: SessionStatus) => void
type ExitCb = (id: string, code: number) => void

export function createWsApi(opts: WsApiOpts): SlipstreamApi {
  const WS = opts.WebSocketCtor ?? WebSocket
  const fullUrl = `${opts.url}?token=${encodeURIComponent(opts.token)}`

  let ws: WebSocket | null = null
  let open = false
  const destroyed = false
  let reconnectAttempt = 0
  let heartbeatInterval: ReturnType<typeof setInterval> | undefined
  let pongTimeout: ReturnType<typeof setTimeout> | undefined
  // Handle for the backoff timer scheduled by scheduleReconnect(), so a
  // foreground fast-probe (visibilitychange/online/pageshow) can cancel the
  // wait and reconnect immediately instead of sitting out the delay.
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined

  // In-flight request map
  const pending = new Map<string, PendingReq>()

  // Queue for requests issued before the socket opens
  const queue: WireReq[] = []

  // Push listeners
  const dataListeners = new Set<DataCb>()
  const statusListeners = new Set<StatusCb>()
  const exitListeners = new Set<ExitCb>()
  type PrCb = (id: string, prUrl: string) => void
  const prListeners = new Set<PrCb>()
  type WriteLockCb = (state: WriteLockState) => void
  const writeLockListeners = new Set<WriteLockCb>()
  type AgentEventCb = (event: SessionAgentEventDTO) => void
  const agentEventListeners = new Set<AgentEventCb>()
  type ConnectionCb = (connected: boolean) => void
  const connectionListeners = new Set<ConnectionCb>()

  function notifyConnection(connected: boolean) {
    for (const cb of connectionListeners) cb(connected)
  }

  function isOpen(): boolean {
    return open && !!ws && ws.readyState === WS.OPEN
  }

  function stopHeartbeat() {
    if (heartbeatInterval !== undefined) {
      clearInterval(heartbeatInterval)
      heartbeatInterval = undefined
    }
    if (pongTimeout !== undefined) {
      clearTimeout(pongTimeout)
      pongTimeout = undefined
    }
  }

  function startHeartbeat() {
    // Guard against stacking intervals/timeouts if onopen fires again after a reconnect.
    stopHeartbeat()
    heartbeatInterval = setInterval(() => {
      if (!ws) return
      ws.send(JSON.stringify({ t: 'ping' }))
      if (pongTimeout === undefined) {
        pongTimeout = setTimeout(() => {
          pongTimeout = undefined
          // No pong within the deadline — the connection is half-dead. Force-close so
          // the existing onclose -> scheduleReconnect() path kicks in.
          ws?.close()
        }, PONG_TIMEOUT_MS)
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  // Arms the per-request timeout at the moment the frame is actually sent (not when
  // queued) so requests waiting in `queue` during reconnect backoff don't falsely
  // time out before they've even reached the wire.
  function armTimeout(id: string) {
    const p = pending.get(id)
    if (!p || p.timer !== undefined) return
    p.timer = setTimeout(() => {
      pending.delete(id)
      p.reject(new Error(`Request timed out: ${p.channel}`))
    }, REQUEST_TIMEOUT_MS)
  }

  function connect() {
    if (destroyed) return
    try {
      ws = new WS(fullUrl)
    } catch {
      scheduleReconnect()
      return
    }

    ws.onopen = () => {
      open = true
      reconnectAttempt = 0
      // Flush queued requests
      for (const req of queue) {
        ws!.send(JSON.stringify(req))
        armTimeout(req.id)
      }
      queue.length = 0
      startHeartbeat()
      notifyConnection(true)
    }

    ws.onmessage = (evt: MessageEvent) => {
      let msg: WireRes | WirePush | { t: 'pong' }
      try {
        msg = JSON.parse(evt.data as string)
      } catch {
        return
      }

      if (msg.t === 'pong') {
        if (pongTimeout !== undefined) {
          clearTimeout(pongTimeout)
          pongTimeout = undefined
        }
        return
      }

      if (msg.t === 'res') {
        const p = pending.get(msg.id)
        if (!p) return
        pending.delete(msg.id)
        if (p.timer !== undefined) clearTimeout(p.timer)
        if (msg.ok) {
          p.resolve(msg.result)
        } else {
          p.reject(new Error(msg.error))
        }
      } else if (msg.t === 'push') {
        if (msg.channel === IPC.sessionData) {
          const [id, chunk, seq] = msg.args as [string, string, number]
          for (const cb of dataListeners) cb(id, chunk, seq)
        } else if (msg.channel === IPC.sessionStatus) {
          const [id, status] = msg.args as [string, SessionStatus]
          for (const cb of statusListeners) cb(id, status)
        } else if (msg.channel === IPC.sessionExit) {
          const [id, code] = msg.args as [string, number]
          for (const cb of exitListeners) cb(id, code)
        } else if (msg.channel === IPC.sessionPr) {
          const [id, prUrl] = msg.args as [string, string]
          for (const cb of prListeners) cb(id, prUrl)
        } else if (msg.channel === IPC.sessionWriteLock) {
          const [state] = msg.args as [WriteLockState]
          for (const cb of writeLockListeners) cb(state)
        } else if (msg.channel === IPC.sessionAgentEvent) {
          const [event] = msg.args as [SessionAgentEventDTO]
          for (const cb of agentEventListeners) cb(event)
        }
      }
    }

    ws.onclose = (evt: CloseEvent) => {
      open = false
      stopHeartbeat()
      // Notify on every close transition, including the auth-error path below —
      // the UI's "connected" state should reflect reality even though that path
      // doesn't retry.
      notifyConnection(false)
      // Reject all in-flight requests
      for (const [, p] of pending) {
        if (p.timer !== undefined) clearTimeout(p.timer)
        p.reject(new Error('WebSocket closed'))
      }
      pending.clear()
      // Drop queued frames too — their pending entries were just rejected above, so
      // flushing them on the next reconnect would execute requests whose callers
      // already saw an error (ghost sessions for non-idempotent channels) and whose
      // responses would be silently discarded. Queue and pending stay in lockstep.
      queue.length = 0

      // 4001 = auth error (server-sent close code for 401)
      if (evt.code === 4001 || evt.code === 1008) {
        opts.onAuthError?.()
        return
      }

      if (!destroyed) {
        scheduleReconnect()
      }
    }

    ws.onerror = () => {
      // onclose will fire after onerror; let it drive reconnect logic
    }
  }

  function scheduleReconnect() {
    if (destroyed) return
    const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)]
    reconnectAttempt++
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      connect()
    }, delay)
  }

  // ── Foreground fast-probe ───────────────────────────────────────────────
  // A backgrounded tab/app can sit on a half-dead socket for up to
  // HEARTBEAT_INTERVAL_MS + PONG_TIMEOUT_MS (~25s) before the regular
  // heartbeat notices. When the app comes back to the foreground (tab
  // refocus, phone unlock, network change), probe immediately instead of
  // waiting out that window.
  function onForeground() {
    if (destroyed) return
    if (reconnectTimer !== undefined) {
      // A backoff wait was in progress — the user is looking at the screen
      // now, so don't make them wait out the remaining delay.
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      reconnectAttempt = 0
      connect()
      return
    }
    if (isOpen()) {
      if (pongTimeout === undefined) {
        ws!.send(JSON.stringify({ t: 'ping' }))
        pongTimeout = setTimeout(() => {
          pongTimeout = undefined
          // No pong within the short foreground deadline — treat as half-dead
          // and force-close so the existing onclose -> reconnect path kicks in.
          ws?.close()
        }, FOREGROUND_PONG_TIMEOUT_MS)
      }
      // else: a heartbeat pong is already pending — don't stack a second timer.
    }
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') onForeground()
    })
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', onForeground)
    window.addEventListener('pageshow', onForeground)
  }

  function send(req: WireReq): void {
    if (isOpen()) {
      ws!.send(JSON.stringify(req))
      armTimeout(req.id)
    } else {
      queue.push(req)
    }
  }

  function request(channel: string, args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = genId()
      // Register without a timer — armTimeout() starts the clock only once the frame
      // is actually sent (in send() when open, or at flush time in onopen), so a
      // request queued during reconnect backoff doesn't falsely time out.
      pending.set(id, { resolve, reject, channel, timer: undefined })
      send({ t: 'req', id, channel, args })
    })
  }

  // Boot the connection
  connect()

  // ── SlipstreamApi implementation ────────────────────────────────────────────

  return {
    listRepos(): Promise<RepoDTO[]> {
      return request(IPC.listRepos, []) as Promise<RepoDTO[]>
    },

    registerRepo(absPath: string): Promise<RepoDTO> {
      return request(IPC.registerRepo, [absPath]) as Promise<RepoDTO>
    },

    registerRepoByUrl(remoteUrl: string): Promise<RepoDTO> {
      return request(IPC.registerRepoByUrl, [remoteUrl]) as Promise<RepoDTO>
    },

    /** Not supported on web — resolve null. Path-input fallback in SettingsModal handles repo adding. */
    pickAndRegisterRepo(): Promise<RepoDTO | null> {
      return Promise.resolve(null)
    },

    removeRepo(id: string): Promise<void> {
      return request(IPC.removeRepo, [id]) as Promise<void>
    },

    listTickets(opts?: {
      page?: number
      pageSize?: number
      query?: string
    }): Promise<PaginatedTickets> {
      return request(IPC.listTickets, [opts]) as Promise<PaginatedTickets>
    },

    getTicketStatus(
      tid: string,
      src?: TicketSource,
    ): Promise<{ current: WorkflowState | null; available: WorkflowState[] }> {
      return request(IPC.getTicketStatus, [tid, src]) as Promise<{
        current: WorkflowState | null
        available: WorkflowState[]
      }>
    },

    setTicketStatus(tid: string, stateId: string, src?: TicketSource): Promise<WorkflowState> {
      return request(IPC.setTicketStatus, [tid, stateId, src]) as Promise<WorkflowState>
    },

    getLinearKey(): Promise<string | null> {
      return request(IPC.getLinearKey, []) as Promise<string | null>
    },

    setLinearKey(key: string): Promise<void> {
      return request(IPC.setLinearKey, [key]) as Promise<void>
    },

    getTicketSettings(src: TicketSource): Promise<TicketSourceSettings> {
      return request(IPC.getTicketSettings, [src]) as Promise<TicketSourceSettings>
    },

    setTicketSettings(src: TicketSource, cfg: TicketSourceSettings): Promise<void> {
      return request(IPC.setTicketSettings, [src, cfg]) as Promise<void>
    },

    listTicketScopes(src: TicketSource): Promise<ScopeOption[]> {
      return request(IPC.listTicketScopes, [src]) as Promise<ScopeOption[]>
    },

    startSession(input: {
      tid: string
      title: string
      prompt: string
      repoId: string
      agentKind?: BackendKind
      src?: TicketSource
    }): Promise<SessionDTO> {
      return request(IPC.startSession, [input]) as Promise<SessionDTO>
    },

    writeSession(id: string, data: string): void {
      // Fire-and-forget: drop the frame while the socket is down instead of queuing
      // it — replaying stale keystrokes into a live PTY seconds later on reconnect
      // is worse than silently losing input the user typed while disconnected.
      if (!isOpen()) return
      const req: WireReq = { t: 'req', id: genId(), channel: IPC.writeSession, args: [id, data] }
      send(req)
    },

    syncClipboardImage(id: string, dataBase64: string): Promise<void> {
      return request(IPC.syncClipboardImage, [id, dataBase64]) as Promise<void>
    },

    resizeSession(id: string, cols: number, rows: number): void {
      // Fire-and-forget: drop the frame while the socket is down instead of queuing
      // it — replaying a stale terminal size on reconnect is useless (the UI sends a
      // fresh resize once it re-attaches).
      if (!isOpen()) return
      const req: WireReq = {
        t: 'req',
        id: genId(),
        channel: IPC.resizeSession,
        args: [id, cols, rows],
      }
      send(req)
    },

    killSession(id: string): Promise<void> {
      return request(IPC.killSession, [id]) as Promise<void>
    },

    cleanupSession(
      id: string,
      opts?: { force?: boolean },
    ): Promise<{ removed: boolean; reason?: string }> {
      return request(IPC.cleanupSession, [id, opts]) as Promise<{
        removed: boolean
        reason?: string
      }>
    },

    sessionMerged(id: string): Promise<BranchMergedDTO> {
      return request(IPC.sessionMerged, [id]) as Promise<BranchMergedDTO>
    },

    listSessions(): Promise<SessionDTO[]> {
      return request(IPC.listSessions, []) as Promise<SessionDTO[]>
    },

    resumeSession(id: string): Promise<SessionDTO> {
      return request(IPC.resumeSession, [id]) as Promise<SessionDTO>
    },

    attachRemoteControl(id: string): Promise<SessionDTO> {
      return request(IPC.attachRemoteControl, [id]) as Promise<SessionDTO>
    },

    handoffSession(id: string, agentKind: BackendKind): Promise<SessionDTO> {
      return request(IPC.handoffSession, [id, agentKind]) as Promise<SessionDTO>
    },

    worktreeStatus(repoId: string, branch: string): Promise<WorktreeInfo> {
      return request(IPC.worktreeStatus, [repoId, branch]) as Promise<WorktreeInfo>
    },

    worktreeDiff(repoId: string, branch: string): Promise<WorktreeDiffDTO> {
      return request(IPC.worktreeDiff, [repoId, branch]) as Promise<WorktreeDiffDTO>
    },

    worktreeUpdateFromBase(
      repoId: string,
      branch: string,
      mode: WorktreeUpdateMode,
    ): Promise<WorktreeUpdateResultDTO> {
      return request(IPC.worktreeUpdateFromBase, [
        repoId,
        branch,
        mode,
      ]) as Promise<WorktreeUpdateResultDTO>
    },

    getEditorConfig(): Promise<EditorConfig> {
      return request(IPC.getEditorConfig, []) as Promise<EditorConfig>
    },

    setEditorConfig(cfg: EditorConfig): Promise<void> {
      return request(IPC.setEditorConfig, [cfg]) as Promise<void>
    },

    openInEditor(input: { repoId: string; branch: string; mobile?: boolean }): Promise<void> {
      return request(IPC.openInEditor, [input]) as Promise<void>
    },

    getSessionBuffer(id: string): Promise<{ data: string; seq: number }> {
      return request(IPC.getSessionBuffer, [id]) as Promise<{ data: string; seq: number }>
    },

    onSessionData(cb: DataCb): () => void {
      dataListeners.add(cb)
      return () => dataListeners.delete(cb)
    },

    onSessionStatus(cb: StatusCb): () => void {
      statusListeners.add(cb)
      return () => statusListeners.delete(cb)
    },
    onSessionExit(cb: ExitCb): () => void {
      exitListeners.add(cb)
      return () => exitListeners.delete(cb)
    },
    getRepoSettings(id: string): Promise<RepoSettings> {
      return request(IPC.getRepoSettings, [id]) as Promise<RepoSettings>
    },
    setRepoSettings(id: string, settings: RepoSettings): Promise<void> {
      return request(IPC.setRepoSettings, [id, settings]) as Promise<void>
    },
    runApp(input: { repoId: string; branch: string }): Promise<{
      started: boolean
      reason?: string
      port?: number
      pid?: number
      reused?: boolean
      url?: string
    }> {
      return request(IPC.runApp, [input]) as Promise<{
        started: boolean
        reason?: string
        port?: number
        pid?: number
        reused?: boolean
        url?: string
      }>
    },
    stopApp(input: { repoId: string; branch: string }): Promise<{ stopped: boolean }> {
      return request(IPC.stopApp, [input]) as Promise<{ stopped: boolean }>
    },
    appStatus(input: {
      repoId: string
      branch: string
    }): Promise<{ running: boolean; url?: string }> {
      return request(IPC.appStatus, [input]) as Promise<{ running: boolean; url?: string }>
    },
    getVapidPublicKey(): Promise<string> {
      return request(IPC.getVapidPublicKey, []) as Promise<string>
    },
    savePushSubscription(sub: PushSubscriptionDTO, prefs: NotifyPrefs): Promise<void> {
      return request(IPC.savePushSubscription, [sub, prefs]) as Promise<void>
    },
    deletePushSubscription(endpoint: string): Promise<void> {
      return request(IPC.deletePushSubscription, [endpoint]) as Promise<void>
    },
    getPushPrefs(
      endpoint: string,
    ): Promise<import('../../electron/shared/contract.js').NotifyPrefs | null> {
      return request(IPC.getPushPrefs, [endpoint]) as Promise<
        import('../../electron/shared/contract.js').NotifyPrefs | null
      >
    },
    saveFcmToken(token: FcmTokenDTO): Promise<void> {
      return request(IPC.saveFcmToken, [token]) as Promise<void>
    },
    deleteFcmToken(token: string): Promise<void> {
      return request(IPC.deleteFcmToken, [token]) as Promise<void>
    },
    getGitToken(host: GitHost): Promise<string | null> {
      return request(IPC.getGitToken, [host]) as Promise<string | null>
    },
    setGitToken(host: GitHost, token: string): Promise<void> {
      return request(IPC.setGitToken, [host, token]) as Promise<void>
    },
    listGitProviders(): Promise<GitProviderInfoDTO[]> {
      return request(IPC.listGitProviders, []) as Promise<GitProviderInfoDTO[]>
    },
    getGitHostConfig(host: GitHost): Promise<GitHostConfigDTO> {
      return request(IPC.getGitHostConfig, [host]) as Promise<GitHostConfigDTO>
    },
    setGitHostConfig(
      host: GitHost,
      cfg: { token?: string; username?: string; baseUrl?: string },
    ): Promise<void> {
      return request(IPC.setGitHostConfig, [host, cfg]) as Promise<void>
    },
    onSessionPr(cb: (id: string, prUrl: string) => void): () => void {
      prListeners.add(cb)
      return () => prListeners.delete(cb)
    },

    attachSession(id: string): Promise<WriteLockState> {
      return request(IPC.attachSession, [id]) as Promise<WriteLockState>
    },

    detachSession(id: string): void {
      // Fire-and-forget: drop the frame while the socket is down instead of queuing
      // it — the server already discards all per-client attach state on disconnect,
      // so replaying a detach on reconnect is pointless.
      if (!isOpen()) return
      const req: WireReq = { t: 'req', id: genId(), channel: IPC.detachSession, args: [id] }
      send(req)
    },

    takeWrite(id: string): Promise<WriteLockState> {
      return request(IPC.takeWrite, [id]) as Promise<WriteLockState>
    },

    onSessionWriteLock(cb: WriteLockCb): () => void {
      writeLockListeners.add(cb)
      return () => writeLockListeners.delete(cb)
    },

    getGcPolicy(): Promise<GcPolicy> {
      return request(IPC.getGcPolicy, []) as Promise<GcPolicy>
    },

    setGcPolicy(policy: GcPolicy): Promise<void> {
      return request(IPC.setGcPolicy, [policy]) as Promise<void>
    },

    getSchedulerPolicy(): Promise<SchedulerPolicy> {
      return request(IPC.getSchedulerPolicy, []) as Promise<SchedulerPolicy>
    },

    setSchedulerPolicy(policy: SchedulerPolicy): Promise<void> {
      return request(IPC.setSchedulerPolicy, [policy]) as Promise<void>
    },

    getCliStatus(): Promise<CliStatusDTO> {
      return request(IPC.getCliStatus, []) as Promise<CliStatusDTO>
    },

    getDiagnostics(): Promise<DiagnosticsDTO> {
      return request(IPC.getDiagnostics, []) as Promise<DiagnosticsDTO>
    },

    checkAgentCli(kind): Promise<AgentCliCheck> {
      return request(IPC.checkAgentCli, [kind]) as Promise<AgentCliCheck>
    },

    getSessionUsage(sessionId: string): Promise<SessionUsage> {
      return request(IPC.sessionUsage, [sessionId]) as Promise<SessionUsage>
    },

    getUsageSummary(): Promise<UsageSummary> {
      return request(IPC.usageSummary, []) as Promise<UsageSummary>
    },

    listPromptTemplates(repoId: string): Promise<PromptTemplateDTO[]> {
      return request(IPC.listPromptTemplates, [repoId]) as Promise<PromptTemplateDTO[]>
    },

    savePromptTemplate(input: {
      id?: string
      repoId: string
      name: string
      body: string
    }): Promise<PromptTemplateDTO> {
      return request(IPC.savePromptTemplate, [input]) as Promise<PromptTemplateDTO>
    },

    deletePromptTemplate(id: string): Promise<void> {
      return request(IPC.deletePromptTemplate, [id]) as Promise<void>
    },

    getSessionOutcome(sessionId: string): Promise<SessionOutcomeDTO | null> {
      return request(IPC.getSessionOutcome, [sessionId]) as Promise<SessionOutcomeDTO | null>
    },

    listSessionHistory(): Promise<SessionHistoryEntry[]> {
      return request(IPC.listSessionHistory, []) as Promise<SessionHistoryEntry[]>
    },

    getPrStatus(sessionId: string): Promise<PrStatusDTO | null> {
      return request(IPC.sessionPrStatus, [sessionId]) as Promise<PrStatusDTO | null>
    },

    listSessionAgentEvents(sessionId: string): Promise<SessionAgentEventDTO[]> {
      return request(IPC.listSessionAgentEvents, [sessionId]) as Promise<SessionAgentEventDTO[]>
    },

    onSessionAgentEvent(cb: AgentEventCb): () => void {
      agentEventListeners.add(cb)
      return () => agentEventListeners.delete(cb)
    },

    onConnectionChange(cb: ConnectionCb): () => void {
      connectionListeners.add(cb)
      return () => connectionListeners.delete(cb)
    },
  }
}

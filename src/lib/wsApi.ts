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
  RepoDTO,
  SessionStatus,
  StatusMeta,
  WriteLockState,
  SessionAgentEventDTO,
  SessionChatMessageDTO,
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
  /**
   * POST endpoint (docs/SECURITY.md §3) that exchanges the long-lived `token`
   * (sent once, as an Authorization header) for a single-use, ~10s-TTL WS
   * ticket. When set, every connect — including each scheduleReconnect()
   * retry — fetches a fresh ticket and connects with `?ticket=` instead of
   * embedding `token` in the URL. Omit to keep the legacy `?token=` URL
   * (Electron/Tailscale — see docs/SECURITY.md §3 "Rollout / scoping").
   */
  ticketUrl?: string
  /**
   * Default true. When false, createWsApi does not open the socket in its
   * constructor — the caller must invoke .connect(ticketUrl) to start
   * connecting. Lets the web boot mount the UI before the ticket-mode
   * decision resolves.
   */
  autoConnect?: boolean
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
type StatusCb = (id: string, status: SessionStatus, meta?: StatusMeta) => void
type ExitCb = (id: string, code: number) => void

export type WsApi = SlipstreamApi & {
  /**
   * Tear down this instance: stop reconnecting, remove the module-level
   * visibilitychange/online/pageshow listeners, stop the heartbeat, close the
   * socket, and reject any in-flight/queued requests. Required whenever a new
   * createWsApi() instance replaces this one (e.g. token-gate retry after an
   * auth error) — otherwise the old instance's global listeners and timers
   * live forever, holding a closure over the stale token.
   */
  destroy(): void
  /**
   * Starts the socket for an instance built with autoConnect:false; ticketUrl
   * selects ticket mode (undefined = legacy ?token=). No-op if already
   * started or destroyed.
   */
  connect(ticketUrl: string | undefined): void
}

export function createWsApi(opts: WsApiOpts): WsApi {
  const WS = opts.WebSocketCtor ?? WebSocket
  const fullUrl = `${opts.url}?token=${encodeURIComponent(opts.token)}`

  let ws: WebSocket | null = null
  let open = false
  let destroyed = false
  let started = false
  let ticketUrl = opts.ticketUrl
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
  type ChatMessageCb = (id: string, msg: SessionChatMessageDTO) => void
  const chatMessageListeners = new Set<ChatMessageCb>()
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

  // Fetches a fresh ticket (Authorization: Bearer <token>, never in the URL)
  // and connects with it. Called fresh on every connect() — including every
  // scheduleReconnect() retry — since a ticket is single-use and ~10s-TTL.
  async function connectWithTicket(): Promise<void> {
    let ticket: string
    try {
      const res = await fetch(ticketUrl!, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.token}` },
      })
      if (res.status === 401) {
        // The long-lived token itself was rejected — re-gate. This is the
        // only place ticket-mode auth failure is detected; a bad/expired/used
        // ticket surfacing later as a WS close(4001) is just treated as a
        // transient failure and retried with a fresh ticket (see onclose).
        opts.onAuthError?.()
        return
      }
      if (!res.ok) throw new Error(`ticket request failed: ${res.status}`)
      const body = (await res.json()) as { ticket: string }
      ticket = body.ticket
    } catch {
      scheduleReconnect()
      return
    }
    if (destroyed) return
    openSocket(`${opts.url}?ticket=${encodeURIComponent(ticket)}`)
  }

  function openConnection() {
    if (destroyed) return
    if (ticketUrl) {
      void connectWithTicket()
      return
    }
    openSocket(fullUrl)
  }

  function openSocket(target: string) {
    if (destroyed) return
    try {
      ws = new WS(target)
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
          const [id, status, meta] = msg.args as [string, SessionStatus, StatusMeta?]
          for (const cb of statusListeners) cb(id, status, meta)
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
        } else if (msg.channel === IPC.sessionChatMessage) {
          const [id, chatMsg] = msg.args as [string, SessionChatMessageDTO]
          for (const cb of chatMessageListeners) cb(id, chatMsg)
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

      // 4001 = auth error (server-sent close code for 401). In ticket mode
      // this means the *ticket* was bad/expired/used, not the long-lived
      // token — the token is only ever validated at the POST /rpc-ticket
      // step (see connectWithTicket), so treat it as retryable: the next
      // connect() fetches a fresh ticket, and a genuinely-bad token surfaces
      // there as a real 401 instead.
      if ((evt.code === 4001 || evt.code === 1008) && !ticketUrl) {
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
      openConnection()
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
      openConnection()
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

  function onVisibilityChange() {
    if (document.visibilityState === 'visible') onForeground()
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', onForeground)
    window.addEventListener('pageshow', onForeground)
  }

  function destroy() {
    if (destroyed) return
    destroyed = true
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', onForeground)
      window.removeEventListener('pageshow', onForeground)
    }
    stopHeartbeat()
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
    }
    open = false
    for (const [, p] of pending) {
      if (p.timer !== undefined) clearTimeout(p.timer)
      p.reject(new Error('WebSocket destroyed'))
    }
    pending.clear()
    queue.length = 0
    const socket = ws
    ws = null
    socket?.close()
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

  // Boot the connection — unless the caller opted out (autoConnect: false),
  // in which case .connect(ticketUrl) (see publicConnect below) starts it.
  if (opts.autoConnect !== false) {
    started = true
    openConnection()
  }

  function publicConnect(nextTicketUrl: string | undefined): void {
    if (destroyed || started) return
    started = true
    ticketUrl = nextTicketUrl
    openConnection()
  }

  // ── SlipstreamApi implementation ────────────────────────────────────────────

  // Generic request-forwarding factory: most SlipstreamApi methods are just
  // `(...args) => request(channel, args)`. `K` pins the return type to the
  // exact method being implemented (explicit at each call site below) so a
  // typo'd channel or a mismatched method still fails `api: SlipstreamApi`'s
  // structural check — the object literal below is what gives us the
  // compile-time completeness guarantee (every SlipstreamApi member must be
  // present with the right signature), not just a convenient shorthand.
  function wire<K extends keyof SlipstreamApi>(channel: string): SlipstreamApi[K] {
    return ((...args: unknown[]) => request(channel, args)) as SlipstreamApi[K]
  }

  // Every member of SlipstreamApi must appear here — TS enforces it via this
  // annotation. Plain request/response methods are one-liners via wire();
  // push subscriptions, fire-and-forget writes, and pickAndRegisterRepo need
  // real bodies (listener sets, drop-not-queue semantics, no wire call) and
  // are written out in full.
  const api: SlipstreamApi = {
    listRepos: wire<'listRepos'>(IPC.listRepos),

    registerRepo: wire<'registerRepo'>(IPC.registerRepo),

    registerRepoByUrl: wire<'registerRepoByUrl'>(IPC.registerRepoByUrl),

    /** Not supported on web — resolve null. Path-input fallback in SettingsModal handles repo adding. */
    pickAndRegisterRepo(): Promise<RepoDTO | null> {
      return Promise.resolve(null)
    },

    removeRepo: wire<'removeRepo'>(IPC.removeRepo),

    listTickets: wire<'listTickets'>(IPC.listTickets),

    getTicketStatus: wire<'getTicketStatus'>(IPC.getTicketStatus),

    setTicketStatus: wire<'setTicketStatus'>(IPC.setTicketStatus),

    getLinearKey: wire<'getLinearKey'>(IPC.getLinearKey),

    setLinearKey: wire<'setLinearKey'>(IPC.setLinearKey),

    getTicketSettings: wire<'getTicketSettings'>(IPC.getTicketSettings),

    setTicketSettings: wire<'setTicketSettings'>(IPC.setTicketSettings),

    listTicketScopes: wire<'listTicketScopes'>(IPC.listTicketScopes),

    getEditorConfig: wire<'getEditorConfig'>(IPC.getEditorConfig),

    setEditorConfig: wire<'setEditorConfig'>(IPC.setEditorConfig),

    getAgentArgs: wire<'getAgentArgs'>(IPC.getAgentArgs),

    setAgentArgs: wire<'setAgentArgs'>(IPC.setAgentArgs),

    openInEditor: wire<'openInEditor'>(IPC.openInEditor),

    startSession: wire<'startSession'>(IPC.startSession),

    writeSession(id: string, data: string): void {
      // Fire-and-forget: drop the frame while the socket is down instead of queuing
      // it — replaying stale keystrokes into a live PTY seconds later on reconnect
      // is worse than silently losing input the user typed while disconnected.
      if (!isOpen()) return
      const req: WireReq = { t: 'req', id: genId(), channel: IPC.writeSession, args: [id, data] }
      send(req)
    },

    syncClipboardImage: wire<'syncClipboardImage'>(IPC.syncClipboardImage),

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

    killSession: wire<'killSession'>(IPC.killSession),

    cleanupSession: wire<'cleanupSession'>(IPC.cleanupSession),

    sessionMerged: wire<'sessionMerged'>(IPC.sessionMerged),

    listSessions: wire<'listSessions'>(IPC.listSessions),

    resumeSession: wire<'resumeSession'>(IPC.resumeSession),

    attachRemoteControl: wire<'attachRemoteControl'>(IPC.attachRemoteControl),

    handoffSession: wire<'handoffSession'>(IPC.handoffSession),

    worktreeStatus: wire<'worktreeStatus'>(IPC.worktreeStatus),

    worktreeDiff: wire<'worktreeDiff'>(IPC.worktreeDiff),

    worktreeUpdateFromBase: wire<'worktreeUpdateFromBase'>(IPC.worktreeUpdateFromBase),

    getSessionBuffer: wire<'getSessionBuffer'>(IPC.getSessionBuffer),

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

    getRepoSettings: wire<'getRepoSettings'>(IPC.getRepoSettings),

    setRepoSettings: wire<'setRepoSettings'>(IPC.setRepoSettings),

    runApp: wire<'runApp'>(IPC.runApp),

    stopApp: wire<'stopApp'>(IPC.stopApp),

    appStatus: wire<'appStatus'>(IPC.appStatus),

    getVapidPublicKey: wire<'getVapidPublicKey'>(IPC.getVapidPublicKey),

    savePushSubscription: wire<'savePushSubscription'>(IPC.savePushSubscription),

    deletePushSubscription: wire<'deletePushSubscription'>(IPC.deletePushSubscription),

    getPushPrefs: wire<'getPushPrefs'>(IPC.getPushPrefs),

    saveFcmToken: wire<'saveFcmToken'>(IPC.saveFcmToken),

    deleteFcmToken: wire<'deleteFcmToken'>(IPC.deleteFcmToken),

    getGitToken: wire<'getGitToken'>(IPC.getGitToken),

    setGitToken: wire<'setGitToken'>(IPC.setGitToken),

    listGitProviders: wire<'listGitProviders'>(IPC.listGitProviders),

    getGitHostConfig: wire<'getGitHostConfig'>(IPC.getGitHostConfig),

    setGitHostConfig: wire<'setGitHostConfig'>(IPC.setGitHostConfig),

    onSessionPr(cb: (id: string, prUrl: string) => void): () => void {
      prListeners.add(cb)
      return () => prListeners.delete(cb)
    },

    attachSession: wire<'attachSession'>(IPC.attachSession),

    detachSession(id: string): void {
      // Fire-and-forget: drop the frame while the socket is down instead of queuing
      // it — the server already discards all per-client attach state on disconnect,
      // so replaying a detach on reconnect is pointless.
      if (!isOpen()) return
      const req: WireReq = { t: 'req', id: genId(), channel: IPC.detachSession, args: [id] }
      send(req)
    },

    takeWrite: wire<'takeWrite'>(IPC.takeWrite),

    onSessionWriteLock(cb: WriteLockCb): () => void {
      writeLockListeners.add(cb)
      return () => writeLockListeners.delete(cb)
    },

    getGcPolicy: wire<'getGcPolicy'>(IPC.getGcPolicy),

    setGcPolicy: wire<'setGcPolicy'>(IPC.setGcPolicy),

    getSchedulerPolicy: wire<'getSchedulerPolicy'>(IPC.getSchedulerPolicy),

    setSchedulerPolicy: wire<'setSchedulerPolicy'>(IPC.setSchedulerPolicy),

    getCliStatus: wire<'getCliStatus'>(IPC.getCliStatus),

    getDiagnostics: wire<'getDiagnostics'>(IPC.getDiagnostics),

    checkAgentCli: wire<'checkAgentCli'>(IPC.checkAgentCli),

    // Wire channel names historically diverge from their SlipstreamApi method
    // name for these three — the override lives in the explicit IPC.x argument.
    getSessionUsage: wire<'getSessionUsage'>(IPC.sessionUsage),

    getUsageSummary: wire<'getUsageSummary'>(IPC.usageSummary),

    listPromptTemplates: wire<'listPromptTemplates'>(IPC.listPromptTemplates),

    savePromptTemplate: wire<'savePromptTemplate'>(IPC.savePromptTemplate),

    deletePromptTemplate: wire<'deletePromptTemplate'>(IPC.deletePromptTemplate),

    getSessionOutcome: wire<'getSessionOutcome'>(IPC.getSessionOutcome),

    listSessionHistory: wire<'listSessionHistory'>(IPC.listSessionHistory),

    getPrStatus: wire<'getPrStatus'>(IPC.sessionPrStatus),

    listSessionAgentEvents: wire<'listSessionAgentEvents'>(IPC.listSessionAgentEvents),

    onSessionAgentEvent(cb: AgentEventCb): () => void {
      agentEventListeners.add(cb)
      return () => agentEventListeners.delete(cb)
    },

    getChatMessages: wire<'getChatMessages'>(IPC.getChatMessages),

    onChatMessage(cb: ChatMessageCb): () => void {
      chatMessageListeners.add(cb)
      return () => chatMessageListeners.delete(cb)
    },

    subscribeChat: wire<'subscribeChat'>(IPC.subscribeChat),

    unsubscribeChat: wire<'unsubscribeChat'>(IPC.unsubscribeChat),

    listAgentSkills: wire<'listAgentSkills'>(IPC.listAgentSkills),

    getChatQuestion: wire<'getChatQuestion'>(IPC.getChatQuestion),

    onConnectionChange(cb: ConnectionCb): () => void {
      connectionListeners.add(cb)
      return () => connectionListeners.delete(cb)
    },
  }

  return { ...api, destroy, connect: publicConnect }
}

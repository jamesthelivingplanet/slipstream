/**
 * WebSocket-backed FlotillaApi client.
 *
 * createWsApi({ url, token }) returns a FlotillaApi that talks to the headless
 * WebSocket server via the wire protocol defined in electron/shared/wire.ts.
 *
 * Framework-free (plain TS) — unit-testable against a fake WebSocket.
 */

import type { FlotillaApi, RepoDTO, SessionDTO, TicketDTO, SessionStatus } from '../../electron/shared/contract.js'
import type { WireReq, WireRes, WirePush } from '../../electron/shared/wire.js'
import { IPC } from '../../electron/shared/contract.js'

const REQUEST_TIMEOUT_MS = 30_000
const RECONNECT_DELAYS = [500, 1000, 2000, 5000, 10000]

export interface WsApiOpts {
  url: string   // e.g. ws://host:port/rpc
  token: string
  /** Override WebSocket constructor (for tests). */
  WebSocketCtor?: typeof WebSocket
  /** Called when the server rejects with 401 (close code 4001 or initial open error). */
  onAuthError?: () => void
}

type PendingReq = {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type DataCb = (id: string, data: string) => void
type StatusCb = (id: string, status: SessionStatus) => void

export function createWsApi(opts: WsApiOpts): FlotillaApi {
  const WS = opts.WebSocketCtor ?? WebSocket
  const fullUrl = `${opts.url}?token=${encodeURIComponent(opts.token)}`

  let ws: WebSocket | null = null
  let open = false
  let destroyed = false
  let reconnectAttempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  // In-flight request map
  const pending = new Map<string, PendingReq>()

  // Queue for requests issued before the socket opens
  const queue: WireReq[] = []

  // Push listeners
  const dataListeners = new Set<DataCb>()
  const statusListeners = new Set<StatusCb>()

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
      }
      queue.length = 0
    }

    ws.onmessage = (evt: MessageEvent) => {
      let msg: WireRes | WirePush
      try {
        msg = JSON.parse(evt.data as string)
      } catch {
        return
      }

      if (msg.t === 'res') {
        const p = pending.get(msg.id)
        if (!p) return
        pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.ok) {
          p.resolve(msg.result)
        } else {
          p.reject(new Error(msg.error))
        }
      } else if (msg.t === 'push') {
        if (msg.channel === IPC.sessionData) {
          const [id, chunk] = msg.args as [string, string]
          for (const cb of dataListeners) cb(id, chunk)
        } else if (msg.channel === IPC.sessionStatus) {
          const [id, status] = msg.args as [string, SessionStatus]
          for (const cb of statusListeners) cb(id, status)
        }
      }
    }

    ws.onclose = (evt: CloseEvent) => {
      open = false
      // Reject all in-flight requests
      for (const [, p] of pending) {
        clearTimeout(p.timer)
        p.reject(new Error('WebSocket closed'))
      }
      pending.clear()

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
      reconnectTimer = null
      connect()
    }, delay)
  }

  function send(req: WireReq): void {
    if (open && ws && ws.readyState === WS.OPEN) {
      ws.send(JSON.stringify(req))
    } else {
      queue.push(req)
    }
  }

  function request(channel: string, args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID()
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Request timed out: ${channel}`))
      }, REQUEST_TIMEOUT_MS)
      pending.set(id, { resolve, reject, timer })
      send({ t: 'req', id, channel, args })
    })
  }

  // Boot the connection
  connect()

  // ── FlotillaApi implementation ────────────────────────────────────────────

  return {
    listRepos(): Promise<RepoDTO[]> {
      return request(IPC.listRepos, []) as Promise<RepoDTO[]>
    },

    registerRepo(absPath: string): Promise<RepoDTO> {
      return request(IPC.registerRepo, [absPath]) as Promise<RepoDTO>
    },

    /** Not supported on web — resolve null. Path-input fallback in SettingsModal handles repo adding. */
    pickAndRegisterRepo(): Promise<RepoDTO | null> {
      return Promise.resolve(null)
    },

    removeRepo(id: string): Promise<void> {
      return request(IPC.removeRepo, [id]) as Promise<void>
    },

    listTickets(): Promise<TicketDTO[]> {
      return request(IPC.listTickets, []) as Promise<TicketDTO[]>
    },

    startSession(input: { tid: string; title: string; prompt: string; repoId: string }): Promise<SessionDTO> {
      return request(IPC.startSession, [input]) as Promise<SessionDTO>
    },

    writeSession(id: string, data: string): void {
      // Fire-and-forget: send but don't await
      const req: WireReq = { t: 'req', id: crypto.randomUUID(), channel: IPC.writeSession, args: [id, data] }
      send(req)
    },

    resizeSession(id: string, cols: number, rows: number): void {
      // Fire-and-forget
      const req: WireReq = { t: 'req', id: crypto.randomUUID(), channel: IPC.resizeSession, args: [id, cols, rows] }
      send(req)
    },

    killSession(id: string): Promise<void> {
      return request(IPC.killSession, [id]) as Promise<void>
    },

    cleanupSession(id: string, opts?: { force?: boolean }): Promise<{ removed: boolean; reason?: string }> {
      return request(IPC.cleanupSession, [id, opts]) as Promise<{ removed: boolean; reason?: string }>
    },

    onSessionData(cb: DataCb): () => void {
      dataListeners.add(cb)
      return () => dataListeners.delete(cb)
    },

    onSessionStatus(cb: StatusCb): () => void {
      statusListeners.add(cb)
      return () => statusListeners.delete(cb)
    },
  }
}

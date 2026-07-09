/**
 * Unit tests for wsApi — exercised against a fake WebSocket so no real network
 * connection is made. Covers:
 *  - request/response correlation by id
 *  - error rejection on ok:false
 *  - push frames invoking onSessionData / onSessionStatus callbacks
 *  - unsubscribe stops push delivery
 *  - pre-open requests queue and flush on open
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createWsApi } from './wsApi.js'
import type { WireRes, WirePush } from '../../electron/shared/wire.js'
import { IPC } from '../../electron/shared/contract.js'

// Mirrors the private constants in wsApi.ts (not exported — kept as an implementation
// detail). Keep these in sync if the module's timing constants change.
const REQUEST_TIMEOUT_MS = 30_000
const HEARTBEAT_INTERVAL_MS = 15_000
const PONG_TIMEOUT_MS = 10_000

// ─── Fake WebSocket ───────────────────────────────────────────────────────────

type WsEventHandler = (evt: { data?: string; code?: number; reason?: string }) => void

interface FakeWsInstance {
  readyState: number
  url: string
  sentMessages: string[]
  onopen: WsEventHandler | null
  onmessage: WsEventHandler | null
  onclose: WsEventHandler | null
  onerror: WsEventHandler | null
  send(data: string): void
  close(): void
  /** Test helper: simulate the socket opening. */
  simulateOpen(): void
  /** Test helper: simulate a message from the server. */
  simulateMessage(msg: WireRes | WirePush): void
  /** Test helper: simulate a clean close. */
  simulateClose(code?: number): void
}

let lastFakeWs: FakeWsInstance | null = null

function makeFakeWebSocket() {
  class FakeWebSocket {
    static OPEN = 1
    static CONNECTING = 0
    static CLOSED = 3
    readyState = 0 // CONNECTING
    url: string
    sentMessages: string[] = []
    onopen: WsEventHandler | null = null
    onmessage: WsEventHandler | null = null
    onclose: WsEventHandler | null = null
    onerror: WsEventHandler | null = null

    constructor(url: string) {
      this.url = url
      lastFakeWs = this as unknown as FakeWsInstance
    }

    send(data: string) {
      this.sentMessages.push(data)
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED
      this.onclose?.({ code: 1000, reason: '' })
    }

    simulateOpen() {
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.({})
    }

    simulateMessage(msg: WireRes | WirePush) {
      this.onmessage?.({ data: JSON.stringify(msg) })
    }

    simulateClose(code = 1000) {
      this.readyState = FakeWebSocket.CLOSED
      this.onclose?.({ code, reason: '' })
    }
  }
  return FakeWebSocket as unknown as typeof WebSocket
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getWs(): FakeWsInstance {
  if (!lastFakeWs) throw new Error('No fake WebSocket was created')
  return lastFakeWs
}

function openWs(): FakeWsInstance {
  const ws = getWs()
  ws.simulateOpen()
  return ws
}

/** Parse the last sent WireReq from the fake socket. */
function lastSent(ws: FakeWsInstance) {
  const raw = ws.sentMessages.at(-1)
  if (!raw) throw new Error('No messages sent')
  return JSON.parse(raw)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('wsApi', () => {
  let FakeWS: typeof WebSocket

  beforeEach(() => {
    lastFakeWs = null
    FakeWS = makeFakeWebSocket()
  })

  it('connects with token in URL', () => {
    createWsApi({ url: 'ws://localhost:9000/rpc', token: 'mytoken', WebSocketCtor: FakeWS })
    expect(getWs().url).toBe('ws://localhost:9000/rpc?token=mytoken')
  })

  it('encodes special chars in the token', () => {
    createWsApi({ url: 'ws://localhost:9000/rpc', token: 'tok en+x=1', WebSocketCtor: FakeWS })
    expect(getWs().url).toBe('ws://localhost:9000/rpc?token=tok%20en%2Bx%3D1')
  })

  describe('request/response correlation', () => {
    it('resolves with result when ok:true', async () => {
      const api = createWsApi({ url: 'ws://localhost/rpc', token: 't', WebSocketCtor: FakeWS })
      const ws = openWs()

      const promise = api.listRepos()
      const req = lastSent(ws)
      expect(req.t).toBe('req')
      expect(req.channel).toBe(IPC.listRepos)

      ws.simulateMessage({ t: 'res', id: req.id, ok: true, result: [{ id: 'r1' }] })
      const result = await promise
      expect(result).toEqual([{ id: 'r1' }])
    })

    it('rejects with error message when ok:false', async () => {
      const api = createWsApi({ url: 'ws://localhost/rpc', token: 't', WebSocketCtor: FakeWS })
      const ws = openWs()

      const promise = api.listTickets()
      const req = lastSent(ws)

      ws.simulateMessage({ t: 'res', id: req.id, ok: false, error: 'not found' })
      await expect(promise).rejects.toThrow('not found')
    })

    it('ignores responses with unknown ids', async () => {
      const api = createWsApi({ url: 'ws://localhost/rpc', token: 't', WebSocketCtor: FakeWS })
      const ws = openWs()

      const promise = api.listRepos()
      const req = lastSent(ws)

      // Send a response for a different id — should NOT resolve our promise
      ws.simulateMessage({ t: 'res', id: 'unknown-id-xyz', ok: true, result: [] })

      // Now resolve with the real id
      ws.simulateMessage({ t: 'res', id: req.id, ok: true, result: [{ id: 'real' }] })
      const result = await promise
      expect(result).toEqual([{ id: 'real' }])
    })
  })

  describe('push frames', () => {
    it('delivers session:data to onSessionData callbacks (with seq)', () => {
      const api = createWsApi({ url: 'ws://localhost/rpc', token: 't', WebSocketCtor: FakeWS })
      const ws = openWs()

      const received: [string, string, number][] = []
      api.onSessionData((id, data, seq) => received.push([id, data, seq]))

      ws.simulateMessage({ t: 'push', channel: IPC.sessionData, args: ['sess-1', 'hello\r\n', 7] })
      expect(received).toEqual([['sess-1', 'hello\r\n', 7]])
    })

    it('delivers session:status to onSessionStatus callbacks', () => {
      const api = createWsApi({ url: 'ws://localhost/rpc', token: 't', WebSocketCtor: FakeWS })
      const ws = openWs()

      const received: [string, string][] = []
      api.onSessionStatus((id, status) => received.push([id, status]))

      ws.simulateMessage({ t: 'push', channel: IPC.sessionStatus, args: ['sess-2', 'done'] })
      expect(received).toEqual([['sess-2', 'done']])
    })

    it('delivers session:exit to onSessionExit callbacks', () => {
      const api = createWsApi({ url: 'ws://localhost/rpc', token: 't', WebSocketCtor: FakeWS })
      const ws = openWs()

      const received: [string, number][] = []
      api.onSessionExit((id, code) => received.push([id, code]))

      ws.simulateMessage({ t: 'push', channel: IPC.sessionExit, args: ['sess-4', 0] })
      expect(received).toEqual([['sess-4', 0]])
    })

    it('unsubscribe stops session:exit delivery', () => {
      const api = createWsApi({ url: 'ws://localhost/rpc', token: 't', WebSocketCtor: FakeWS })
      const ws = openWs()

      const received: [string, number][] = []
      const unsub = api.onSessionExit((id, code) => received.push([id, code]))

      ws.simulateMessage({ t: 'push', channel: IPC.sessionExit, args: ['sess-4', 0] })
      unsub()
      ws.simulateMessage({ t: 'push', channel: IPC.sessionExit, args: ['sess-4', 1] })

      expect(received).toEqual([['sess-4', 0]])
    })

    it('delivers session:pr to onSessionPr callbacks', () => {
      const api = createWsApi({ url: 'ws://localhost/rpc', token: 't', WebSocketCtor: FakeWS })
      const ws = openWs()

      const received: [string, string][] = []
      api.onSessionPr((id, prUrl) => received.push([id, prUrl]))

      ws.simulateMessage({
        t: 'push',
        channel: IPC.sessionPr,
        args: ['sess-3', 'https://example.com/mr/1'],
      })
      expect(received).toEqual([['sess-3', 'https://example.com/mr/1']])
    })

    it('unsubscribe stops push delivery', () => {
      const api = createWsApi({ url: 'ws://localhost/rpc', token: 't', WebSocketCtor: FakeWS })
      const ws = openWs()

      const received: string[] = []
      const unsub = api.onSessionData((id, _data, _seq) => received.push(id))

      ws.simulateMessage({ t: 'push', channel: IPC.sessionData, args: ['s1', 'a', 1] })
      unsub()
      ws.simulateMessage({ t: 'push', channel: IPC.sessionData, args: ['s1', 'b', 2] })

      expect(received).toEqual(['s1']) // only first delivery
    })

    it('multiple subscribers all receive the push', () => {
      const api = createWsApi({ url: 'ws://localhost/rpc', token: 't', WebSocketCtor: FakeWS })
      const ws = openWs()

      const a: string[] = []
      const b: string[] = []
      api.onSessionData((id) => a.push(id))
      api.onSessionData((id) => b.push(id))

      ws.simulateMessage({ t: 'push', channel: IPC.sessionData, args: ['s1', 'x', 1] })
      expect(a).toEqual(['s1'])
      expect(b).toEqual(['s1'])
    })

    it('delivers session:writeLock to onSessionWriteLock callbacks', () => {
      const api = createWsApi({ url: 'ws://localhost/rpc', token: 't', WebSocketCtor: FakeWS })
      const ws = openWs()

      const received: unknown[] = []
      api.onSessionWriteLock((state) => received.push(state))

      ws.simulateMessage({
        t: 'push',
        channel: IPC.sessionWriteLock,
        args: [{ sessionId: 'sess-1', canWrite: false, viewers: 2 }],
      })
      expect(received).toEqual([{ sessionId: 'sess-1', canWrite: false, viewers: 2 }])
    })

    it('getSessionBuffer sends a request on session:buffer and resolves result', async () => {
      const api = createWsApi({ url: 'ws://localhost/rpc', token: 't', WebSocketCtor: FakeWS })
      const ws = openWs()

      const promise = api.getSessionBuffer('sess-abc')
      const req = lastSent(ws)
      expect(req.t).toBe('req')
      expect(req.channel).toBe(IPC.getSessionBuffer)
      expect(req.args).toEqual(['sess-abc'])

      ws.simulateMessage({
        t: 'res',
        id: req.id,
        ok: true,
        result: { data: 'prior output', seq: 12 },
      })
      const result = await promise
      expect(result).toEqual({ data: 'prior output', seq: 12 })
    })
  })

  describe('request queueing before open', () => {
    it('queues requests and flushes them when the socket opens', async () => {
      const api = createWsApi({ url: 'ws://localhost/rpc', token: 't', WebSocketCtor: FakeWS })
      const ws = getWs()

      // Issue request BEFORE open
      expect(ws.sentMessages.length).toBe(0)
      const promise = api.listRepos()

      // Still not sent — socket not open yet
      expect(ws.sentMessages.length).toBe(0)

      // Now open
      ws.simulateOpen()
      // Should have been flushed
      expect(ws.sentMessages.length).toBe(1)
      const req = lastSent(ws)
      expect(req.channel).toBe(IPC.listRepos)

      ws.simulateMessage({ t: 'res', id: req.id, ok: true, result: [] })
      await expect(promise).resolves.toEqual([])
    })

    it('can queue multiple requests and flush all', async () => {
      const api = createWsApi({ url: 'ws://localhost/rpc', token: 't', WebSocketCtor: FakeWS })
      const ws = getWs()

      const p1 = api.listRepos()
      const p2 = api.listTickets()
      expect(ws.sentMessages.length).toBe(0)

      ws.simulateOpen()
      expect(ws.sentMessages.length).toBe(2)

      const [req1, req2] = ws.sentMessages.map((m) => JSON.parse(m))
      ws.simulateMessage({ t: 'res', id: req1.id, ok: true, result: [] })
      ws.simulateMessage({ t: 'res', id: req2.id, ok: true, result: [] })

      await expect(p1).resolves.toEqual([])
      await expect(p2).resolves.toEqual([])
    })
  })

  describe('pickAndRegisterRepo', () => {
    it('resolves null without touching the wire', async () => {
      const api = createWsApi({ url: 'ws://localhost/rpc', token: 't', WebSocketCtor: FakeWS })
      const ws = openWs()
      const result = await api.pickAndRegisterRepo()
      expect(result).toBeNull()
      // No wire message sent for this call
      expect(ws.sentMessages.length).toBe(0)
    })
  })

  describe('fire-and-forget methods', () => {
    it('writeSession sends a WireReq but returns void when the socket is open', () => {
      const api = createWsApi({ url: 'ws://localhost/rpc', token: 't', WebSocketCtor: FakeWS })
      const ws = openWs()
      const ret = api.writeSession('sess-1', 'input data')
      expect(ret).toBeUndefined()
      const req = lastSent(ws)
      expect(req.t).toBe('req')
      expect(req.channel).toBe(IPC.writeSession)
      expect(req.args).toEqual(['sess-1', 'input data'])
    })

    it('writeSession drops the frame (does not queue) while the socket is down', () => {
      const api = createWsApi({ url: 'ws://localhost/rpc', token: 't', WebSocketCtor: FakeWS })
      const ws = getWs()
      // Socket never opened — writeSession must drop, not queue, stale input.
      api.writeSession('sess-1', 'stale keystrokes')
      expect(ws.sentMessages.length).toBe(0)

      // Opening the socket later must NOT flush a writeSession frame — it was dropped,
      // not queued.
      ws.simulateOpen()
      expect(ws.sentMessages.some((m) => JSON.parse(m).channel === IPC.writeSession)).toBe(false)
    })

    it('resizeSession sends a WireReq but returns void', () => {
      const api = createWsApi({ url: 'ws://localhost/rpc', token: 't', WebSocketCtor: FakeWS })
      const ws = openWs()
      api.resizeSession('sess-1', 80, 24)
      const req = lastSent(ws)
      expect(req.channel).toBe(IPC.resizeSession)
      expect(req.args).toEqual(['sess-1', 80, 24])
    })

    it('detachSession sends a WireReq when the socket is open', () => {
      const api = createWsApi({ url: 'ws://localhost/rpc', token: 't', WebSocketCtor: FakeWS })
      const ws = openWs()
      api.detachSession('sess-1')
      const req = lastSent(ws)
      expect(req.channel).toBe(IPC.detachSession)
      expect(req.args).toEqual(['sess-1'])
    })
  })

  describe('close handling', () => {
    it('rejects in-flight requests when the socket closes', async () => {
      const api = createWsApi({ url: 'ws://localhost/rpc', token: 't', WebSocketCtor: FakeWS })
      const ws = openWs()

      const promise = api.listRepos()
      // Close without responding
      ws.simulateClose(1001)

      await expect(promise).rejects.toThrow('WebSocket closed')
    })
  })

  describe('reconnect must not replay orphaned frames', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('rejects a request made while disconnected and never sends its frame after a later reconnect', async () => {
      vi.useFakeTimers()
      const api = createWsApi({ url: 'ws://localhost/rpc', token: 't', WebSocketCtor: FakeWS })
      const ws1 = getWs()
      ws1.simulateOpen()
      ws1.simulateClose(1006) // connection drops → reconnect scheduled (500ms backoff)

      // Issued while down: goes into the queue (and pending map), nothing on the wire.
      const promise = api.startSession({ tid: 't1', title: 'T', prompt: 'p', repoId: 'r1' })
      const rejection = expect(promise).rejects.toThrow('WebSocket closed')

      // First reconnect attempt fails — its onclose rejects the pending request.
      await vi.advanceTimersByTimeAsync(500)
      const ws2 = getWs()
      expect(ws2).not.toBe(ws1)
      ws2.simulateClose(1006)
      await rejection // the caller has already seen the error

      // Second reconnect attempt (1000ms backoff) succeeds.
      await vi.advanceTimersByTimeAsync(1000)
      const ws3 = getWs()
      expect(ws3).not.toBe(ws2)
      ws3.simulateOpen()

      // Regression guard: the orphaned frame must NOT be flushed to the server —
      // its caller was already rejected, so replaying it would create work (e.g. a
      // ghost session) nobody is tracking.
      expect(ws3.sentMessages.map((m) => JSON.parse(m).channel)).not.toContain(IPC.startSession)
      expect(ws3.sentMessages.length).toBe(0)
    })

    it('resizeSession while disconnected sends nothing after reconnect', async () => {
      vi.useFakeTimers()
      const api = createWsApi({ url: 'ws://localhost/rpc', token: 't', WebSocketCtor: FakeWS })
      const ws1 = getWs()
      ws1.simulateOpen()
      ws1.simulateClose(1006)

      api.resizeSession('sess-1', 80, 24) // dropped, not queued

      await vi.advanceTimersByTimeAsync(500)
      const ws2 = getWs()
      ws2.simulateOpen()
      expect(ws2.sentMessages.length).toBe(0)
    })

    it('detachSession while disconnected sends nothing after reconnect', async () => {
      vi.useFakeTimers()
      const api = createWsApi({ url: 'ws://localhost/rpc', token: 't', WebSocketCtor: FakeWS })
      const ws1 = getWs()
      ws1.simulateOpen()
      ws1.simulateClose(1006)

      api.detachSession('sess-1') // dropped, not queued

      await vi.advanceTimersByTimeAsync(500)
      const ws2 = getWs()
      ws2.simulateOpen()
      expect(ws2.sentMessages.length).toBe(0)
    })
  })

  describe('auth error', () => {
    it('calls onAuthError when close code is 4001', () => {
      const onAuthError = vi.fn()
      createWsApi({ url: 'ws://localhost/rpc', token: 'bad', WebSocketCtor: FakeWS, onAuthError })
      const ws = getWs()
      ws.simulateOpen()
      ws.simulateClose(4001)
      expect(onAuthError).toHaveBeenCalledOnce()
    })
  })

  describe('request timeout starts on send, not on queue', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('does not time out a queued request during reconnect backoff, only after it is actually sent', async () => {
      vi.useFakeTimers()
      const api = createWsApi({ url: 'ws://localhost/rpc', token: 't', WebSocketCtor: FakeWS })
      const ws = getWs()

      let rejected = false
      let resolved = false
      const promise = api.listRepos()
      promise.then(
        () => {
          resolved = true
        },
        () => {
          rejected = true
        },
      )

      // Not open yet — request sits in the queue. Advance well past the timeout: it
      // must NOT reject, because the timer hasn't started yet.
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 5_000)
      expect(rejected).toBe(false)
      expect(resolved).toBe(false)
      expect(ws.sentMessages.length).toBe(0)

      // Now open — the queued frame flushes and the timer arms at this point.
      ws.simulateOpen()
      expect(ws.sentMessages.length).toBe(1)

      // Answer heartbeat pings along the way so the pong-timeout doesn't close the
      // socket first — this test isolates the per-request timeout only.
      let answeredUpTo = ws.sentMessages.length
      let elapsed = 0
      const step = 1_000
      while (elapsed < REQUEST_TIMEOUT_MS + 1) {
        await vi.advanceTimersByTimeAsync(step)
        elapsed += step
        for (; answeredUpTo < ws.sentMessages.length; answeredUpTo++) {
          if (JSON.parse(ws.sentMessages[answeredUpTo]).t === 'ping') {
            ws.simulateMessage({ t: 'pong' } as unknown as WireRes)
          }
        }
      }
      expect(rejected).toBe(true)
      await expect(promise).rejects.toThrow(/timed out/)
    })
  })

  describe('heartbeat', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('sends a ping after HEARTBEAT_INTERVAL_MS and closes the socket if no pong arrives', async () => {
      vi.useFakeTimers()
      createWsApi({ url: 'ws://localhost/rpc', token: 't', WebSocketCtor: FakeWS })
      const ws = openWs()
      ws.sentMessages.length = 0

      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
      const ping = JSON.parse(ws.sentMessages.at(-1)!)
      expect(ping).toEqual({ t: 'ping' })
      expect(ws.readyState).not.toBe(3) // not yet closed

      await vi.advanceTimersByTimeAsync(PONG_TIMEOUT_MS)
      expect(ws.readyState).toBe(3) // CLOSED — no pong arrived in time
    })

    it('does not close the socket when a pong arrives before the pong timeout', async () => {
      vi.useFakeTimers()
      createWsApi({ url: 'ws://localhost/rpc', token: 't', WebSocketCtor: FakeWS })
      const ws = openWs()

      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
      ws.simulateMessage({ t: 'pong' } as unknown as WireRes)

      await vi.advanceTimersByTimeAsync(PONG_TIMEOUT_MS)
      expect(ws.readyState).not.toBe(3)
    })
  })
})

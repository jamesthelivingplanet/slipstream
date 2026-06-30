/**
 * Unit tests for wsApi — exercised against a fake WebSocket so no real network
 * connection is made. Covers:
 *  - request/response correlation by id
 *  - error rejection on ok:false
 *  - push frames invoking onSessionData / onSessionStatus callbacks
 *  - unsubscribe stops push delivery
 *  - pre-open requests queue and flush on open
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createWsApi } from './wsApi.js'
import type { WireRes, WirePush } from '../../electron/shared/wire.js'
import { IPC } from '../../electron/shared/contract.js'

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

    it('delivers session:pr to onSessionPr callbacks', () => {
      const api = createWsApi({ url: 'ws://localhost/rpc', token: 't', WebSocketCtor: FakeWS })
      const ws = openWs()

      const received: [string, string][] = []
      api.onSessionPr((id, prUrl) => received.push([id, prUrl]))

      ws.simulateMessage({ t: 'push', channel: IPC.sessionPr, args: ['sess-3', 'https://example.com/mr/1'] })
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

    it('getSessionBuffer sends a request on session:buffer and resolves result', async () => {
      const api = createWsApi({ url: 'ws://localhost/rpc', token: 't', WebSocketCtor: FakeWS })
      const ws = openWs()

      const promise = api.getSessionBuffer('sess-abc')
      const req = lastSent(ws)
      expect(req.t).toBe('req')
      expect(req.channel).toBe(IPC.getSessionBuffer)
      expect(req.args).toEqual(['sess-abc'])

      ws.simulateMessage({ t: 'res', id: req.id, ok: true, result: { data: 'prior output', seq: 12 } })
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
    it('writeSession sends a WireReq but returns void', () => {
      const api = createWsApi({ url: 'ws://localhost/rpc', token: 't', WebSocketCtor: FakeWS })
      const ws = openWs()
      const ret = api.writeSession('sess-1', 'input data')
      expect(ret).toBeUndefined()
      const req = lastSent(ws)
      expect(req.t).toBe('req')
      expect(req.channel).toBe(IPC.writeSession)
      expect(req.args).toEqual(['sess-1', 'input data'])
    })

    it('resizeSession sends a WireReq but returns void', () => {
      const api = createWsApi({ url: 'ws://localhost/rpc', token: 't', WebSocketCtor: FakeWS })
      const ws = openWs()
      api.resizeSession('sess-1', 80, 24)
      const req = lastSent(ws)
      expect(req.channel).toBe(IPC.resizeSession)
      expect(req.args).toEqual(['sess-1', 80, 24])
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
})

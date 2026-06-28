import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import http from 'node:http'
import { createServer } from './server.js'
import type { IpcDeps } from '../ipc.js'
import type {
  RepoDTO,
  IRepoRegistry,
  IWorktreeManager,
  ISessionManager,
  IPortBroker,
  ITicketProvider,
  ISessionStore,
} from '../shared/contract.js'
import { IPC } from '../shared/contract.js'
import { WebSocket } from 'ws'
import type { WireReq, WireRes } from '../shared/wire.js'
import type { IConfigStore } from '../services/configStore.js'
import type { IPushService } from '../services/pushService.js'

// ── Fake deps (no native modules) ────────────────────────────────────────────

function makeRepo(): RepoDTO {
  return { id: 'r1', org: 'acme', name: 'api', base: 'main', path: '/repos/api' }
}

function makeFakeDeps(): IpcDeps {
  const sessionListeners: Record<string, ((...args: unknown[]) => void)[]> = {}

  const sessions: ISessionManager = {
    start: vi.fn(),
    resume: vi.fn(),
    attachRemoteControl: vi.fn(),
    has: vi.fn().mockReturnValue(false),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    killAll: vi.fn(),
    getBuffer: vi.fn().mockReturnValue({ data: '', seq: 0 }),
    setOpencodeSid: vi.fn(),
    on(event: string, listener: (...args: unknown[]) => void) {
      sessionListeners[event] ??= []
      sessionListeners[event].push(listener)
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      if (sessionListeners[event]) {
        sessionListeners[event] = sessionListeners[event].filter((l) => l !== listener)
      }
    },
  }

  const repos: IRepoRegistry = {
    list: vi.fn().mockResolvedValue([makeRepo()]),
    register: vi.fn().mockResolvedValue(makeRepo()),
    get: vi.fn().mockResolvedValue(makeRepo()),
    resolvePath: vi.fn().mockResolvedValue(makeRepo()),
    remove: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({ installCmd: '', startCmd: '' }),
    setSettings: vi.fn().mockResolvedValue(undefined),
  }

  const worktrees: IWorktreeManager = {
    pathFor: vi.fn().mockReturnValue('/wt/branch'),
    create: vi.fn().mockResolvedValue({ branch: 'b', path: '/wt/b', dirty: false, ahead: 0, behind: 0, added: 0, deleted: 0 }),
    remove: vi.fn().mockResolvedValue({ removed: true }),
    status: vi.fn().mockResolvedValue({ branch: 'b', path: '/wt/b', dirty: false, ahead: 0, behind: 0, added: 0, deleted: 0 }),
    list: vi.fn().mockResolvedValue([]),
  }

  const ports: IPortBroker = { claim: vi.fn().mockResolvedValue(3000) }

  const tickets: ITicketProvider = {
    id: 'test',
    listTickets: vi.fn().mockResolvedValue([]),
    getTicketStatus: vi.fn().mockResolvedValue({ current: null, available: [] }),
    setTicketStatus: vi.fn().mockRejectedValue(new Error('not implemented')),
    startTicket: vi.fn().mockResolvedValue(null),
    resetTicket: vi.fn().mockResolvedValue(null),
  }

  const config: IConfigStore = {
    get: vi.fn().mockReturnValue(undefined),
    set: vi.fn(),
  }

  const editor = { open: vi.fn().mockResolvedValue(undefined) }

  const sessionStoreMap = new Map()
  const sessionStore: ISessionStore = {
    list() { return Array.from(sessionStoreMap.values()) },
    get(id) { return sessionStoreMap.get(id) },
    upsert(s) { sessionStoreMap.set(s.id, s) },
    delete(id) { sessionStoreMap.delete(id) },
  }

  const push: IPushService = {
    getVapidPublicKey: vi.fn().mockResolvedValue('test-vapid-key'),
    savePushSubscription: vi.fn().mockResolvedValue(undefined),
    deletePushSubscription: vi.fn().mockResolvedValue(undefined),
    getPushPrefs: vi.fn().mockResolvedValue(null),
  }

  return { repos, worktrees, sessions, ports, tickets, config, sessionStore, editor, appRunner: { run: vi.fn().mockResolvedValue({ pid: 1234 }) }, push }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getPort(server: http.Server): number {
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('unexpected address')
  return addr.port
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
}

function wsConnect(port: number, token?: string): WebSocket {
  const url = token
    ? `ws://127.0.0.1:${port}/rpc?token=${encodeURIComponent(token)}`
    : `ws://127.0.0.1:${port}/rpc`
  return new WebSocket(url)
}

function sendReq(ws: WebSocket, channel: string, args: unknown[] = []): Promise<WireRes> {
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2)
    const req: WireReq = { t: 'req', id, channel, args }

    ws.once('message', (raw) => {
      try {
        const res = JSON.parse(String(raw)) as WireRes
        resolve(res)
      } catch (e) {
        reject(e)
      }
    })

    ws.send(JSON.stringify(req))
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createServer', () => {
  let server: http.Server | undefined

  afterEach(async () => {
    if (server) {
      await closeServer(server)
      server = undefined
    }
  })

  it('refuses to connect without token (query param)', async () => {
    const deps = makeFakeDeps()
    server = createServer(deps, { token: 'secret', port: 0 })
    const port = await new Promise<number>((res) => server!.once('listening', () => res(getPort(server!))))

    const ws = wsConnect(port) // no token
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve())
      ws.once('error', () => resolve())
    })
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('refuses to connect with wrong token', async () => {
    const deps = makeFakeDeps()
    server = createServer(deps, { token: 'secret', port: 0 })
    const port = await new Promise<number>((res) => server!.once('listening', () => res(getPort(server!))))

    const ws = wsConnect(port, 'wrong-token')
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve())
      ws.once('error', () => resolve())
    })
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('accepts a connection with the correct token', async () => {
    const deps = makeFakeDeps()
    server = createServer(deps, { token: 'secret', port: 0 })
    const port = await new Promise<number>((res) => server!.once('listening', () => res(getPort(server!))))

    const ws = wsConnect(port, 'secret')
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    ws.close()
  })

  it('routes listRepos and returns a WireRes with repos', async () => {
    const deps = makeFakeDeps()
    server = createServer(deps, { token: 'secret', port: 0 })
    const port = await new Promise<number>((res) => server!.once('listening', () => res(getPort(server!))))

    const ws = wsConnect(port, 'secret')
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })

    const res = await sendReq(ws, IPC.listRepos)
    expect(res.t).toBe('res')
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.result).toEqual([makeRepo()])
    }

    ws.close()
  })

  it('returns WireRes with ok:false for unknown channel', async () => {
    const deps = makeFakeDeps()
    server = createServer(deps, { token: 'secret', port: 0 })
    const port = await new Promise<number>((res) => server!.once('listening', () => res(getPort(server!))))

    const ws = wsConnect(port, 'secret')
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })

    const res = await sendReq(ws, 'does:not:exist')
    expect(res.t).toBe('res')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toMatch(/Unknown channel/)
    }

    ws.close()
  })

  it('GET /healthz returns { ok: true }', async () => {
    const deps = makeFakeDeps()
    server = createServer(deps, { token: 'secret', port: 0 })
    const port = await new Promise<number>((res) => server!.once('listening', () => res(getPort(server!))))

    const body = await new Promise<string>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/healthz`, (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve(data))
      }).on('error', reject)
    })

    expect(JSON.parse(body)).toEqual({ ok: true })
  })
})

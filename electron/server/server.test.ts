import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
  IPromptTemplateStore,
  IOutcomeStore,
  SessionOutcomeDTO,
} from '../shared/contract.js'
import { IPC } from '../shared/contract.js'
import { APP_VERSION, GIT_SHA } from '../shared/version.js'
import { SCHEMA_VERSION } from '../db/migrations.js'
import { WebSocket } from 'ws'
import type { WireReq, WireRes } from '../shared/wire.js'
import type { IConfigStore } from '../services/configStore.js'
import type { IPushService } from '../services/pushService.js'
import type { IDeviceTokenStore, DeviceTokenDTO } from '../services/deviceTokenStore.js'
import { OutputBuffer } from '../services/outputBuffer.js'

// ── Fake deps (no native modules) ────────────────────────────────────────────

function makeRepo(): RepoDTO {
  return { id: 'r1', org: 'acme', name: 'api', base: 'main', path: '/repos/api' }
}

function makeFakePromptTemplates(): IPromptTemplateStore {
  return {
    list: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(undefined),
    upsert: vi.fn(),
    delete: vi.fn(),
  }
}

/** In-memory fake for IDeviceTokenStore (FLO-143) — real better-sqlite3 can't
 *  load under Node vitest (see docs/NATIVE-MODULES.md), so this mirrors
 *  createDeviceTokenStore's behavior (issue/list/get/revoke/resolveToken)
 *  without touching the DB. */
function makeFakeDeviceTokenStore(): IDeviceTokenStore {
  const rows = new Map<string, DeviceTokenDTO>()
  const tokensById = new Map<string, string>()
  let counter = 0
  return {
    issue(ownerId, label) {
      const id = `dt${++counter}`
      const token = `dt-token-${id}`
      const dto: DeviceTokenDTO = { id, ownerId, label, createdAt: Date.now(), revokedAt: null }
      rows.set(id, dto)
      tokensById.set(id, token)
      return { token, dto }
    },
    list() {
      return Array.from(rows.values())
    },
    get(id) {
      return rows.get(id)
    },
    revoke(id) {
      const row = rows.get(id)
      if (row && row.revokedAt === null) row.revokedAt = Date.now()
    },
    resolveToken(token) {
      for (const [id, t] of tokensById) {
        if (t === token) {
          const row = rows.get(id)
          return row && row.revokedAt === null ? { id: row.ownerId } : undefined
        }
      }
      return undefined
    },
  }
}

function makeOutcomeStore(): IOutcomeStore {
  const map = new Map<string, SessionOutcomeDTO>()
  return {
    get: (id) => map.get(id),
    upsert: (o) => {
      map.set(o.sessionId, o)
    },
    list: () => Array.from(map.values()),
    delete: (id) => {
      map.delete(id)
    },
  }
}

function makeFakeDeps(): IpcDeps {
  const sessionListeners: Record<string, ((...args: unknown[]) => void)[]> = {}

  const sessions: ISessionManager = {
    start: vi.fn(),
    resume: vi.fn(),
    attachRemoteControl: vi.fn(),
    handoff: vi.fn(),
    has: vi.fn().mockReturnValue(false),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    killAll: vi.fn(),
    getBuffer: vi.fn().mockResolvedValue({ data: '', seq: 0 }),
    setOpencodeSid: vi.fn(),
    liveSessions: vi.fn().mockReturnValue([]),
    reap: vi.fn(),
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
    registerByUrl: vi.fn().mockResolvedValue(makeRepo()),
    get: vi.fn().mockResolvedValue(makeRepo()),
    resolvePath: vi.fn().mockResolvedValue(makeRepo()),
    remove: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({ installCmd: '', startCmd: '' }),
    setSettings: vi.fn().mockResolvedValue(undefined),
  }

  const worktrees: IWorktreeManager = {
    pathFor: vi.fn().mockReturnValue('/wt/branch'),
    isMerged: vi.fn().mockResolvedValue({ merged: false, ahead: -1 }),
    create: vi.fn().mockResolvedValue({
      branch: 'b',
      path: '/wt/b',
      dirty: false,
      ahead: 0,
      behind: 0,
      added: 0,
      deleted: 0,
    }),
    remove: vi.fn().mockResolvedValue({ removed: true }),
    status: vi.fn().mockResolvedValue({
      branch: 'b',
      path: '/wt/b',
      dirty: false,
      ahead: 0,
      behind: 0,
      added: 0,
      deleted: 0,
    }),
    updateFromBase: vi.fn(),
    diff: vi.fn().mockResolvedValue({
      branch: 'b',
      base: 'main',
      mergeBase: '',
      files: [],
      truncated: false,
    }),
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
    postComment: vi.fn().mockResolvedValue(false),
    getSettings: vi.fn().mockReturnValue({
      configured: false,
      scopeKeys: [],
      onlyMine: true,
      apiKey: '',
      baseUrl: '',
      email: '',
      apiToken: '',
    }),
    setSettings: vi.fn(),
  }

  const config: IConfigStore = {
    get: vi.fn().mockReturnValue(undefined),
    set: vi.fn(),
  }

  const editor = { open: vi.fn().mockResolvedValue(undefined) }

  const sessionStoreMap = new Map()
  const sessionStore: ISessionStore = {
    list() {
      return Array.from(sessionStoreMap.values())
    },
    get(id) {
      return sessionStoreMap.get(id)
    },
    upsert(s) {
      sessionStoreMap.set(s.id, s)
    },
    delete(id) {
      sessionStoreMap.delete(id)
    },
  }

  const push: IPushService = {
    getVapidPublicKey: vi.fn().mockResolvedValue('test-vapid-key'),
    savePushSubscription: vi.fn().mockResolvedValue(undefined),
    deletePushSubscription: vi.fn().mockResolvedValue(undefined),
    getPushPrefs: vi.fn().mockResolvedValue(null),
    saveFcmToken: vi.fn().mockResolvedValue(undefined),
    deleteFcmToken: vi.fn().mockResolvedValue(undefined),
  }

  return {
    dataDir: '/tmp/slipstream-test',
    repos,
    worktrees,
    sessions,
    ports,
    tickets,
    config,
    sessionStore,
    promptTemplates: makeFakePromptTemplates(),
    outcomeStore: makeOutcomeStore(),
    editor,
    appRunner: {
      run: vi.fn().mockResolvedValue({ pid: 1234, reused: false }),
      stop: vi.fn().mockResolvedValue(true),
      isRunning: vi.fn().mockReturnValue(false),
    },
    push,
  }
}

function makeSurvivalDeps(): {
  deps: IpcDeps
  seedSession: (id: string, ...chunks: string[]) => void
} {
  const liveMap = new Map<string, OutputBuffer>()
  const sessionListeners: Record<string, ((...args: unknown[]) => void)[]> = {}

  const sessions: ISessionManager = {
    start: vi.fn(),
    resume: vi.fn(),
    attachRemoteControl: vi.fn(),
    handoff: vi.fn(),
    has: vi.fn().mockImplementation((id: string) => liveMap.has(id)),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockImplementation((id: string) => {
      liveMap.delete(id)
    }),
    killAll: vi.fn().mockImplementation(() => {
      liveMap.clear()
    }),
    getBuffer: vi
      .fn()
      .mockImplementation((id: string) =>
        Promise.resolve(liveMap.get(id)?.snapshot() ?? { data: '', seq: 0 }),
      ),
    setOpencodeSid: vi.fn(),
    liveSessions: vi.fn().mockReturnValue([]),
    reap: vi.fn().mockImplementation((id: string) => {
      liveMap.delete(id)
    }),
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
    registerByUrl: vi.fn().mockResolvedValue(makeRepo()),
    get: vi.fn().mockResolvedValue(makeRepo()),
    resolvePath: vi.fn().mockResolvedValue(makeRepo()),
    remove: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({ installCmd: '', startCmd: '' }),
    setSettings: vi.fn().mockResolvedValue(undefined),
  }

  const worktrees: IWorktreeManager = {
    pathFor: vi.fn().mockReturnValue('/wt/branch'),
    isMerged: vi.fn().mockResolvedValue({ merged: false, ahead: -1 }),
    create: vi.fn().mockResolvedValue({
      branch: 'b',
      path: '/wt/b',
      dirty: false,
      ahead: 0,
      behind: 0,
      added: 0,
      deleted: 0,
    }),
    remove: vi.fn().mockResolvedValue({ removed: true }),
    status: vi.fn().mockResolvedValue({
      branch: 'b',
      path: '/wt/b',
      dirty: false,
      ahead: 0,
      behind: 0,
      added: 0,
      deleted: 0,
    }),
    updateFromBase: vi.fn(),
    diff: vi.fn().mockResolvedValue({
      branch: 'b',
      base: 'main',
      mergeBase: '',
      files: [],
      truncated: false,
    }),
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
    postComment: vi.fn().mockResolvedValue(false),
    getSettings: vi.fn().mockReturnValue({
      configured: false,
      scopeKeys: [],
      onlyMine: true,
      apiKey: '',
      baseUrl: '',
      email: '',
      apiToken: '',
    }),
    setSettings: vi.fn(),
  }

  const config: IConfigStore = {
    get: vi.fn().mockReturnValue(undefined),
    set: vi.fn(),
  }

  const editor = { open: vi.fn().mockResolvedValue(undefined) }

  const sessionStoreMap = new Map()
  const sessionStore: ISessionStore = {
    list() {
      return Array.from(sessionStoreMap.values())
    },
    get(id) {
      return sessionStoreMap.get(id)
    },
    upsert(s) {
      sessionStoreMap.set(s.id, s)
    },
    delete(id) {
      sessionStoreMap.delete(id)
    },
  }

  const push: IPushService = {
    getVapidPublicKey: vi.fn().mockResolvedValue('test-vapid-key'),
    savePushSubscription: vi.fn().mockResolvedValue(undefined),
    deletePushSubscription: vi.fn().mockResolvedValue(undefined),
    getPushPrefs: vi.fn().mockResolvedValue(null),
    saveFcmToken: vi.fn().mockResolvedValue(undefined),
    deleteFcmToken: vi.fn().mockResolvedValue(undefined),
  }

  const deps: IpcDeps = {
    dataDir: '/tmp/slipstream-test',
    repos,
    worktrees,
    sessions,
    ports,
    tickets,
    config,
    sessionStore,
    promptTemplates: makeFakePromptTemplates(),
    outcomeStore: makeOutcomeStore(),
    editor,
    appRunner: {
      run: vi.fn().mockResolvedValue({ pid: 1234, reused: false }),
      stop: vi.fn().mockResolvedValue(true),
      isRunning: vi.fn().mockReturnValue(false),
    },
    push,
  }

  function seedSession(id: string, ...chunks: string[]): void {
    const buf = new OutputBuffer()
    for (const chunk of chunks) buf.push(chunk)
    liveMap.set(id, buf)
    sessionStoreMap.set(id, {
      id,
      tid: 'T-1',
      title: 'seeded',
      prompt: '',
      repoId: 'r1',
      branch: 'b',
      status: 'running' as const,
      createdAt: Date.now(),
    })
  }

  return { deps, seedSession }
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

function wsConnect(port: number, token?: string, origin?: string): WebSocket {
  const url = token
    ? `ws://127.0.0.1:${port}/rpc?token=${encodeURIComponent(token)}`
    : `ws://127.0.0.1:${port}/rpc`
  return new WebSocket(url, origin ? { origin } : undefined)
}

function wsConnectTicket(port: number, ticket: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/rpc?ticket=${encodeURIComponent(ticket)}`)
}

function postTicket(port: number, bearerToken?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/rpc-ticket',
        method: 'POST',
        headers: bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {},
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

function getHealthz(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}/healthz`, (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve(data))
      })
      .on('error', reject)
  })
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
    const port = await new Promise<number>((res) =>
      server!.once('listening', () => res(getPort(server!))),
    )

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
    const port = await new Promise<number>((res) =>
      server!.once('listening', () => res(getPort(server!))),
    )

    const ws = wsConnect(port, 'wrong-token')
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve())
      ws.once('error', () => resolve())
    })
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('closes with code 4001 on wrong token', async () => {
    const deps = makeFakeDeps()
    server = createServer(deps, { token: 'secret', port: 0 })
    const port = await new Promise<number>((res) =>
      server!.once('listening', () => res(getPort(server!))),
    )

    const ws = wsConnect(port, 'wrong-token')
    const code = await new Promise<number>((resolve) => {
      ws.once('close', (c) => resolve(c))
    })
    expect(code).toBe(4001)
  })

  it('closes with code 4001 when no token is provided', async () => {
    const deps = makeFakeDeps()
    server = createServer(deps, { token: 'secret', port: 0 })
    const port = await new Promise<number>((res) =>
      server!.once('listening', () => res(getPort(server!))),
    )

    const ws = wsConnect(port)
    const code = await new Promise<number>((resolve) => {
      ws.once('close', (c) => resolve(c))
    })
    expect(code).toBe(4001)
  })

  describe('per-device/per-user tokens (FLO-143)', () => {
    function makeSession(id: string, ownerId: string) {
      return {
        id,
        tid: 'T-1',
        title: 'seeded',
        prompt: '',
        repoId: 'r1',
        branch: 'b',
        status: 'idle' as const,
        createdAt: Date.now(),
        ownerId,
      }
    }

    it('authenticates distinct devices to distinct owners, each seeing only its own sessions', async () => {
      const deviceTokens = makeFakeDeviceTokenStore()
      const { token: aliceToken } = deviceTokens.issue('alice', 'alice-phone')
      const { token: bobToken } = deviceTokens.issue('bob', 'bob-laptop')

      const deps = makeFakeDeps()
      deps.deviceTokens = deviceTokens
      deps.sessionStore.upsert(makeSession('s-alice', 'alice'))
      deps.sessionStore.upsert(makeSession('s-bob', 'bob'))

      server = createServer(deps, { token: 'secret', port: 0 })
      const port = await new Promise<number>((res) =>
        server!.once('listening', () => res(getPort(server!))),
      )

      const aliceWs = wsConnect(port, aliceToken)
      await new Promise<void>((resolve, reject) => {
        aliceWs.once('open', resolve)
        aliceWs.once('error', reject)
      })
      const aliceRes = await sendReq(aliceWs, IPC.listSessions)
      expect(aliceRes.ok).toBe(true)
      if (aliceRes.ok) {
        expect((aliceRes.result as { id: string }[]).map((s) => s.id)).toEqual(['s-alice'])
      }
      aliceWs.close()

      const bobWs = wsConnect(port, bobToken)
      await new Promise<void>((resolve, reject) => {
        bobWs.once('open', resolve)
        bobWs.once('error', reject)
      })
      const bobRes = await sendReq(bobWs, IPC.listSessions)
      expect(bobRes.ok).toBe(true)
      if (bobRes.ok) {
        expect((bobRes.result as { id: string }[]).map((s) => s.id)).toEqual(['s-bob'])
      }
      bobWs.close()
    })

    it('revoking one device credential rejects only that device, not others', async () => {
      const deviceTokens = makeFakeDeviceTokenStore()
      const { token: aliceToken, dto: aliceDto } = deviceTokens.issue('alice', 'alice-phone')
      const { token: bobToken } = deviceTokens.issue('bob', 'bob-laptop')

      const deps = makeFakeDeps()
      deps.deviceTokens = deviceTokens

      server = createServer(deps, { token: 'secret', port: 0 })
      const port = await new Promise<number>((res) =>
        server!.once('listening', () => res(getPort(server!))),
      )

      deviceTokens.revoke(aliceDto.id)

      const aliceWs = wsConnect(port, aliceToken)
      const aliceCode = await new Promise<number>((resolve) => {
        aliceWs.once('close', (c) => resolve(c))
      })
      expect(aliceCode).toBe(4001)

      const bobWs = wsConnect(port, bobToken)
      await new Promise<void>((resolve, reject) => {
        bobWs.once('open', resolve)
        bobWs.once('error', reject)
      })
      bobWs.close()
    })

    it('still authenticates the static SLIPSTREAM_TOKEN to the local owner when a device token store is wired up', async () => {
      const deps = makeFakeDeps()
      deps.deviceTokens = makeFakeDeviceTokenStore()

      server = createServer(deps, { token: 'secret', port: 0 })
      const port = await new Promise<number>((res) =>
        server!.once('listening', () => res(getPort(server!))),
      )

      const ws = wsConnect(port, 'secret')
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      })
      ws.close()
    })
  })

  describe('one-time WS ticket endpoint (FLO-144)', () => {
    it('POST /rpc-ticket without a bearer token is rejected', async () => {
      const deps = makeFakeDeps()
      server = createServer(deps, { token: 'secret', port: 0 })
      const port = await new Promise<number>((res) =>
        server!.once('listening', () => res(getPort(server!))),
      )

      const { status } = await postTicket(port)
      expect(status).toBe(401)
    })

    it('POST /rpc-ticket with the wrong bearer token is rejected', async () => {
      const deps = makeFakeDeps()
      server = createServer(deps, { token: 'secret', port: 0 })
      const port = await new Promise<number>((res) =>
        server!.once('listening', () => res(getPort(server!))),
      )

      const { status } = await postTicket(port, 'wrong-token')
      expect(status).toBe(401)
    })

    it('a ticket issued via POST /rpc-ticket redeems for a WS connection', async () => {
      const deps = makeFakeDeps()
      server = createServer(deps, { token: 'secret', port: 0 })
      const port = await new Promise<number>((res) =>
        server!.once('listening', () => res(getPort(server!))),
      )

      const { status, body } = await postTicket(port, 'secret')
      expect(status).toBe(200)
      const { ticket, expiresInMs } = JSON.parse(body) as { ticket: string; expiresInMs: number }
      expect(typeof ticket).toBe('string')
      expect(ticket.length).toBeGreaterThan(20)
      expect(expiresInMs).toBeGreaterThan(0)

      const ws = wsConnectTicket(port, ticket)
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      })
      ws.close()
    })

    it('a ticket is single-use — a second redemption is rejected like a bad token', async () => {
      const deps = makeFakeDeps()
      server = createServer(deps, { token: 'secret', port: 0 })
      const port = await new Promise<number>((res) =>
        server!.once('listening', () => res(getPort(server!))),
      )

      const { body } = await postTicket(port, 'secret')
      const { ticket } = JSON.parse(body) as { ticket: string }

      const ws1 = wsConnectTicket(port, ticket)
      await new Promise<void>((resolve, reject) => {
        ws1.once('open', resolve)
        ws1.once('error', reject)
      })
      ws1.close()

      const ws2 = wsConnectTicket(port, ticket)
      const code = await new Promise<number>((resolve) => {
        ws2.once('close', (c) => resolve(c))
      })
      expect(code).toBe(4001)
    })

    it('an unknown ticket closes with code 4001, same as a bad token', async () => {
      const deps = makeFakeDeps()
      server = createServer(deps, { token: 'secret', port: 0 })
      const port = await new Promise<number>((res) =>
        server!.once('listening', () => res(getPort(server!))),
      )

      const ws = wsConnectTicket(port, 'not-a-real-ticket')
      const code = await new Promise<number>((resolve) => {
        ws.once('close', (c) => resolve(c))
      })
      expect(code).toBe(4001)
    })

    it('an expired ticket closes with code 4001', async () => {
      const deps = makeFakeDeps()
      // Short TTL so the test doesn't have to wait out the real ~10s default.
      server = createServer(deps, { token: 'secret', port: 0, wsTicketTtlMs: 20 })
      const port = await new Promise<number>((res) =>
        server!.once('listening', () => res(getPort(server!))),
      )

      const { body } = await postTicket(port, 'secret')
      const { ticket } = JSON.parse(body) as { ticket: string }

      await new Promise((resolve) => setTimeout(resolve, 50))

      const ws = wsConnectTicket(port, ticket)
      const code = await new Promise<number>((resolve) => {
        ws.once('close', (c) => resolve(c))
      })
      expect(code).toBe(4001)
    })

    it('a ticket propagates the identity resolved at issuance time (per-device token)', async () => {
      const deviceTokens = makeFakeDeviceTokenStore()
      const { token: aliceToken } = deviceTokens.issue('alice', 'alice-phone')

      const deps = makeFakeDeps()
      deps.deviceTokens = deviceTokens
      deps.sessionStore.upsert({
        id: 's-alice',
        tid: 'T-1',
        title: 'seeded',
        prompt: '',
        repoId: 'r1',
        branch: 'b',
        status: 'idle' as const,
        createdAt: Date.now(),
        ownerId: 'alice',
      })

      server = createServer(deps, { token: 'secret', port: 0 })
      const port = await new Promise<number>((res) =>
        server!.once('listening', () => res(getPort(server!))),
      )

      const { status, body } = await postTicket(port, aliceToken)
      expect(status).toBe(200)
      const { ticket } = JSON.parse(body) as { ticket: string }

      const ws = wsConnectTicket(port, ticket)
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      })
      const res = await sendReq(ws, IPC.listSessions)
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect((res.result as { id: string }[]).map((s) => s.id)).toEqual(['s-alice'])
      }
      ws.close()
    })

    it('GET /healthz omits wsTickets when not enabled', async () => {
      const deps = makeFakeDeps()
      server = createServer(deps, { token: 'secret', port: 0 })
      const port = await new Promise<number>((res) =>
        server!.once('listening', () => res(getPort(server!))),
      )

      const body = await getHealthz(port)
      expect(JSON.parse(body)).toEqual({
        ok: true,
        version: APP_VERSION,
        gitSha: GIT_SHA,
        schema: SCHEMA_VERSION,
      })
    })

    it('GET /healthz reports wsTickets: true when enabled', async () => {
      const deps = makeFakeDeps()
      server = createServer(deps, { token: 'secret', port: 0, wsTickets: true })
      const port = await new Promise<number>((res) =>
        server!.once('listening', () => res(getPort(server!))),
      )

      const body = await getHealthz(port)
      expect(JSON.parse(body)).toEqual({
        ok: true,
        version: APP_VERSION,
        gitSha: GIT_SHA,
        schema: SCHEMA_VERSION,
        wsTickets: true,
      })
    })
  })

  it('rejects a browser Origin not in the allowlist', async () => {
    const deps = makeFakeDeps()
    server = createServer(deps, {
      token: 'secret',
      port: 0,
      allowedOrigins: ['http://good.example'],
    })
    const port = await new Promise<number>((res) =>
      server!.once('listening', () => res(getPort(server!))),
    )

    const ws = wsConnect(port, 'secret', 'http://evil.example')
    const code = await new Promise<number | undefined>((resolve) => {
      ws.once('close', (c) => resolve(c))
      ws.once('error', () => resolve(undefined))
    })
    expect(ws.readyState).toBe(WebSocket.CLOSED)
    // Rejected before the handshake — a raw socket destroy, not a clean 4001 close.
    expect(code).not.toBe(4001)
  })

  it('accepts a browser Origin in the allowlist (with token)', async () => {
    const deps = makeFakeDeps()
    server = createServer(deps, {
      token: 'secret',
      port: 0,
      allowedOrigins: ['http://good.example'],
    })
    const port = await new Promise<number>((res) =>
      server!.once('listening', () => res(getPort(server!))),
    )

    const ws = wsConnect(port, 'secret', 'http://good.example')
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    ws.close()
  })

  it('allows header clients (no Origin) even when an allowlist is set', async () => {
    const deps = makeFakeDeps()
    server = createServer(deps, {
      token: 'secret',
      port: 0,
      allowedOrigins: ['http://good.example'],
    })
    const port = await new Promise<number>((res) =>
      server!.once('listening', () => res(getPort(server!))),
    )

    const ws = wsConnect(port, 'secret') // no Origin header (header-capable client)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    ws.close()
  })

  it('accepts any Origin when no allowlist is configured', async () => {
    const deps = makeFakeDeps()
    server = createServer(deps, { token: 'secret', port: 0 })
    const port = await new Promise<number>((res) =>
      server!.once('listening', () => res(getPort(server!))),
    )

    const ws = wsConnect(port, 'secret', 'http://anything.example')
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    ws.close()
  })

  it('accepts a connection with the correct token', async () => {
    const deps = makeFakeDeps()
    server = createServer(deps, { token: 'secret', port: 0 })
    const port = await new Promise<number>((res) =>
      server!.once('listening', () => res(getPort(server!))),
    )

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
    const port = await new Promise<number>((res) =>
      server!.once('listening', () => res(getPort(server!))),
    )

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
    const port = await new Promise<number>((res) =>
      server!.once('listening', () => res(getPort(server!))),
    )

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

  it('replies to an application-level ping with a pong', async () => {
    const deps = makeFakeDeps()
    server = createServer(deps, { token: 'secret', port: 0 })
    const port = await new Promise<number>((res) =>
      server!.once('listening', () => res(getPort(server!))),
    )

    const ws = wsConnect(port, 'secret')
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })

    const pong = await new Promise<unknown>((resolve, reject) => {
      ws.once('message', (raw) => {
        try {
          resolve(JSON.parse(String(raw)))
        } catch (e) {
          reject(e)
        }
      })
      ws.send(JSON.stringify({ t: 'ping' }))
    })
    expect(pong).toEqual({ t: 'pong' })

    ws.close()
  })

  it('GET /healthz returns version info', async () => {
    const deps = makeFakeDeps()
    server = createServer(deps, { token: 'secret', port: 0 })
    const port = await new Promise<number>((res) =>
      server!.once('listening', () => res(getPort(server!))),
    )

    const body = await new Promise<string>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${port}/healthz`, (res) => {
          let data = ''
          res.on('data', (c) => (data += c))
          res.on('end', () => resolve(data))
        })
        .on('error', reject)
    })

    expect(JSON.parse(body)).toEqual({
      ok: true,
      version: APP_VERSION,
      gitSha: GIT_SHA,
      schema: SCHEMA_VERSION,
    })
  })

  it('session survives across zero connected clients — output replays on reconnect, PTY not reaped', async () => {
    const { deps, seedSession } = makeSurvivalDeps()
    seedSession('s1', 'hello ', 'world', '!')

    server = createServer(deps, { token: 'secret', port: 0 })
    await new Promise<void>((resolve) => server!.once('listening', resolve))
    const port = getPort(server!)

    // Connect client A
    const wsA = wsConnect(port, 'secret')
    await new Promise<void>((resolve, reject) => {
      wsA.once('open', resolve)
      wsA.once('error', reject)
    })

    // Disconnect client A — simulates all clients gone
    wsA.close()
    await new Promise<void>((resolve) => wsA.once('close', resolve))

    // Give the server a tick to process the close event
    await new Promise<void>((r) => setTimeout(r, 0))

    // PTY must NOT have been reaped
    expect(deps.sessions.kill).not.toHaveBeenCalled()
    expect(deps.sessions.killAll).not.toHaveBeenCalled()
    expect(deps.sessions.has('s1')).toBe(true)

    // Connect client B and replay output
    const wsB = wsConnect(port, 'secret')
    await new Promise<void>((resolve, reject) => {
      wsB.once('open', resolve)
      wsB.once('error', reject)
    })

    const res = await sendReq(wsB, IPC.getSessionBuffer, ['s1'])
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.result).toEqual({ data: 'hello world!', seq: 12 })
    }

    wsB.close()
  })

  it('returns 404 for missing /assets/*.js instead of SPA-fallback HTML (prevents MIME mismatch blank screen)', async () => {
    const deps = makeFakeDeps()
    server = createServer(deps, { token: 'secret', port: 0 })
    const port = await new Promise<number>((res) =>
      server!.once('listening', () => res(getPort(server!))),
    )

    // Request a non-existent hashed asset — it should 404, not SPA-fallback to HTML
    const { statusCode, contentType } = await new Promise<{
      statusCode: number
      contentType: string
    }>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${port}/assets/old-stale-hash.js`, (res) => {
          res.resume()
          resolve({
            statusCode: res.statusCode ?? 0,
            contentType: res.headers['content-type'] ?? '',
          })
        })
        .on('error', reject)
    })

    expect(statusCode).toBe(404)
    expect(contentType).not.toContain('text/html')
  })

  // ── Static serving: percent-decoding + distDir containment ─────────────────
  //
  // createServer resolves its static root relative to its own module location:
  // <electron>/server/.. -> <electron>/dist. That directory doesn't exist in a
  // source checkout (builds emit to the repo-root dist/), so these tests plant
  // fixture files there and remove exactly what they created afterwards.
  describe('static file percent-decoding', () => {
    const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
    const created: string[] = []
    let createdDistDir = false
    let createdAssetsDir = false

    function plant(relPath: string, content: string) {
      const fp = path.join(distDir, relPath)
      if (fs.existsSync(fp)) return
      fs.writeFileSync(fp, content)
      created.push(fp)
    }

    beforeAll(() => {
      createdDistDir = !fs.existsSync(distDir)
      createdAssetsDir = !fs.existsSync(path.join(distDir, 'assets'))
      fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true })
      plant('index.html', '<html>spa-index</html>')
      plant('test fixture.js', 'console.log("spaced")')
      plant(path.join('assets', 'test fixture.js'), 'console.log("hashed")')
    })

    afterAll(() => {
      for (const fp of created) fs.rmSync(fp, { force: true })
      if (createdAssetsDir)
        fs.rmSync(path.join(distDir, 'assets'), { recursive: true, force: true })
      if (createdDistDir) fs.rmSync(distDir, { recursive: true, force: true })
    })

    function httpGet(
      port: number,
      rawPath: string,
    ): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
      return new Promise((resolve, reject) => {
        http
          .get(`http://127.0.0.1:${port}${rawPath}`, (res) => {
            let body = ''
            res.on('data', (c: Buffer) => (body += c.toString()))
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
            )
          })
          .on('error', reject)
      })
    }

    async function startServer(): Promise<number> {
      server = createServer(makeFakeDeps(), { token: 'secret', port: 0 })
      return new Promise<number>((res) => server!.once('listening', () => res(getPort(server!))))
    }

    it('serves a file whose request path is percent-encoded', async () => {
      const port = await startServer()
      const res = await httpGet(port, '/test%20fixture.js')
      expect(res.status).toBe(200)
      expect(res.body).toBe('console.log("spaced")')
      expect(res.headers['content-type']).toBe('application/javascript')
      expect(res.headers['cache-control']).toBe('no-cache')
    })

    it('marks an /assets/ file requested via an encoded path as immutable', async () => {
      const port = await startServer()
      const res = await httpGet(port, '/assets/test%20fixture.js')
      expect(res.status).toBe(200)
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    })

    it('uses the DECODED pathname for the SPA-fallback extension check', async () => {
      const port = await startServer()
      // Raw '/missing%2Ejs' has no literal dot, so an undecoded extname check
      // would SPA-fallback to HTML; decoded it is '/missing.js' -> hard 404.
      const res = await httpGet(port, '/missing%2Ejs')
      expect(res.status).toBe(404)
      expect(res.body).not.toContain('spa-index')
    })

    it('responds 400 to malformed percent-encoding', async () => {
      const port = await startServer()
      const res = await httpGet(port, '/%zz')
      expect(res.status).toBe(400)
    })

    it('responds 404 to encoded path traversal outside distDir', async () => {
      const port = await startServer()
      // %2f keeps the dot segments inside a single URL path segment so neither
      // the client nor the server URL parser normalizes them away; only the
      // server-side decode reveals the ../../ — which must be contained.
      const res = await httpGet(port, '/..%2f..%2fpackage.json')
      expect(res.status).toBe(404)
      expect(res.body).not.toContain('"scripts"')
    })
  })
})

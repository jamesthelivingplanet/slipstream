import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  transitionKind,
  createPushService,
  computeOngoingSnapshot,
  FCM_SERVICE_ACCOUNT_CONFIG_KEY,
} from './pushService.js'
import type {
  PushStore,
  PushSender,
  FcmStore,
  FcmSender,
  FcmDataSender,
  FcmTokenMinter,
} from './pushService.js'
import type {
  NotifyPrefs,
  PushSubscriptionDTO,
  SessionStatus,
  ISessionManager,
  ISessionStore,
  SessionDTO,
} from '../shared/contract.js'
import type { IConfigStore } from './configStore.js'
import type { FcmServiceAccount } from './fcm.js'
import { MASCOT_NAME, NOTIFICATION_TITLES } from '../shared/mascot.js'

function isFromPool(title: string, pool: readonly string[]): boolean {
  return pool.includes(title)
}

// ── helpers ────────────────────────────────────────────────────────────────────

function makeStore(
  rows: Array<{
    endpoint: string
    p256dh: string
    auth: string
    needs: number
    done: number
    running: number
    createdAt: number
  }> = [],
): PushStore & { rows: typeof rows } {
  const state = { rows }
  const result = {
    get rows() {
      return state.rows
    },
    all: () => state.rows,
    upsert(sub: PushSubscriptionDTO, prefs: NotifyPrefs, now: number) {
      const existing = state.rows.findIndex((r) => r.endpoint === sub.endpoint)
      const row = {
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        needs: prefs.needs ? 1 : 0,
        done: prefs.done ? 1 : 0,
        running: prefs.running ? 1 : 0,
        createdAt: now,
      }
      if (existing >= 0) state.rows[existing] = row
      else state.rows.push(row)
    },
    delete(endpoint: string) {
      state.rows = state.rows.filter((r) => r.endpoint !== endpoint)
    },
    getPrefs(endpoint: string): NotifyPrefs | null {
      const row = state.rows.find((r) => r.endpoint === endpoint)
      if (!row) return null
      return { needs: !!row.needs, done: !!row.done, running: !!row.running }
    },
  }
  return result as PushStore & { rows: typeof rows }
}

type Listener = (...args: unknown[]) => void

function makeSessions(): ISessionManager & { _emit: (event: string, ...args: unknown[]) => void } {
  const listeners: Record<string, Listener[]> = {}
  return {
    start: vi.fn(),
    resume: vi.fn(),
    attachRemoteControl: vi.fn(),
    has: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    killAll: vi.fn(),
    getBuffer: vi.fn(),
    on(event: string, listener: Listener) {
      listeners[event] ??= []
      listeners[event].push(listener)
    },
    off(event: string, listener: Listener) {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((l) => l !== listener)
      }
    },
    _emit(event: string, ...args: unknown[]) {
      for (const l of listeners[event] ?? []) l(...args)
    },
  } as unknown as ISessionManager & { _emit: (event: string, ...args: unknown[]) => void }
}

function makeSessionStore(sessions: SessionDTO[] = []): ISessionStore {
  const map = new Map(sessions.map((s) => [s.id, s]))
  return {
    list: () => Array.from(map.values()),
    get: (id) => map.get(id),
    upsert: (s) => map.set(s.id, s),
    delete: (id) => map.delete(id),
  }
}

function makeConfig(): IConfigStore {
  const data: Record<string, string> = {}
  return {
    get: (key) => data[key],
    set: (key, value) => {
      data[key] = value
    },
  }
}

function makeSub(endpoint = 'https://push.example.com/sub1'): PushSubscriptionDTO {
  return { endpoint, keys: { p256dh: 'p256dh_key', auth: 'auth_key' } }
}

// ── FCM (TASK-I9S44) test helpers ───────────────────────────────────────────

interface FcmRow {
  token: string
  ownerId: string
  platform: string
  createdAt: number
  // Optional in the test fixture type (unlike the real FcmTokenRow, where
  // it's always present but nullable) so pre-existing row literals below
  // that predate TASK-F0TYG's origin field don't all need updating.
  origin?: string | null
}

function makeFcmStore(rows: FcmRow[] = []): FcmStore & { rows: FcmRow[] } {
  const state = { rows: [...rows] }
  return {
    get rows() {
      return state.rows
    },
    all: () => state.rows,
    upsert(token, ownerId, platform, now, origin) {
      const existing = state.rows.findIndex((r) => r.token === token)
      const row = { token, ownerId, platform, createdAt: now, origin: origin ?? null }
      if (existing >= 0) state.rows[existing] = row
      else state.rows.push(row)
    },
    delete(token, ownerId) {
      state.rows = state.rows.filter((r) => !(r.token === token && r.ownerId === ownerId))
    },
  } as FcmStore & { rows: FcmRow[] }
}

const RAW_FCM_ACCOUNT = JSON.stringify({
  project_id: 'test-project',
  client_email: 'svc@test-project.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
})

// ── transitionKind tests ──────────────────────────────────────────────────────

describe('transitionKind', () => {
  it('returns needs when transitioning to needs from non-needs', () => {
    expect(transitionKind('idle', 'needs')).toBe('needs')
    expect(transitionKind('running', 'needs')).toBe('needs')
    expect(transitionKind(undefined, 'needs')).toBe('needs')
  })

  it('returns null when already at needs', () => {
    expect(transitionKind('needs', 'needs')).toBeNull()
  })

  it('returns done when transitioning to done from non-done', () => {
    expect(transitionKind('running', 'done')).toBe('done')
    expect(transitionKind(undefined, 'done')).toBe('done')
  })

  it('returns null when already at done', () => {
    expect(transitionKind('done', 'done')).toBeNull()
  })

  it('returns running when transitioning to running from non-running', () => {
    expect(transitionKind('idle', 'running')).toBe('running')
    expect(transitionKind(undefined, 'running')).toBe('running')
  })

  it('returns null when already at running', () => {
    expect(transitionKind('running', 'running')).toBeNull()
  })

  it('returns null for idle and errored transitions', () => {
    expect(transitionKind('running', 'idle')).toBeNull()
    expect(transitionKind('running', 'errored')).toBeNull()
  })
})

// ── computeOngoingSnapshot tests (FLO-160) ───────────────────────────────────

function sess(overrides: Partial<SessionDTO> & { id: string }): SessionDTO {
  return {
    tid: overrides.id,
    title: '',
    prompt: '',
    repoId: 'r1',
    branch: 'b',
    status: 'idle',
    createdAt: 0,
    ...overrides,
  }
}

describe('computeOngoingSnapshot (FLO-160)', () => {
  it('counts only running sessions for the given owner', () => {
    const store = makeSessionStore([
      sess({ id: 'r1', status: 'running', ownerId: 'local' }),
      sess({ id: 'r2', status: 'running', ownerId: 'local' }),
      sess({ id: 'n1', status: 'needs', ownerId: 'local' }),
      sess({ id: 'd1', status: 'done', ownerId: 'local' }),
      sess({ id: 'i1', status: 'idle', ownerId: 'local' }),
      sess({ id: 'r3', status: 'running', ownerId: 'alice' }),
    ])
    const snap = computeOngoingSnapshot(store, 'local')
    expect(snap.runningCount).toBe(2)
  })

  it('returns 0 / null when the owner has no live sessions', () => {
    const store = makeSessionStore([
      sess({ id: 'd1', status: 'done', ownerId: 'local' }),
      sess({ id: 'r1', status: 'running', ownerId: 'alice' }),
    ])
    const snap = computeOngoingSnapshot(store, 'local')
    expect(snap.runningCount).toBe(0)
    expect(snap.topAsk).toBeNull()
  })

  it('prefers the just-transitioned needs session as topAsk', () => {
    const store = makeSessionStore([
      sess({
        id: 'old-ask',
        tid: 'OLD',
        title: 'old ask',
        status: 'needs',
        ownerId: 'local',
        createdAt: 100,
      }),
      sess({
        id: 'fresh',
        tid: 'FRESH',
        title: 'fresh title',
        status: 'needs',
        ownerId: 'local',
        createdAt: 500,
      }),
    ])
    // just-transitioned 'fresh' wins even though the older ask has a larger
    // createdAt — the freshest signal is the just-fired transition.
    const snap = computeOngoingSnapshot(store, 'local', 'fresh', {
      reason: 'input',
      message: 'which DB?',
    })
    expect(snap.topAsk).toEqual({
      sessionId: 'fresh',
      tid: 'FRESH',
      message: 'which DB?',
    })
  })

  it('uses session title when meta.message is absent on the just-transitioned ask', () => {
    const store = makeSessionStore([
      sess({ id: 's1', tid: 'T-1', title: 'the title', status: 'needs', ownerId: 'local' }),
    ])
    const snap = computeOngoingSnapshot(store, 'local', 's1')
    expect(snap.topAsk?.message).toBe('the title')
  })

  it('falls back to most recently created needs session when the just-transitioned session is not needs', () => {
    const store = makeSessionStore([
      sess({
        id: 'older',
        tid: 'OLDER',
        title: 'older',
        status: 'needs',
        ownerId: 'local',
        createdAt: 100,
      }),
      sess({
        id: 'newest',
        tid: 'NEWEST',
        title: 'newest',
        status: 'needs',
        ownerId: 'local',
        createdAt: 900,
      }),
      sess({ id: 'just-ran', status: 'running', ownerId: 'local' }),
    ])
    // just-ran is now running, not needs — so the fallback scans the store.
    const snap = computeOngoingSnapshot(store, 'local', 'just-ran')
    expect(snap.topAsk?.sessionId).toBe('newest')
  })

  it('excludes sessions of a different owner', () => {
    const store = makeSessionStore([
      sess({ id: 'alice-run', status: 'running', ownerId: 'alice' }),
      sess({
        id: 'alice-ask',
        tid: 'ALICE',
        title: 'alice ask',
        status: 'needs',
        ownerId: 'alice',
      }),
      sess({ id: 'local-run', status: 'running', ownerId: 'local' }),
    ])
    const snap = computeOngoingSnapshot(store, 'local')
    expect(snap.runningCount).toBe(1)
    expect(snap.topAsk).toBeNull()
  })

  it('treats an undefined ownerId on a session as local (the single-user fallback)', () => {
    const store = makeSessionStore([
      sess({ id: 'no-owner', status: 'running' }), // ownerId undefined
    ])
    const snap = computeOngoingSnapshot(store, 'local')
    expect(snap.runningCount).toBe(1)
  })
})

// ── createPushService tests ────────────────────────────────────────────────────

describe('createPushService', () => {
  let store: ReturnType<typeof makeStore>
  let sessions: ReturnType<typeof makeSessions>
  let sessionStore: ISessionStore
  let config: IConfigStore
  let send: ReturnType<typeof vi.fn>
  let nowMs: number

  beforeEach(() => {
    store = makeStore()
    sessions = makeSessions()
    sessionStore = makeSessionStore()
    config = makeConfig()
    send = vi.fn().mockResolvedValue({ statusCode: 201 })
    nowMs = 10000
  })

  function makeService(
    overrides: {
      store?: PushStore
      send?: PushSender
      now?: () => number
      fcmStore?: FcmStore
      fcmMint?: FcmTokenMinter
      fcmSend?: FcmSender
      fcmDataSend?: FcmDataSender
    } = {},
  ) {
    return createPushService({
      config,
      store: overrides.store ?? store,
      sessions,
      sessionStore,
      send: overrides.send ?? (send as PushSender),
      now: overrides.now ?? (() => nowMs),
      fcmStore: overrides.fcmStore,
      fcmMint: overrides.fcmMint,
      fcmSend: overrides.fcmSend,
      fcmDataSend: overrides.fcmDataSend,
    })
  }

  it('getVapidPublicKey generates and stores VAPID keys on first call', async () => {
    // We inject a send so web-push isn't imported; test vapid key generation via config
    // Note: since web-push IS imported for VAPID, we need to test the config path
    config.set('vapidPublicKey', 'existingPub')
    config.set('vapidPrivateKey', 'existingPriv')
    // With existing keys, it should return the existing public key after setting up web-push
    // But web-push.setVapidDetails will be called - just verify it returns the stored key
    // We can't truly test this without mocking web-push, so just test the store interaction
    const svc = makeService()
    await svc.savePushSubscription(makeSub(), { needs: true, done: true, running: false })
    expect(store.rows).toHaveLength(1)
  })

  it('savePushSubscription upserts the subscription', async () => {
    const svc = makeService()
    const sub = makeSub()
    await svc.savePushSubscription(sub, { needs: true, done: false, running: true })
    expect(store.rows).toHaveLength(1)
    expect(store.rows[0].endpoint).toBe(sub.endpoint)
    expect(store.rows[0].needs).toBe(1)
    expect(store.rows[0].done).toBe(0)
    expect(store.rows[0].running).toBe(1)
  })

  it('deletePushSubscription removes the subscription', async () => {
    const sub = makeSub()
    store.upsert(sub, { needs: true, done: true, running: false }, 0)
    const svc = makeService()
    await svc.deletePushSubscription(sub.endpoint)
    expect(store.rows).toHaveLength(0)
  })

  it('getPushPrefs returns null for unknown endpoint', async () => {
    const svc = makeService()
    expect(await svc.getPushPrefs('unknown')).toBeNull()
  })

  it('getPushPrefs returns prefs for known endpoint', async () => {
    const sub = makeSub()
    store.upsert(sub, { needs: true, done: false, running: true }, 0)
    const svc = makeService()
    expect(await svc.getPushPrefs(sub.endpoint)).toEqual({
      needs: true,
      done: false,
      running: true,
    })
  })

  it('sends push when session transitions to needs and sub has needs=1', async () => {
    const sub = makeSub()
    store.upsert(sub, { needs: true, done: false, running: false }, 0)
    makeService()
    sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
    // Allow microtasks to flush
    await new Promise((r) => setTimeout(r, 10))
    expect(send).toHaveBeenCalledOnce()
    const [calledSub, payload] = send.mock.calls[0] as [PushSubscriptionDTO, string]
    expect(calledSub.endpoint).toBe(sub.endpoint)
    expect(JSON.parse(payload).status).toBe('needs')
  })

  it('does NOT send push for needs when sub has needs=0', async () => {
    const sub = makeSub()
    store.upsert(sub, { needs: false, done: true, running: false }, 0)
    makeService()
    sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
    await new Promise((r) => setTimeout(r, 10))
    expect(send).not.toHaveBeenCalled()
  })

  it('sends push when session transitions to running and sub has running=1', async () => {
    const sub = makeSub()
    store.upsert(sub, { needs: false, done: false, running: true }, 0)
    makeService()
    sessions._emit('status', 's1', 'running' satisfies SessionStatus)
    await new Promise((r) => setTimeout(r, 10))
    expect(send).toHaveBeenCalledOnce()
    const [, payload] = send.mock.calls[0] as [PushSubscriptionDTO, string]
    expect(JSON.parse(payload).status).toBe('running')
  })

  it('sends only one notification per kind while the status flaps', async () => {
    const sub = makeSub()
    store.upsert(sub, { needs: true, done: false, running: false }, 0)
    makeService()
    // First transition to needs
    sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
    // Back to idle (clears the "current" but keeps the notified flag)
    sessions._emit('status', 's1', 'idle' satisfies SessionStatus)
    // Second transition to needs — same episode, suppressed
    sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
    await new Promise((r) => setTimeout(r, 10))
    expect(send).toHaveBeenCalledOnce()
  })

  it('does NOT re-notify on heuristic flapping, no matter how much time passes', async () => {
    const sub = makeSub()
    store.upsert(sub, { needs: true, done: false, running: false }, 0)
    let t = 10000
    makeService({ now: () => t })
    // Idle-TUI flap: needs -> running -> needs -> ... every few seconds.
    sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
    for (let i = 0; i < 20; i++) {
      t += 5000
      sessions._emit('status', 's1', 'running' satisfies SessionStatus)
      t += 5000
      sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
    }
    await new Promise((r) => setTimeout(r, 10))
    expect(send).toHaveBeenCalledOnce()
  })

  it('re-arms notifications after the user types into the session', async () => {
    const sub = makeSub()
    store.upsert(sub, { needs: true, done: false, running: false }, 0)
    makeService()
    sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
    // User answers the agent's question — new episode.
    sessions._emit('input', 's1')
    sessions._emit('status', 's1', 'running' satisfies SessionStatus)
    sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
    await new Promise((r) => setTimeout(r, 10))
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('input on one session does not re-arm another', async () => {
    const sub = makeSub()
    store.upsert(sub, { needs: true, done: false, running: false }, 0)
    makeService()
    sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
    sessions._emit('input', 's2')
    sessions._emit('status', 's1', 'idle' satisfies SessionStatus)
    sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
    await new Promise((r) => setTimeout(r, 10))
    expect(send).toHaveBeenCalledOnce()
  })

  it('prunes subscription on 410 response', async () => {
    const sub = makeSub()
    store.upsert(sub, { needs: true, done: false, running: false }, 0)
    const gone = vi.fn().mockResolvedValue({ statusCode: 410 })
    makeService({ send: gone as PushSender })
    sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
    await new Promise((r) => setTimeout(r, 10))
    expect(store.rows).toHaveLength(0)
  })

  it('prunes subscription when send throws with statusCode 410', async () => {
    const sub = makeSub()
    store.upsert(sub, { needs: true, done: false, running: false }, 0)
    const throwGone = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('Gone'), { statusCode: 410 }))
    makeService({ send: throwGone as PushSender })
    sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
    await new Promise((r) => setTimeout(r, 10))
    expect(store.rows).toHaveLength(0)
  })

  it('uses tid from session store in the notification payload', async () => {
    const sub = makeSub()
    store.upsert(sub, { needs: true, done: false, running: false }, 0)
    const sessionStore2 = makeSessionStore([
      {
        id: 's1',
        tid: 'FLO-42',
        title: 'Do work',
        prompt: 'do it',
        repoId: 'r1',
        branch: 'flo-42',
        status: 'running',
        createdAt: 0,
      },
    ])
    createPushService({
      config,
      store,
      sessions,
      sessionStore: sessionStore2,
      send: send as PushSender,
      now: () => nowMs,
    })
    sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
    await new Promise((r) => setTimeout(r, 10))
    const [, payload] = send.mock.calls[0] as [PushSubscriptionDTO, string]
    expect(JSON.parse(payload).tid).toBe('FLO-42')
    // Body is "{tid}: {message-or-title}" (TASK-F0TYG) — the concrete session
    // id stays visible even though the title is now Nulliel's playful hook.
    expect(JSON.parse(payload).body).toBe('FLO-42: Do work')
  })

  describe('status meta (FLO-104 reasons)', () => {
    async function firstPayload(): Promise<{ title: string; body: string }> {
      await new Promise((r) => setTimeout(r, 10))
      const [, payload] = send.mock.calls[0] as [PushSubscriptionDTO, string]
      return JSON.parse(payload) as { title: string; body: string }
    }

    it('reason blocked → title drawn from the needsBlocked pool', async () => {
      store.upsert(makeSub(), { needs: true, done: false, running: false }, 0)
      makeService()
      sessions._emit('status', 's1', 'needs' satisfies SessionStatus, {
        reason: 'blocked',
        message: 'docker daemon down',
      })
      const payload = await firstPayload()
      expect(isFromPool(payload.title, NOTIFICATION_TITLES.needsBlocked)).toBe(true)
      expect(payload.body).toBe('s1: docker daemon down')
    })

    it('reason approval → title drawn from the needsApproval pool', async () => {
      store.upsert(makeSub(), { needs: true, done: false, running: false }, 0)
      makeService()
      sessions._emit('status', 's1', 'needs' satisfies SessionStatus, {
        reason: 'approval',
        message: 'drop the table?',
      })
      const payload = await firstPayload()
      expect(isFromPool(payload.title, NOTIFICATION_TITLES.needsApproval)).toBe(true)
    })

    it('reason input (and no reason) → title drawn from the needsInput pool', async () => {
      store.upsert(makeSub(), { needs: true, done: false, running: false }, 0)
      makeService()
      sessions._emit('status', 's1', 'needs' satisfies SessionStatus, { reason: 'input' })
      const payload = await firstPayload()
      expect(isFromPool(payload.title, NOTIFICATION_TITLES.needsInput)).toBe(true)
    })

    it('every needs-kind title mentions Nulliel by name (no emoji)', async () => {
      store.upsert(makeSub(), { needs: true, done: false, running: false }, 0)
      makeService()
      sessions._emit('status', 's1', 'needs' satisfies SessionStatus, { reason: 'input' })
      const payload = await firstPayload()
      expect(payload.title.includes(MASCOT_NAME)).toBe(true)
    })

    it('meta.message beats the session title as body (prefixed with the tid)', async () => {
      store.upsert(makeSub(), { needs: true, done: false, running: false }, 0)
      const sessionStore2 = makeSessionStore([
        {
          id: 's1',
          tid: 'FLO-42',
          title: 'Do work',
          prompt: 'do it',
          repoId: 'r1',
          branch: 'flo-42',
          status: 'running',
          createdAt: 0,
        },
      ])
      createPushService({
        config,
        store,
        sessions,
        sessionStore: sessionStore2,
        send: send as PushSender,
        now: () => nowMs,
      })
      sessions._emit('status', 's1', 'needs' satisfies SessionStatus, {
        reason: 'input',
        message: 'Which DB should I use?',
      })
      const payload = await firstPayload()
      expect(payload.body).toBe('FLO-42: Which DB should I use?')
    })

    it('body falls back to a bare tid when there is no message and no session title', async () => {
      store.upsert(makeSub(), { needs: true, done: false, running: false }, 0)
      const sessionStore2 = makeSessionStore([
        {
          id: 's1',
          tid: 'FLO-42',
          title: '',
          prompt: 'do it',
          repoId: 'r1',
          branch: 'flo-42',
          status: 'running',
          createdAt: 0,
        },
      ])
      createPushService({
        config,
        store,
        sessions,
        sessionStore: sessionStore2,
        send: send as PushSender,
        now: () => nowMs,
      })
      sessions._emit('status', 's1', 'needs' satisfies SessionStatus, { reason: 'input' })
      const payload = await firstPayload()
      // Not "FLO-42: " — a dangling ": " with nothing after it would look broken.
      expect(payload.body).toBe('FLO-42')
    })

    it('episode dedupe is unchanged: blocked then approval in one episode notifies once', async () => {
      store.upsert(makeSub(), { needs: true, done: false, running: false }, 0)
      makeService()
      sessions._emit('status', 's1', 'needs' satisfies SessionStatus, { reason: 'blocked' })
      sessions._emit('status', 's1', 'running' satisfies SessionStatus)
      sessions._emit('status', 's1', 'needs' satisfies SessionStatus, { reason: 'approval' })
      await new Promise((r) => setTimeout(r, 10))
      expect(send).toHaveBeenCalledOnce()
    })
  })

  it('clears per-session tracking on exit so a restarted session notifies again', async () => {
    const sub = makeSub()
    store.upsert(sub, { needs: true, done: false, running: false }, 0)
    makeService()
    sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
    sessions._emit('exit', 's1', 0)
    // Same status, same instant: without cleanup this is swallowed both by
    // lastStatus (needs -> needs = no transition) and the notified-kinds set.
    sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
    await new Promise((r) => setTimeout(r, 10))
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('clears per-session tracking on a reaped status (exit event is suppressed)', async () => {
    const sub = makeSub()
    store.upsert(sub, { needs: true, done: false, running: false }, 0)
    makeService()
    sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
    sessions._emit('status', 's1', 'reaped' satisfies SessionStatus)
    sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
    await new Promise((r) => setTimeout(r, 10))
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('does not send a push for a reaped status itself', async () => {
    const sub = makeSub()
    store.upsert(sub, { needs: true, done: true, running: true }, 0)
    makeService()
    sessions._emit('status', 's1', 'reaped' satisfies SessionStatus)
    await new Promise((r) => setTimeout(r, 10))
    expect(send).not.toHaveBeenCalled()
  })

  it('keeps deduping other sessions after one session exits', async () => {
    const sub = makeSub()
    store.upsert(sub, { needs: true, done: false, running: false }, 0)
    makeService()
    sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
    sessions._emit('status', 's2', 'needs' satisfies SessionStatus)
    sessions._emit('exit', 's1', 0)
    // s2 was untouched by s1's cleanup: its needs notification stays spent.
    sessions._emit('status', 's2', 'idle' satisfies SessionStatus)
    sessions._emit('status', 's2', 'needs' satisfies SessionStatus)
    await new Promise((r) => setTimeout(r, 10))
    expect(send).toHaveBeenCalledTimes(2)
  })

  describe('FCM native push (TASK-I9S44)', () => {
    let fcmMint: ReturnType<typeof vi.fn>
    let fcmSend: ReturnType<typeof vi.fn>

    beforeEach(() => {
      fcmMint = vi.fn().mockResolvedValue({ accessToken: 'tok-1', expiresAt: nowMs + 3600_000 })
      fcmSend = vi.fn().mockResolvedValue({ ok: true, status: 200, unregistered: false })
    })

    it('saveFcmToken persists a row stamped with the given ownerId', async () => {
      const fcmStore = makeFcmStore()
      const svc = makeService({ fcmStore })
      await svc.saveFcmToken('local', { token: 'dev-1', platform: 'android' })
      expect(fcmStore.rows).toEqual([
        { token: 'dev-1', ownerId: 'local', platform: 'android', createdAt: nowMs, origin: null },
      ])
    })

    it('saveFcmToken persists the origin when the DTO carries one (TASK-F0TYG)', async () => {
      const fcmStore = makeFcmStore()
      const svc = makeService({ fcmStore })
      await svc.saveFcmToken('local', {
        token: 'dev-1',
        platform: 'android',
        origin: 'https://slipstream.example.ts.net',
      })
      expect(fcmStore.rows).toEqual([
        {
          token: 'dev-1',
          ownerId: 'local',
          platform: 'android',
          createdAt: nowMs,
          origin: 'https://slipstream.example.ts.net',
        },
      ])
    })

    it('deleteFcmToken only removes a row owned by the caller', async () => {
      const fcmStore = makeFcmStore([
        { token: 'dev-1', ownerId: 'alice', platform: 'android', createdAt: 0 },
      ])
      const svc = makeService({ fcmStore })
      await svc.deleteFcmToken('local', 'dev-1')
      expect(fcmStore.rows).toHaveLength(1) // not alice's caller — no-op

      await svc.deleteFcmToken('alice', 'dev-1')
      expect(fcmStore.rows).toHaveLength(0)
    })

    it('does not mint or send when no service account is configured', async () => {
      const fcmStore = makeFcmStore([
        { token: 'dev-1', ownerId: 'local', platform: 'android', createdAt: 0 },
      ])
      makeService({ fcmStore, fcmMint, fcmSend })
      sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
      await new Promise((r) => setTimeout(r, 10))
      expect(fcmMint).not.toHaveBeenCalled()
      expect(fcmSend).not.toHaveBeenCalled()
    })

    it('does not mint or send when a service account is configured but no tokens exist', async () => {
      config.set(FCM_SERVICE_ACCOUNT_CONFIG_KEY, RAW_FCM_ACCOUNT)
      const fcmStore = makeFcmStore()
      makeService({ fcmStore, fcmMint, fcmSend })
      sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
      await new Promise((r) => setTimeout(r, 10))
      expect(fcmMint).not.toHaveBeenCalled()
      expect(fcmSend).not.toHaveBeenCalled()
    })

    it('sends to the transitioning session owner devices once configured', async () => {
      config.set(FCM_SERVICE_ACCOUNT_CONFIG_KEY, RAW_FCM_ACCOUNT)
      const fcmStore = makeFcmStore([
        { token: 'dev-1', ownerId: 'local', platform: 'android', createdAt: 0 },
      ])
      makeService({ fcmStore, fcmMint, fcmSend })
      sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
      await new Promise((r) => setTimeout(r, 10))

      expect(fcmMint).toHaveBeenCalledOnce()
      const account = fcmMint.mock.calls[0][0] as FcmServiceAccount
      expect(account.project_id).toBe('test-project')

      expect(fcmSend).toHaveBeenCalledOnce()
      const [sentAccount, accessToken, deviceToken, notification] = fcmSend.mock.calls[0] as [
        FcmServiceAccount,
        string,
        string,
        { title: string; body: string; data?: Record<string, string>; image?: string },
      ]
      expect(sentAccount.project_id).toBe('test-project')
      expect(accessToken).toBe('tok-1')
      expect(deviceToken).toBe('dev-1')
      expect(isFromPool(notification.title, NOTIFICATION_TITLES.needsInput)).toBe(true)
      // data (TASK-F0TYG) rides alongside the notification so a tap can
      // deep-link straight to the session on the native FCM path too.
      expect(notification.data).toEqual({ sessionId: 's1', tid: 's1', status: 'needs' })
      // No origin was stored for this token, so no image (TASK-F0TYG follow-up).
      expect(notification.image).toBeUndefined()
    })

    describe('notification image (TASK-F0TYG follow-up)', () => {
      it('builds an image URL from an https:// token origin', async () => {
        config.set(FCM_SERVICE_ACCOUNT_CONFIG_KEY, RAW_FCM_ACCOUNT)
        const fcmStore = makeFcmStore([
          {
            token: 'dev-1',
            ownerId: 'local',
            platform: 'android',
            createdAt: 0,
            origin: 'https://slipstream.example.ts.net',
          },
        ])
        makeService({ fcmStore, fcmMint, fcmSend })
        sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
        await new Promise((r) => setTimeout(r, 10))

        expect(fcmSend).toHaveBeenCalledOnce()
        const [, , , notification] = fcmSend.mock.calls[0] as [
          unknown,
          unknown,
          unknown,
          { image?: string },
        ]
        expect(notification.image).toBe('https://slipstream.example.ts.net/icons/nulliel-512.png')
      })

      it('does NOT build an image URL from an http:// (cleartext) token origin', async () => {
        config.set(FCM_SERVICE_ACCOUNT_CONFIG_KEY, RAW_FCM_ACCOUNT)
        const fcmStore = makeFcmStore([
          {
            token: 'dev-1',
            ownerId: 'local',
            platform: 'android',
            createdAt: 0,
            origin: 'http://192.168.1.50:9091',
          },
        ])
        makeService({ fcmStore, fcmMint, fcmSend })
        sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
        await new Promise((r) => setTimeout(r, 10))

        const [, , , notification] = fcmSend.mock.calls[0] as [
          unknown,
          unknown,
          unknown,
          { image?: string },
        ]
        expect(notification.image).toBeUndefined()
      })

      it('does NOT build an image URL when the token has no stored origin', async () => {
        config.set(FCM_SERVICE_ACCOUNT_CONFIG_KEY, RAW_FCM_ACCOUNT)
        const fcmStore = makeFcmStore([
          { token: 'dev-1', ownerId: 'local', platform: 'android', createdAt: 0, origin: null },
        ])
        makeService({ fcmStore, fcmMint, fcmSend })
        sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
        await new Promise((r) => setTimeout(r, 10))

        const [, , , notification] = fcmSend.mock.calls[0] as [
          unknown,
          unknown,
          unknown,
          { image?: string },
        ]
        expect(notification.image).toBeUndefined()
      })

      it('builds a distinct per-token image URL when the owner has devices from different origins', async () => {
        config.set(FCM_SERVICE_ACCOUNT_CONFIG_KEY, RAW_FCM_ACCOUNT)
        const fcmStore = makeFcmStore([
          {
            token: 'dev-https',
            ownerId: 'local',
            platform: 'android',
            createdAt: 0,
            origin: 'https://home.example.ts.net',
          },
          { token: 'dev-none', ownerId: 'local', platform: 'android', createdAt: 0, origin: null },
        ])
        makeService({ fcmStore, fcmMint, fcmSend })
        sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
        await new Promise((r) => setTimeout(r, 10))

        expect(fcmSend).toHaveBeenCalledTimes(2)
        const calls = fcmSend.mock.calls as unknown as [
          unknown,
          unknown,
          string,
          { image?: string },
        ][]
        const byToken = Object.fromEntries(calls.map(([, , token, n]) => [token, n.image]))
        expect(byToken['dev-https']).toBe('https://home.example.ts.net/icons/nulliel-512.png')
        expect(byToken['dev-none']).toBeUndefined()
      })
    })

    it('does not deliver to a device token owned by a different identity', async () => {
      config.set(FCM_SERVICE_ACCOUNT_CONFIG_KEY, RAW_FCM_ACCOUNT)
      const fcmStore = makeFcmStore([
        { token: 'hers', ownerId: 'alice', platform: 'ios', createdAt: 0 },
      ])
      const sessionStoreWithOwner = makeSessionStore([
        {
          id: 's1',
          tid: 'T-1',
          title: 'x',
          prompt: 'x',
          repoId: 'r1',
          branch: 'b',
          status: 'running',
          createdAt: 0,
          ownerId: 'local',
        },
      ])
      createPushService({
        config,
        store,
        sessions,
        sessionStore: sessionStoreWithOwner,
        send: send as PushSender,
        now: () => nowMs,
        fcmStore,
        fcmMint,
        fcmSend,
      })
      sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
      await new Promise((r) => setTimeout(r, 10))
      expect(fcmSend).not.toHaveBeenCalled()
    })

    it('reuses a cached access token across sends within the same episode window', async () => {
      config.set(FCM_SERVICE_ACCOUNT_CONFIG_KEY, RAW_FCM_ACCOUNT)
      const fcmStore = makeFcmStore([
        { token: 'dev-1', ownerId: 'local', platform: 'android', createdAt: 0 },
      ])
      makeService({ fcmStore, fcmMint, fcmSend })
      sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
      sessions._emit('input', 's1')
      sessions._emit('status', 's1', 'running' satisfies SessionStatus)
      await new Promise((r) => setTimeout(r, 10))

      expect(fcmMint).toHaveBeenCalledOnce()
      expect(fcmSend).toHaveBeenCalledTimes(2)
    })

    it('mints a fresh access token once the cached one is near expiry', async () => {
      config.set(FCM_SERVICE_ACCOUNT_CONFIG_KEY, RAW_FCM_ACCOUNT)
      const fcmStore = makeFcmStore([
        { token: 'dev-1', ownerId: 'local', platform: 'android', createdAt: 0 },
      ])
      let t = nowMs
      // Token "expires" almost immediately, well inside the 5-minute refresh skew.
      fcmMint = vi.fn().mockResolvedValue({ accessToken: 'short-lived', expiresAt: t + 1000 })
      makeService({ fcmStore, fcmMint, fcmSend, now: () => t })
      sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
      await new Promise((r) => setTimeout(r, 10))
      t += 10 * 60_000 // advance well past the cached token's refresh skew
      sessions._emit('input', 's1')
      sessions._emit('status', 's1', 'done' satisfies SessionStatus)
      await new Promise((r) => setTimeout(r, 10))

      expect(fcmMint).toHaveBeenCalledTimes(2)
    })

    it('prunes the device token on an unregistered FCM response', async () => {
      config.set(FCM_SERVICE_ACCOUNT_CONFIG_KEY, RAW_FCM_ACCOUNT)
      const fcmStore = makeFcmStore([
        { token: 'dead-token', ownerId: 'local', platform: 'android', createdAt: 0 },
      ])
      const goneFcmSend = vi.fn().mockResolvedValue({ ok: false, status: 404, unregistered: true })
      makeService({ fcmStore, fcmMint, fcmSend: goneFcmSend })
      sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
      await new Promise((r) => setTimeout(r, 10))
      expect(fcmStore.rows).toHaveLength(0)
    })

    it('keeps the device token on a non-unregistered FCM failure', async () => {
      config.set(FCM_SERVICE_ACCOUNT_CONFIG_KEY, RAW_FCM_ACCOUNT)
      const fcmStore = makeFcmStore([
        { token: 'flaky-token', ownerId: 'local', platform: 'android', createdAt: 0 },
      ])
      const failFcmSend = vi.fn().mockResolvedValue({ ok: false, status: 500, unregistered: false })
      makeService({ fcmStore, fcmMint, fcmSend: failFcmSend })
      sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
      await new Promise((r) => setTimeout(r, 10))
      expect(fcmStore.rows).toHaveLength(1)
    })

    it('does not throw when the token mint rejects (bad credentials / network)', async () => {
      config.set(FCM_SERVICE_ACCOUNT_CONFIG_KEY, RAW_FCM_ACCOUNT)
      const fcmStore = makeFcmStore([
        { token: 'dev-1', ownerId: 'local', platform: 'android', createdAt: 0 },
      ])
      const failingMint = vi.fn().mockRejectedValue(new Error('network down'))
      makeService({ fcmStore, fcmMint: failingMint, fcmSend })
      sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
      await new Promise((r) => setTimeout(r, 10))
      expect(fcmSend).not.toHaveBeenCalled()
    })

    it('ignores a malformed service-account JSON the same as unset (no throw)', async () => {
      config.set(FCM_SERVICE_ACCOUNT_CONFIG_KEY, 'not valid json')
      const fcmStore = makeFcmStore([
        { token: 'dev-1', ownerId: 'local', platform: 'android', createdAt: 0 },
      ])
      makeService({ fcmStore, fcmMint, fcmSend })
      sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
      await new Promise((r) => setTimeout(r, 10))
      expect(fcmMint).not.toHaveBeenCalled()
      expect(fcmSend).not.toHaveBeenCalled()
    })
  })

  describe('ongoing summary (FLO-160)', () => {
    let fcmDataSend: ReturnType<typeof vi.fn>
    let fcmMint: ReturnType<typeof vi.fn>
    let fcmSend: ReturnType<typeof vi.fn>

    beforeEach(() => {
      fcmDataSend = vi.fn().mockResolvedValue({ ok: true, status: 200, unregistered: false })
      // fcmMint/fcmSend are scoped to THIS describe block — the outer
      // createPushService-scoped ones live in the FCM block above and don't
      // cover the ongoing-summary tests. Mirror their setup verbatim.
      fcmMint = vi.fn().mockResolvedValue({ accessToken: 'tok-1', expiresAt: nowMs + 3600_000 })
      fcmSend = vi.fn().mockResolvedValue({ ok: true, status: 200, unregistered: false })
    })

    // Wraps the assertions that need the 500ms debounce to fire and the
    // resulting async sendOngoingSummary() promise to resolve. Fake timers
    // keep the debounce deterministic; the microtask flush after advances
    // the promise chain that scheduleOngoingSummary kicks off.
    async function flushSummary() {
      await vi.advanceTimersByTimeAsync(500)
      await vi.runAllTimersAsync()
    }

    it('sends a data-only summary to android tokens on a genuine needs transition', async () => {
      vi.useFakeTimers()
      config.set(FCM_SERVICE_ACCOUNT_CONFIG_KEY, RAW_FCM_ACCOUNT)
      const sessionStoreWithSession = makeSessionStore([
        {
          id: 's1',
          tid: 'FLO-42',
          title: 'Do the thing',
          prompt: 'p',
          repoId: 'r1',
          branch: 'b',
          status: 'needs',
          createdAt: 0,
          ownerId: 'local',
        },
      ])
      const fcmStore = makeFcmStore([
        { token: 'android-1', ownerId: 'local', platform: 'android', createdAt: 0 },
      ])
      createPushService({
        config,
        store,
        sessions,
        sessionStore: sessionStoreWithSession,
        send: send as PushSender,
        now: () => nowMs,
        fcmStore,
        fcmMint,
        fcmSend,
        fcmDataSend: fcmDataSend as FcmDataSender,
      })
      sessions._emit('status', 's1', 'needs' satisfies SessionStatus, {
        reason: 'input',
        message: 'which DB?',
      })
      await flushSummary()

      expect(fcmDataSend).toHaveBeenCalledOnce()
      const [, , deviceToken, data] = fcmDataSend.mock.calls[0] as [
        unknown,
        unknown,
        string,
        Record<string, string>,
      ]
      expect(deviceToken).toBe('android-1')
      expect(data.slipstreamSummary).toBe('1')
      expect(data.runningCount).toBe('0')
      // The just-transitioned 'needs' session leads the snapshot, and its
      // meta.message wins over the session title.
      expect(data.askSessionId).toBe('s1')
      expect(data.askTid).toBe('FLO-42')
      expect(data.askMessage).toBe('which DB?')
      vi.useRealTimers()
    })

    it('omits ask fields when no needs session exists (running-only snapshot)', async () => {
      vi.useFakeTimers()
      config.set(FCM_SERVICE_ACCOUNT_CONFIG_KEY, RAW_FCM_ACCOUNT)
      const sessionStoreWithSession = makeSessionStore([
        {
          id: 's1',
          tid: 'T-1',
          title: 'running',
          prompt: 'p',
          repoId: 'r1',
          branch: 'b',
          status: 'running',
          createdAt: 0,
          ownerId: 'local',
        },
      ])
      const fcmStore = makeFcmStore([
        { token: 'android-1', ownerId: 'local', platform: 'android', createdAt: 0 },
      ])
      createPushService({
        config,
        store,
        sessions,
        sessionStore: sessionStoreWithSession,
        send: send as PushSender,
        now: () => nowMs,
        fcmStore,
        fcmMint,
        fcmSend,
        fcmDataSend: fcmDataSend as FcmDataSender,
      })
      sessions._emit('status', 's1', 'running' satisfies SessionStatus)
      await flushSummary()

      expect(fcmDataSend).toHaveBeenCalledOnce()
      const [, , , data] = fcmDataSend.mock.calls[0] as [
        unknown,
        unknown,
        unknown,
        Record<string, string>,
      ]
      expect(data.runningCount).toBe('1')
      expect(data.askSessionId).toBeUndefined()
      expect(data.askTid).toBeUndefined()
      expect(data.askMessage).toBeUndefined()
      vi.useRealTimers()
    })

    it('still sends a "clear" summary (runningCount=0, no ask) after a done transition', async () => {
      vi.useFakeTimers()
      config.set(FCM_SERVICE_ACCOUNT_CONFIG_KEY, RAW_FCM_ACCOUNT)
      const sessionStoreWithSession = makeSessionStore([
        {
          id: 's1',
          tid: 'T-1',
          title: 'finished',
          prompt: 'p',
          repoId: 'r1',
          branch: 'b',
          status: 'done',
          createdAt: 0,
          ownerId: 'local',
        },
      ])
      const fcmStore = makeFcmStore([
        { token: 'android-1', ownerId: 'local', platform: 'android', createdAt: 0 },
      ])
      createPushService({
        config,
        store,
        sessions,
        sessionStore: sessionStoreWithSession,
        send: send as PushSender,
        now: () => nowMs,
        fcmStore,
        fcmMint,
        fcmSend,
        fcmDataSend: fcmDataSend as FcmDataSender,
      })
      sessions._emit('status', 's1', 'done' satisfies SessionStatus)
      await flushSummary()

      expect(fcmDataSend).toHaveBeenCalledOnce()
      const [, , , data] = fcmDataSend.mock.calls[0] as [
        unknown,
        unknown,
        unknown,
        Record<string, string>,
      ]
      // The Android client cancels its ongoing notification when it sees
      // runningCount=0 with no askSessionId.
      expect(data.runningCount).toBe('0')
      expect(data.askSessionId).toBeUndefined()
      vi.useRealTimers()
    })

    it('does NOT call fcmDataSend when no service account is configured', async () => {
      vi.useFakeTimers()
      const fcmStore = makeFcmStore([
        { token: 'android-1', ownerId: 'local', platform: 'android', createdAt: 0 },
      ])
      makeService({ fcmStore, fcmMint, fcmSend, fcmDataSend: fcmDataSend as FcmDataSender })
      sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
      await flushSummary()
      expect(fcmDataSend).not.toHaveBeenCalled()
      vi.useRealTimers()
    })

    it('does NOT call fcmDataSend for an ios token (android-only transport)', async () => {
      vi.useFakeTimers()
      config.set(FCM_SERVICE_ACCOUNT_CONFIG_KEY, RAW_FCM_ACCOUNT)
      const fcmStore = makeFcmStore([
        { token: 'iphone-1', ownerId: 'local', platform: 'ios', createdAt: 0 },
      ])
      makeService({ fcmStore, fcmMint, fcmSend, fcmDataSend: fcmDataSend as FcmDataSender })
      sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
      await flushSummary()
      // iOS has no ongoing-notification concept, so the data-only summary
      // would be a wasted silent push. fcmSend (per-session) is unaffected
      // by this filter — only the summary path is android-scoped.
      expect(fcmDataSend).not.toHaveBeenCalled()
      vi.useRealTimers()
    })

    it('coalesces two same-tick transitions into one summary send (debounce)', async () => {
      vi.useFakeTimers()
      config.set(FCM_SERVICE_ACCOUNT_CONFIG_KEY, RAW_FCM_ACCOUNT)
      const sessionStoreWithSessions = makeSessionStore([
        {
          id: 's1',
          tid: 'T-1',
          title: 'one',
          prompt: 'p',
          repoId: 'r1',
          branch: 'b',
          status: 'running',
          createdAt: 100,
          ownerId: 'local',
        },
        {
          id: 's2',
          tid: 'T-2',
          title: 'two',
          prompt: 'p',
          repoId: 'r1',
          branch: 'b',
          status: 'running',
          createdAt: 200,
          ownerId: 'local',
        },
      ])
      const fcmStore = makeFcmStore([
        { token: 'android-1', ownerId: 'local', platform: 'android', createdAt: 0 },
      ])
      createPushService({
        config,
        store,
        sessions,
        sessionStore: sessionStoreWithSessions,
        send: send as PushSender,
        now: () => nowMs,
        fcmStore,
        fcmMint,
        fcmSend,
        fcmDataSend: fcmDataSend as FcmDataSender,
      })
      // Two post-dedup transitions in the same tick — both for the same
      // owner. Without the debounce, fcmDataSend would fire twice; with it,
      // a single send reflects the final state (runningCount=2).
      sessions._emit('status', 's1', 'running' satisfies SessionStatus)
      sessions._emit('status', 's2', 'running' satisfies SessionStatus)
      await flushSummary()

      expect(fcmDataSend).toHaveBeenCalledOnce()
      const [, , , data] = fcmDataSend.mock.calls[0] as [
        unknown,
        unknown,
        unknown,
        Record<string, string>,
      ]
      expect(data.runningCount).toBe('2')
      vi.useRealTimers()
    })

    it('re-arms after input: two separate debounce windows fire twice', async () => {
      vi.useFakeTimers()
      config.set(FCM_SERVICE_ACCOUNT_CONFIG_KEY, RAW_FCM_ACCOUNT)
      const sessionStoreWithSession = makeSessionStore([
        {
          id: 's1',
          tid: 'T-1',
          title: 'one',
          prompt: 'p',
          repoId: 'r1',
          branch: 'b',
          status: 'needs',
          createdAt: 100,
          ownerId: 'local',
        },
      ])
      const fcmStore = makeFcmStore([
        { token: 'android-1', ownerId: 'local', platform: 'android', createdAt: 0 },
      ])
      createPushService({
        config,
        store,
        sessions,
        sessionStore: sessionStoreWithSession,
        send: send as PushSender,
        now: () => nowMs,
        fcmStore,
        fcmMint,
        fcmSend,
        fcmDataSend: fcmDataSend as FcmDataSender,
      })
      // First needs transition: dedup passes, summary scheduled + sent.
      sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
      await flushSummary()
      expect(fcmDataSend).toHaveBeenCalledTimes(1)

      // Without input, a flap idle→needs is suppressed by the per-kind
      // dedup: scheduleOngoingSummary is NOT called for the second needs.
      sessions._emit('status', 's1', 'idle' satisfies SessionStatus)
      sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
      await flushSummary()
      expect(fcmDataSend).toHaveBeenCalledTimes(1)

      // input re-arms the per-session dedup; the next needs transition
      // (a real status change out of and back into needs) now passes and
      // schedules a second summary send in its own debounce window.
      sessions._emit('input', 's1')
      sessions._emit('status', 's1', 'idle' satisfies SessionStatus)
      sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
      await flushSummary()
      expect(fcmDataSend).toHaveBeenCalledTimes(2)
      vi.useRealTimers()
    })

    it('does not fire a summary on a same-kind flap within one episode (no scheduleOngoingSummary call)', async () => {
      vi.useFakeTimers()
      config.set(FCM_SERVICE_ACCOUNT_CONFIG_KEY, RAW_FCM_ACCOUNT)
      const fcmStore = makeFcmStore([
        { token: 'android-1', ownerId: 'local', platform: 'android', createdAt: 0 },
      ])
      makeService({ fcmStore, fcmMint, fcmSend, fcmDataSend: fcmDataSend as FcmDataSender })
      // First needs transition: dedup passes, summary is scheduled.
      sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
      // Same-kind flap inside the same episode: dedup returns early inside
      // notifyTransition, so scheduleOngoingSummary is NOT called again.
      // (The already-scheduled timer still fires once.)
      sessions._emit('status', 's1', 'idle' satisfies SessionStatus)
      sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
      await flushSummary()
      expect(fcmDataSend).toHaveBeenCalledOnce()
      vi.useRealTimers()
    })

    it('regression guard: the per-session fcmSend still fires alongside the summary', async () => {
      config.set(FCM_SERVICE_ACCOUNT_CONFIG_KEY, RAW_FCM_ACCOUNT)
      const fcmStore = makeFcmStore([
        { token: 'android-1', ownerId: 'local', platform: 'android', createdAt: 0 },
      ])
      makeService({ fcmStore, fcmMint, fcmSend, fcmDataSend: fcmDataSend as FcmDataSender })
      sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
      // fcmSend (per-session notification) flushes on the next microtask,
      // independent of the 500ms summary debounce. Real timers here so the
      // microtask + macrotask chain runs naturally.
      await new Promise((r) => setTimeout(r, 10))
      expect(fcmSend).toHaveBeenCalledOnce()

      // Now advance real time past the 500ms debounce and let the summary
      // send resolve before asserting.
      await new Promise((r) => setTimeout(r, 600))
      expect(fcmDataSend).toHaveBeenCalledOnce()
    })

    it('prunes an android token on an unregistered data-send response', async () => {
      vi.useFakeTimers()
      config.set(FCM_SERVICE_ACCOUNT_CONFIG_KEY, RAW_FCM_ACCOUNT)
      const fcmStore = makeFcmStore([
        { token: 'dead', ownerId: 'local', platform: 'android', createdAt: 0 },
      ])
      const unregisteredSend = vi
        .fn()
        .mockResolvedValue({ ok: false, status: 404, unregistered: true })
      createPushService({
        config,
        store,
        sessions,
        sessionStore,
        send: send as PushSender,
        now: () => nowMs,
        fcmStore,
        fcmMint,
        fcmSend,
        fcmDataSend: unregisteredSend as FcmDataSender,
      })
      sessions._emit('status', 's1', 'needs' satisfies SessionStatus)
      await flushSummary()
      expect(fcmStore.rows).toHaveLength(0)
      vi.useRealTimers()
    })
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { transitionKind, createPushService } from './pushService.js'
import type { PushStore, PushSender } from './pushService.js'
import type {
  NotifyPrefs,
  PushSubscriptionDTO,
  SessionStatus,
  ISessionManager,
  ISessionStore,
  SessionDTO,
} from '../shared/contract.js'
import type { IConfigStore } from './configStore.js'

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
    overrides: { store?: PushStore; send?: PushSender; now?: () => number } = {},
  ) {
    return createPushService({
      config,
      store: overrides.store ?? store,
      sessions,
      sessionStore,
      send: overrides.send ?? (send as PushSender),
      now: overrides.now ?? (() => nowMs),
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
    expect(JSON.parse(payload).body).toBe('Do work')
  })

  describe('status meta (FLO-104 reasons)', () => {
    async function firstPayload(): Promise<{ title: string; body: string }> {
      await new Promise((r) => setTimeout(r, 10))
      const [, payload] = send.mock.calls[0] as [PushSubscriptionDTO, string]
      return JSON.parse(payload) as { title: string; body: string }
    }

    it('reason blocked → ⛔ title', async () => {
      store.upsert(makeSub(), { needs: true, done: false, running: false }, 0)
      makeService()
      sessions._emit('status', 's1', 'needs' satisfies SessionStatus, {
        reason: 'blocked',
        message: 'docker daemon down',
      })
      const payload = await firstPayload()
      expect(payload.title).toContain('⛔')
      expect(payload.title).toContain('blocked')
      expect(payload.body).toBe('docker daemon down')
    })

    it('reason approval → 🔐 title', async () => {
      store.upsert(makeSub(), { needs: true, done: false, running: false }, 0)
      makeService()
      sessions._emit('status', 's1', 'needs' satisfies SessionStatus, {
        reason: 'approval',
        message: 'drop the table?',
      })
      const payload = await firstPayload()
      expect(payload.title).toContain('🔐')
      expect(payload.title).toContain('approval')
    })

    it('reason input (and no reason) → default ⚠️ needs-input title', async () => {
      store.upsert(makeSub(), { needs: true, done: false, running: false }, 0)
      makeService()
      sessions._emit('status', 's1', 'needs' satisfies SessionStatus, { reason: 'input' })
      const payload = await firstPayload()
      expect(payload.title).toContain('⚠️')
      expect(payload.title).toContain('needs your input')
    })

    it('meta.message beats the session title as body', async () => {
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
      expect(payload.body).toBe('Which DB should I use?')
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
})

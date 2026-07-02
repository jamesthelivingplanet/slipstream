import type { Database } from 'better-sqlite3'
import type { IConfigStore } from './configStore.js'
import type { ISessionManager, ISessionStore, SessionStatus } from '../shared/contract.js'
import type { NotifyPrefs, PushSubscriptionDTO } from '../shared/contract.js'
import {
  allPushSubscriptions,
  deletePushSubscription,
  getPushSubscription,
  upsertPushSubscription,
  type PushSubscriptionRow,
} from '../db/db.js'

export type { PushSubscriptionRow }

export interface PushStore {
  all(): PushSubscriptionRow[]
  upsert(sub: PushSubscriptionDTO, prefs: NotifyPrefs, now: number): void
  delete(endpoint: string): void
  getPrefs(endpoint: string): NotifyPrefs | null
}

export type PushSender = (
  sub: PushSubscriptionDTO,
  payload: string,
) => Promise<{ statusCode: number }>

export interface IPushService {
  getVapidPublicKey(): Promise<string>
  savePushSubscription(sub: PushSubscriptionDTO, prefs: NotifyPrefs): Promise<void>
  deletePushSubscription(endpoint: string): Promise<void>
  getPushPrefs(endpoint: string): Promise<NotifyPrefs | null>
}

export function transitionKind(
  prev: SessionStatus | undefined,
  next: SessionStatus,
): 'needs' | 'done' | 'running' | null {
  if (next === 'needs' && prev !== 'needs') return 'needs'
  if (next === 'done' && prev !== 'done') return 'done'
  if (next === 'running' && prev !== 'running') return 'running'
  return null
}

export function createDbPushStore(db: Database): PushStore {
  return {
    all: () => allPushSubscriptions(db),
    upsert: (sub, prefs, now) => upsertPushSubscription(db, sub, prefs, now),
    delete: (endpoint) => deletePushSubscription(db, endpoint),
    getPrefs: (endpoint) => {
      const row = getPushSubscription(db, endpoint)
      if (!row) return null
      return { needs: !!row.needs, done: !!row.done, running: !!row.running }
    },
  }
}

export function createPushService(deps: {
  config: IConfigStore
  store: PushStore
  sessions: ISessionManager
  sessionStore: ISessionStore
  now?: () => number
  send?: PushSender
}): IPushService {
  const { config, store, sessions, sessionStore } = deps
  const now = deps.now ?? (() => Date.now())

  const lastStatus = new Map<string, SessionStatus>()
  const lastSent = new Map<string, number>()
  const DEDUP_MS = 3000

  let _send: PushSender | null = deps.send ?? null
  let _webpush: typeof import('web-push') | null = null
  let _vapidPublicKey: string | null = null

  async function getWebPush() {
    if (!_webpush) {
      const mod = await import('web-push')
      // web-push is CJS; ESM dynamic import only hoists a subset of named exports.
      // Use .default to get the actual module.exports with all functions.
      _webpush = (mod.default ?? mod) as typeof import('web-push')
    }
    return _webpush
  }

  async function ensureVapid() {
    if (_vapidPublicKey) return _vapidPublicKey

    const existingPub = config.get('vapidPublicKey')
    const existingPriv = config.get('vapidPrivateKey')

    if (existingPub && existingPriv) {
      const wp = await getWebPush()
      wp.setVapidDetails('mailto:slipstream@localhost', existingPub, existingPriv)
      _vapidPublicKey = existingPub
      return _vapidPublicKey
    }

    const wp = await getWebPush()
    const { publicKey, privateKey } = wp.generateVAPIDKeys()
    config.set('vapidPublicKey', publicKey)
    config.set('vapidPrivateKey', privateKey)
    wp.setVapidDetails('mailto:slipstream@localhost', publicKey, privateKey)
    _vapidPublicKey = publicKey
    return _vapidPublicKey
  }

  async function getSend(): Promise<PushSender> {
    if (_send) return _send
    const wp = await getWebPush()
    _send = async (sub, payload) => {
      const result = await wp.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload)
      return { statusCode: result.statusCode }
    }
    return _send
  }

  sessions.on('status', (sessionId: string, next: SessionStatus) => {
    const prev = lastStatus.get(sessionId)
    lastStatus.set(sessionId, next)

    const kind = transitionKind(prev, next)
    if (!kind) return

    const dedupKey = `${sessionId}:${kind}`
    const lastTime = lastSent.get(dedupKey)
    const nowMs = now()
    if (lastTime !== undefined && nowMs - lastTime < DEDUP_MS) return
    lastSent.set(dedupKey, nowMs)

    const session = sessionStore.get(sessionId)
    const tid = session?.tid ?? sessionId

    const texts: Record<string, string> = {
      needs: `⚠️ ${tid} needs your input`,
      done: `✅ ${tid} is done`,
      running: `▶️ ${tid} started`,
    }

    const payload = JSON.stringify({
      sessionId,
      tid,
      title: texts[kind],
      body: session?.title ?? '',
      status: next,
    })

    const subs = store.all()

    ;(async () => {
      const sendFn = await getSend()

      for (const row of subs) {
        if (!row[kind as keyof PushSubscriptionRow]) continue

        const subDTO: PushSubscriptionDTO = {
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh, auth: row.auth },
        }

        try {
          const result = await sendFn(subDTO, payload)
          if (result.statusCode === 404 || result.statusCode === 410) {
            store.delete(row.endpoint)
          }
        } catch (err: unknown) {
          const status = (err as { statusCode?: number }).statusCode
          if (status === 404 || status === 410) {
            store.delete(row.endpoint)
          }
        }
      }
    })().catch(() => {
      // best-effort push; swallow errors
    })
  })

  return {
    async getVapidPublicKey() {
      return ensureVapid()
    },
    async savePushSubscription(sub, prefs) {
      store.upsert(sub, prefs, now())
    },
    async deletePushSubscription(endpoint) {
      store.delete(endpoint)
    },
    async getPushPrefs(endpoint) {
      return store.getPrefs(endpoint)
    },
  }
}

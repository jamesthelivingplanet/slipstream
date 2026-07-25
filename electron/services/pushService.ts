import type { Database } from 'better-sqlite3'
import type { IConfigStore } from './configStore.js'
import type {
  ISessionManager,
  ISessionStore,
  SessionStatus,
  StatusMeta,
} from '../shared/contract.js'
import type { NotifyPrefs, PushSubscriptionDTO, FcmTokenDTO } from '../shared/contract.js'
import {
  allPushSubscriptions,
  deletePushSubscription,
  getPushSubscription,
  upsertPushSubscription,
  type PushSubscriptionRow,
  allFcmTokens,
  deleteFcmToken as dbDeleteFcmToken,
  upsertFcmToken,
  type FcmTokenRow,
} from '../db/db.js'
import {
  parseServiceAccount,
  mintAccessToken,
  sendFcmMessage,
  sendFcmDataMessage,
  type FcmServiceAccount,
} from './fcm.js'
import { NOTIFICATION_TITLES, pick, type NotificationKind } from '../shared/mascot.js'

export type { PushSubscriptionRow, FcmTokenRow }

/** Snapshot of an owner's live sessions, used to drive the persistent
 *  Android "ongoing" notification (FLO-160). Computed on every genuine
 *  post-dedup transition and sent as a data-only FCM message (no
 *  `notification` block) so the app's FirebaseMessagingService can render
 *  and continuously update a single ongoing shade entry. */
export interface OngoingSnapshot {
  runningCount: number
  topAsk: {
    sessionId: string
    tid: string
    message: string
  } | null
}

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

/** Storage seam for native FCM device tokens (TASK-I9S44) — mirrors PushStore.
 *  `origin` (TASK-F0TYG) is optional/per-call, like FcmTokenDTO's — omitted
 *  when the client couldn't determine a real http(s) origin. */
export interface FcmStore {
  all(): FcmTokenRow[]
  upsert(token: string, ownerId: string, platform: string, now: number, origin?: string): void
  delete(token: string, ownerId: string): void
}

/** Config key holding the raw Firebase service-account JSON. Follows the
 *  existing config-store secret pattern (see configStore.ts's SECRET_KEYS) —
 *  encrypted at rest on desktop, plaintext behind the 0700 data dir on the
 *  headless daemon (docs/SECURITY.md §6). Unset ⇒ the FCM transport is
 *  entirely inert: no token minting, no send attempts, no error logging. */
export const FCM_SERVICE_ACCOUNT_CONFIG_KEY = 'push.fcmServiceAccount'

export type FcmSender = (
  account: FcmServiceAccount,
  accessToken: string,
  deviceToken: string,
  notification: {
    title: string
    body: string
    data?: Record<string, string>
    /** Device-reachable HTTPS URL for the full-color Nulliel image
     *  (TASK-F0TYG) — built per-token from that token's stored origin, so
     *  never present when the origin is missing or not https://. */
    image?: string
  },
) => Promise<{ ok: boolean; status: number; unregistered: boolean }>

export type FcmTokenMinter = (
  account: FcmServiceAccount,
) => Promise<{ accessToken: string; expiresAt: number }>

/** Data-only FCM transport (FLO-160 ongoing summary). Mirrors FcmSender's
 *  shape but the payload is a bare Record<string, string> with NO title/body
 *  — fcm.ts's sendFcmDataMessage omits the `notification` block so FCM does
 *  not auto-display the message, leaving the app's
 *  SlipstreamMessagingService to render the ongoing notification. */
export type FcmDataSender = (
  account: FcmServiceAccount,
  accessToken: string,
  deviceToken: string,
  data: Record<string, string>,
) => Promise<{ ok: boolean; status: number; unregistered: boolean }>

export interface IPushService {
  getVapidPublicKey(): Promise<string>
  savePushSubscription(sub: PushSubscriptionDTO, prefs: NotifyPrefs): Promise<void>
  deletePushSubscription(endpoint: string): Promise<void>
  getPushPrefs(endpoint: string): Promise<NotifyPrefs | null>
  /** Owner-scoped: stamps ownerId on the row (rpc.ts passes the caller's
   *  resolved identity). */
  saveFcmToken(ownerId: string, dto: FcmTokenDTO): Promise<void>
  /** Owner-scoped: a token id belonging to another owner (or unknown) silently
   *  no-ops, matching the no-existence-leak convention (IDENTITY-SEAM.md). */
  deleteFcmToken(ownerId: string, token: string): Promise<void>
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

/** Compute the owner's current ongoing-notification snapshot directly from
 *  the session store. Pure (no I/O, no closure state) so it is unit-testable
 *  without a live sessionManager — FLO-160's summary sender recomputes this
 *  on every post-dedup transition.
 *
 *  `justTransitionedId` / `justTransitionedMeta` are optional hints for the
 *  synchronous path (the moment a transition fires, the just-moved session
 *  is the freshest signal): when the just-transitioned session is now in
 *  `needs`, it wins as `topAsk` and its `meta.message` (if present) is
 *  preferred over the session title. When the synchronous path doesn't
 *  apply (no hint, or the just-transitioned session moved OUT of needs),
 *  we fall back to the most recently created needs session in the store.
 *  `ownerId` defaults to 'local' exactly the same way every other
 *  ownerId read in the codebase does (see IDENTITY-SEAM.md). */
export function computeOngoingSnapshot(
  sessionStore: ISessionStore,
  ownerId: string,
  justTransitionedId?: string,
  justTransitionedMeta?: StatusMeta,
): OngoingSnapshot {
  const sessions = sessionStore.list().filter((s) => (s.ownerId || 'local') === ownerId)
  const runningCount = sessions.filter((s) => s.status === 'running').length

  let topAsk: OngoingSnapshot['topAsk'] = null
  const justTransitioned = justTransitionedId
    ? sessions.find((s) => s.id === justTransitionedId)
    : undefined
  if (justTransitioned && justTransitioned.status === 'needs') {
    topAsk = {
      sessionId: justTransitioned.id,
      tid: justTransitioned.tid,
      message: justTransitionedMeta?.message ?? justTransitioned.title,
    }
  } else {
    // No fresh needs transition to lead with — fall back to the most
    // recently created needs session still pending in the store.
    const needsSessions = sessions
      .filter((s) => s.status === 'needs')
      .sort((a, b) => b.createdAt - a.createdAt)
    if (needsSessions.length > 0) {
      const top = needsSessions[0]
      topAsk = { sessionId: top.id, tid: top.tid, message: top.title }
    }
  }
  return { runningCount, topAsk }
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

export function createDbFcmStore(db: Database): FcmStore {
  return {
    all: () => allFcmTokens(db),
    upsert: (token, ownerId, platform, now, origin) =>
      upsertFcmToken(db, token, ownerId, platform, now, origin),
    delete: (token, ownerId) => dbDeleteFcmToken(db, token, ownerId),
  }
}

/** In-memory no-op store used when the caller doesn't wire a real one (tests
 *  predating TASK-I9S44) — keeps createPushService's fcmStore param optional
 *  without silently losing writes in production (services.ts always passes a
 *  real createDbFcmStore). */
function createInMemoryFcmStore(): FcmStore {
  const rows = new Map<string, FcmTokenRow>()
  return {
    all: () => Array.from(rows.values()),
    upsert: (token, ownerId, platform, now, origin) => {
      rows.set(token, { token, ownerId, platform, createdAt: now, origin: origin ?? null })
    },
    delete: (token, ownerId) => {
      const row = rows.get(token)
      if (row && row.ownerId === ownerId) rows.delete(token)
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
  fcmStore?: FcmStore
  /** Injected for tests — bypasses real RSA signing + network. Defaults to
   *  fcm.ts's mintAccessToken over the global fetch. */
  fcmMint?: FcmTokenMinter
  /** Injected for tests — bypasses real network. Defaults to fcm.ts's
   *  sendFcmMessage over the global fetch. */
  fcmSend?: FcmSender
  /** Injected for tests — bypasses real network for the FLO-160 data-only
   *  ongoing-summary transport. Defaults to fcm.ts's sendFcmDataMessage. */
  fcmDataSend?: FcmDataSender
}): IPushService {
  const { config, store, sessions, sessionStore } = deps
  const now = deps.now ?? (() => Date.now())
  const fcmStore = deps.fcmStore ?? createInMemoryFcmStore()
  const fcmMint: FcmTokenMinter = deps.fcmMint ?? ((account) => mintAccessToken(account, { now }))
  const fcmSend: FcmSender =
    deps.fcmSend ??
    ((account, accessToken, deviceToken, notification) =>
      sendFcmMessage(account, accessToken, deviceToken, notification))
  const fcmDataSend: FcmDataSender =
    deps.fcmDataSend ??
    ((account, accessToken, deviceToken, data) =>
      sendFcmDataMessage(account, accessToken, deviceToken, data))

  const lastStatus = new Map<string, SessionStatus>()
  // Kinds already notified during the session's current "episode". The status
  // detector's heuristics flap on idle TUIs (screen repaint → running, quiet
  // prompt → needs, repeat), so a time-window dedupe re-notifies forever. Each
  // kind fires at most once per episode; an episode ends when the user actually
  // types into the session ('input' event), which re-arms all kinds.
  const notified = new Map<string, Set<'needs' | 'done' | 'running'>>()

  // FLO-160 ongoing-summary debounce: one outstanding timer per owner. A
  // single PTY's status can fire several post-dedup transitions in quick
  // succession (needs → done + exit, two sessions transitioning in the same
  // tick, …) and each would otherwise fan out its own summary send. The
  // throttle coalesces a burst into one send that reads the LATEST snapshot
  // from the store when it fires. Keyed by owner so two users on the same
  // daemon never share a timer. The 500ms window is well under the
  // notification's glanceable staleness budget but long enough to cover a
  // same-tick burst. Mirrors src/lib/widgetSync.ts's leading-edge/throttled-
  // trailing-flush reasoning (and the same status-flap gotcha drives both).
  const ONGOING_SUMMARY_DEBOUNCE_MS = 500
  const pendingOngoingSummary = new Map<string, ReturnType<typeof setTimeout>>()
  // Latest transition captured per owner while a timer is outstanding. The
  // timer reads this at fire time so computeOngoingSnapshot's "just-
  // transitioned" fast-path still wins for the freshest ask (carrying its
  // meta.message, which the store-only fallback path can't recover). Only
  // the most recent transition per owner is kept — earlier ones in the same
  // burst are superseded, which is the right thing when coalescing.
  const pendingOngoingTransition = new Map<string, { sessionId: string; meta?: StatusMeta }>()

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

  // ── FCM (native push, TASK-I9S44) ─────────────────────────────────────────
  // Inert by construction: getFcmAccount() returns null (no throw, no log)
  // whenever push.fcmServiceAccount is unset or fails to parse, and every
  // caller below short-circuits on null before touching the network.

  let _fcmAccountRaw: string | undefined
  let _fcmAccount: FcmServiceAccount | null = null

  function getFcmAccount(): FcmServiceAccount | null {
    const raw = config.get(FCM_SERVICE_ACCOUNT_CONFIG_KEY)
    if (raw === _fcmAccountRaw) return _fcmAccount
    _fcmAccountRaw = raw
    _fcmAccount = raw ? parseServiceAccount(raw) : null
    return _fcmAccount
  }

  // Refresh a bit before actual expiry so a send never races token expiry.
  const FCM_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000
  let _fcmTokenCache: { accountKey: string; accessToken: string; expiresAt: number } | null = null
  // Two status transitions can fire in the same tick (e.g. needs → running
  // back to back), each kicking off its own notifyTransition IIFE; without
  // this, both would see the cache as empty and mint concurrently. Coalesce
  // concurrent misses onto one in-flight mint.
  let _fcmMintInFlight: Promise<string> | null = null

  async function ensureFcmAccessToken(account: FcmServiceAccount): Promise<string> {
    const accountKey = `${account.project_id}:${account.client_email}`
    const cached = _fcmTokenCache
    if (
      cached &&
      cached.accountKey === accountKey &&
      cached.expiresAt - FCM_TOKEN_REFRESH_SKEW_MS > now()
    ) {
      return cached.accessToken
    }
    if (_fcmMintInFlight) return _fcmMintInFlight

    _fcmMintInFlight = (async () => {
      try {
        const { accessToken, expiresAt } = await fcmMint(account)
        _fcmTokenCache = { accountKey, accessToken, expiresAt }
        return accessToken
      } finally {
        _fcmMintInFlight = null
      }
    })()
    return _fcmMintInFlight
  }

  /** Device-reachable image URL for the notification's full-color Nulliel
   *  picture (TASK-F0TYG), built from a token's stored origin — or undefined
   *  to degrade to no-picture. Deliberately narrow: only https:// origins,
   *  since the Android FCM SDK fetches the image directly from the device
   *  and cleartext http(s) isn't reliably reachable/permitted there; a
   *  missing/http origin must never turn into a send error. */
  function fcmImageUrl(origin: string | null): string | undefined {
    if (!origin || !origin.startsWith('https://')) return undefined
    return `${origin}/icons/nulliel-512.png`
  }

  /** Fan out one notification to every FCM token owned by `ownerId`. Never
   *  throws — a mint/network failure is swallowed the same way the web-push
   *  loop swallows per-subscription failures. */
  async function sendFcmForOwner(
    ownerId: string,
    notification: { title: string; body: string; data?: Record<string, string> },
  ): Promise<void> {
    const account = getFcmAccount()
    if (!account) return

    const tokens = fcmStore.all().filter((row) => (row.ownerId || 'local') === ownerId)
    if (tokens.length === 0) return

    let accessToken: string
    try {
      accessToken = await ensureFcmAccessToken(account)
    } catch {
      // bad credentials / network — best-effort, swallow (matches web-push)
      return
    }

    for (const row of tokens) {
      try {
        // image is per-token, not per-notification: two devices for the same
        // owner can have registered from different origins (tailnet host,
        // LAN IP, …), so it's computed inside the loop rather than once.
        const image = fcmImageUrl(row.origin)
        const result = await fcmSend(account, accessToken, row.token, {
          ...notification,
          ...(image ? { image } : {}),
        })
        if (result.unregistered) fcmStore.delete(row.token, row.ownerId)
      } catch {
        // best-effort per-token; swallow and continue with the rest
      }
    }
  }

  /** Fan out one ongoing-summary data-only message to every Android FCM
   *  token owned by `ownerId`. iOS tokens are deliberately excluded — iOS
   *  has no "ongoing notification" concept, so a data-only message there is
   *  a wasted silent push (and would burn APNs budget for nothing). Never
   *  throws — same best-effort contract as sendFcmForOwner. */
  async function sendOngoingSummary(ownerId: string, snapshot: OngoingSnapshot): Promise<void> {
    const account = getFcmAccount()
    if (!account) return

    const tokens = fcmStore
      .all()
      .filter((row) => (row.ownerId || 'local') === ownerId && row.platform === 'android')
    if (tokens.length === 0) return

    let accessToken: string
    try {
      accessToken = await ensureFcmAccessToken(account)
    } catch {
      return
    }

    // Data contract — pinned by mobile/.../SlipstreamMessagingService.java's
    // parser. `slipstreamSummary: '1'` is the marker that routes the message
    // to the ongoing-notification path on the device; runningCount is always
    // present (so the client can cancel when it is 0 and no ask remains);
    // ask fields ride along only when there is a top ask.
    const data: Record<string, string> = {
      slipstreamSummary: '1',
      runningCount: String(snapshot.runningCount),
    }
    if (snapshot.topAsk) {
      data.askSessionId = snapshot.topAsk.sessionId
      data.askTid = snapshot.topAsk.tid
      data.askMessage = snapshot.topAsk.message
    }

    for (const row of tokens) {
      try {
        const result = await fcmDataSend(account, accessToken, row.token, data)
        if (result.unregistered) fcmStore.delete(row.token, row.ownerId)
      } catch {
        // best-effort per-token; swallow and continue
      }
    }
  }

  /** Coalesce a burst of post-dedup transitions into one summary send. Reads
   *  the LATEST store snapshot when the timer fires (rather than the snapshot
   *  at schedule time), so two transitions in the same tick produce one send
   *  reflecting the final state. `justTransitionedId`/`meta` are captured per
   *  owner and replayed into computeOngoingSnapshot at fire time so the
   *  freshest needs ask still carries its `meta.message` — the store-only
   *  fallback path can recover the session but not the sentinel's message.
   *  sessionPersistence (wired BEFORE this listener in services.ts) has
   *  already written every recent status into the store by the time the
   *  timer fires. */
  function scheduleOngoingSummary(
    ownerId: string,
    justTransitionedId: string,
    meta?: StatusMeta,
  ): void {
    pendingOngoingTransition.set(ownerId, { sessionId: justTransitionedId, meta })
    const existing = pendingOngoingSummary.get(ownerId)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      pendingOngoingSummary.delete(ownerId)
      const last = pendingOngoingTransition.get(ownerId)
      pendingOngoingTransition.delete(ownerId)
      const snapshot = computeOngoingSnapshot(sessionStore, ownerId, last?.sessionId, last?.meta)
      // best-effort; never let a send failure poison the next transition
      sendOngoingSummary(ownerId, snapshot).catch(() => {
        // swallow — matches sendFcmForOwner's error contract
      })
    }, ONGOING_SUMMARY_DEBOUNCE_MS)
    pendingOngoingSummary.set(ownerId, timer)
  }

  /** Drop all per-session tracking state so the long-lived daemon's maps don't
   *  grow unboundedly with every session ever seen. */
  function forgetSession(sessionId: string) {
    lastStatus.delete(sessionId)
    notified.delete(sessionId)
  }

  sessions.on('exit', (sessionId: string) => {
    forgetSession(sessionId)
  })

  // User typed into the session — they're engaged, so the next genuine
  // transition of any kind deserves a fresh notification.
  sessions.on('input', (sessionId: string) => {
    notified.delete(sessionId)
  })

  sessions.on('status', (sessionId: string, next: SessionStatus, meta?: StatusMeta) => {
    const prev = lastStatus.get(sessionId)
    lastStatus.set(sessionId, next)

    const kind = transitionKind(prev, next)
    if (kind) notifyTransition(sessionId, next, kind, meta)

    // Reaped sessions suppress their 'exit' event (sessionManager.reap sets
    // disposed before killing the PTY), so clean up here instead — after the
    // transition handling above so dedupe still works during the transition.
    if (next === 'reaped') forgetSession(sessionId)
  })

  function notifyTransition(
    sessionId: string,
    next: SessionStatus,
    kind: 'needs' | 'done' | 'running',
    meta?: StatusMeta,
  ) {
    // Episode dedupe is per KIND, not per reason: a blocked→approval sequence
    // within one episode notifies once (both are `needs`). Accepted trade-off —
    // re-arming on reason change would re-notify on detector flaps too.
    const seen = notified.get(sessionId) ?? new Set<'needs' | 'done' | 'running'>()
    if (seen.has(kind)) return
    seen.add(kind)
    notified.set(sessionId, seen)

    const session = sessionStore.get(sessionId)
    const tid = session?.tid ?? sessionId
    // Owner scope for both the per-session notification fan-out below AND the
    // ongoing summary (defaults to 'local', same fallback as every other
    // ownerId read — see IDENTITY-SEAM.md).
    const ownerId = session?.ownerId || 'local'
    // The ongoing summary hangs off THIS dedup check (never a raw status
    // subscription — see CLAUDE.md's status-flapping gotcha). Only a real,
    // post-dedup transition schedules a summary refresh, so the persistent
    // Android notification reflects genuine episode transitions rather than
    // flickering on every PTY chunk.
    scheduleOngoingSummary(ownerId, sessionId, meta)

    // meta.reason still picks the needs flavor (blocked/approval/plain input);
    // the resulting NotificationKind only selects which mascot.ts pool the
    // title is drawn from — it does NOT feed the episode dedupe above, which
    // stays keyed on the coarser 'needs'|'done'|'running' kind.
    const notifKind: NotificationKind =
      kind === 'needs'
        ? meta?.reason === 'blocked'
          ? 'needsBlocked'
          : meta?.reason === 'approval'
            ? 'needsApproval'
            : 'needsInput'
        : kind
    // Seeded on sessionId + notifKind (not wall-clock or Math.random) so the
    // same episode always renders the same line — see mascot.ts's pick().
    const title = pick(NOTIFICATION_TITLES[notifKind], `${sessionId}:${notifKind}`)
    // The concrete session id stays visible in the body even though the
    // title is now Nulliel's playful hook rather than a per-kind fact —
    // several sessions can notify at once. The agent's own message (why it
    // stopped) beats the ticket title. Falls back to a bare tid (no dangling
    // "TASK-X: ") when neither is available.
    const detail = meta?.message ?? session?.title ?? ''
    const body = detail ? `${tid}: ${detail}` : tid

    const payload = JSON.stringify({
      sessionId,
      tid,
      title,
      body,
      status: next,
    })

    const subs = store.all()
    // data rides alongside notification (TASK-F0TYG) so a tap on the native
    // notification can deep-link straight to this session — see fcm.ts and
    // src/lib/push.ts's pushNotificationActionPerformed listener.
    const fcmNotification = { title, body, data: { sessionId, tid, status: next } }

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

      await sendFcmForOwner(ownerId, fcmNotification)
    })().catch(() => {
      // best-effort push; swallow errors
    })
  }

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
    async saveFcmToken(ownerId, dto) {
      fcmStore.upsert(dto.token, ownerId, dto.platform, now(), dto.origin)
    },
    async deleteFcmToken(ownerId, token) {
      fcmStore.delete(token, ownerId)
    },
  }
}

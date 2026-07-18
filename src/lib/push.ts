import type { NotifyPrefs, PushSubscriptionDTO } from '../../electron/shared/contract.js'
import {
  getVapidPublicKey,
  savePushSubscription,
  deletePushSubscription,
  getPushPrefs,
  saveFcmToken,
  deleteFcmToken,
} from './ipc'
import { pushToast } from './toast'
import { nativeStorage, FCM_KEY } from './nativeStorage'
import { openAgentById } from './stores'

// ── Native push bridge (TASK-I9S44) ─────────────────────────────────────────
//
// The mobile app is a Capacitor shell whose WebView loads this SAME SPA over
// the tailnet — there is no separate mobile build. When running inside that
// shell, window.Capacitor and window.Capacitor.Plugins.PushNotifications are
// injected into the page at runtime; a plain browser or the Electron webview
// never sets window.Capacitor at all. So this module feature-detects the
// bridge rather than importing @capacitor/* — src/ must stay free of any
// @capacitor/* npm dependency (a browser tab loading this same bundle must
// never even attempt to resolve it).

interface CapacitorPushToken {
  value: string
}

interface CapacitorPushPermissionStatus {
  receive: 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale'
}

interface CapacitorPluginListenerHandle {
  remove(): void | Promise<void>
}

/** Shape of the tapped notification as delivered by the Capacitor plugin —
 *  only the `data` field is used here, which carries through the raw FCM
 *  `data` block (TASK-F0TYG) sent by fcm.ts's sendFcmMessage. */
interface CapacitorPushActionPerformed {
  actionId: string
  notification: {
    data?: Record<string, string>
  }
}

interface CapacitorPushNotificationsPlugin {
  requestPermissions(): Promise<CapacitorPushPermissionStatus>
  register(): Promise<void>
  addListener(
    eventName: 'registration',
    listenerFunc: (token: CapacitorPushToken) => void,
  ): Promise<CapacitorPluginListenerHandle>
  addListener(
    eventName: 'registrationError',
    listenerFunc: (error: { error: string }) => void,
  ): Promise<CapacitorPluginListenerHandle>
  addListener(
    eventName: 'pushNotificationActionPerformed',
    listenerFunc: (action: CapacitorPushActionPerformed) => void,
  ): Promise<CapacitorPluginListenerHandle>
}

interface CapacitorGlobal {
  isPluginAvailable?(name: string): boolean
  getPlatform?(): string
  Plugins?: {
    PushNotifications?: CapacitorPushNotificationsPlugin
  }
}

declare global {
  interface Window {
    Capacitor?: CapacitorGlobal
  }
}

// Pre-TASK-I9S44, this record lived as a bare token string under this
// localStorage key (the WebView had no native storage, so it went through
// the same plain-localStorage path a browser tab would). Now the record
// moves to the nativeStorage facade's FCM_KEY ('slipstream.fcm', a JSON
// `{token, enabled}` string) — see nativeStorage.ts. migrateFcmRecord() below
// copies a pre-existing legacy token forward once, wrapping it in the new
// JSON shape; the legacy key is left in place (harmless).
const LEGACY_FCM_TOKEN_KEY = 'slipstream.fcmToken'

interface FcmRecord {
  token: string
  enabled: boolean
}

// migrateLegacy() itself is idempotent (it checks the new key first and
// no-ops once populated), so this is safe to call on every read.
async function migrateFcmRecord(): Promise<void> {
  await nativeStorage.migrateLegacy(FCM_KEY, LEGACY_FCM_TOKEN_KEY, (legacyToken) =>
    JSON.stringify({ token: legacyToken, enabled: true }),
  )
}

async function readFcmRecord(): Promise<FcmRecord | null> {
  await migrateFcmRecord()
  let raw: string | null
  try {
    raw = await nativeStorage.get(FCM_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<FcmRecord>
    if (typeof parsed.token !== 'string') return null
    return { token: parsed.token, enabled: parsed.enabled !== false }
  } catch {
    return null
  }
}

async function rememberNativeToken(token: string): Promise<void> {
  try {
    await nativeStorage.set(FCM_KEY, JSON.stringify({ token, enabled: true } satisfies FcmRecord))
  } catch {
    // ignore — private browsing / storage disabled; disablePush just won't
    // be able to target the exact token, the daemon still prunes dead tokens
  }
}

async function forgetNativeToken(): Promise<void> {
  try {
    await nativeStorage.remove(FCM_KEY, LEGACY_FCM_TOKEN_KEY)
  } catch {
    // ignore
  }
}

function nativePushPlugin(): CapacitorPushNotificationsPlugin | undefined {
  return window.Capacitor?.Plugins?.PushNotifications
}

/** True only inside the Capacitor mobile shell — a plain browser or the
 *  Electron renderer never sets window.Capacitor, so this is false there and
 *  the rest of this module's web-push path is unaffected. */
export function nativePushAvailable(): boolean {
  return (
    typeof window !== 'undefined' && !!window.Capacitor?.isPluginAvailable?.('PushNotifications')
  )
}

/** Best-effort persisted state: true once we've saved a token this device
 *  and haven't since disabled it. Survives reload (nativeStorage facade —
 *  Preferences on the mobile shell, localStorage on the web), so the
 *  Settings toggle reflects reality without an extra round-trip. */
export async function nativePushEnabled(): Promise<boolean> {
  const record = await readFcmRecord()
  return !!record?.enabled
}

function nativePlatform(): 'android' | 'ios' {
  return window.Capacitor?.getPlatform?.() === 'ios' ? 'ios' : 'android'
}

// Tracks the plugin instance we've already bound listeners on (rather than a
// plain boolean) so repeated enableNativePush() calls against the SAME bridge
// don't double-register, while a different instance rebinds correctly.
// window.Capacitor is a stable singleton for the app's lifetime in practice,
// but tracking the instance keeps this correct rather than assuming that.
let listenersBoundFor: CapacitorPushNotificationsPlugin | null = null

/** Request permission, register with FCM/APNs via the Capacitor bridge, and
 *  persist the resulting device token via the saveFcmToken RPC. Token
 *  rotation is handled the same way: the 'registration' listener fires again
 *  with the new value and we just re-save (upsert, deduped by token). */
export async function enableNativePush(): Promise<{ ok: boolean; reason?: string }> {
  const plugin = nativePushPlugin()
  if (!plugin) return { ok: false, reason: 'unsupported' }

  try {
    const perm = await plugin.requestPermissions()
    if (perm.receive !== 'granted') return { ok: false, reason: 'denied' }

    if (listenersBoundFor !== plugin) {
      listenersBoundFor = plugin
      await plugin.addListener('registration', (token) => {
        rememberNativeToken(token.value).catch(() => {
          // best-effort persistence; saveFcmToken below is the source of
          // truth server-side, this is just the local "am I enabled" flag
        })
        saveFcmToken({ token: token.value, platform: nativePlatform() }).catch(() => {
          pushToast('error', 'Could not save the push token.')
        })
      })
      await plugin.addListener('registrationError', (error) => {
        pushToast('error', `Push registration failed: ${error?.error ?? 'unknown error'}`)
      })
      // Native tap deep-link (TASK-F0TYG): mirrors the web-push path (SW
      // notificationclick -> postMessage -> App.svelte -> openAgentById),
      // sharing the same open-agent function so both transports behave
      // identically. sessionId rides through as-sent in fcm.ts's `data`.
      await plugin.addListener('pushNotificationActionPerformed', (action) => {
        const sessionId = action?.notification?.data?.sessionId
        if (sessionId) openAgentById(sessionId)
      })
    }

    await plugin.register()
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'Unknown error' }
  }
}

/** Delete the last-registered device token, if any. Best-effort: the
 *  Capacitor plugin has no "current token" getter, so this relies on the
 *  value captured by the 'registration' listener (persisted across reloads
 *  via the nativeStorage facade). A token that outlives this — e.g. the app
 *  was uninstalled without disabling first — is still pruned server-side on
 *  its next FCM 404/UNREGISTERED response. */
export async function disableNativePush(): Promise<void> {
  const record = await readFcmRecord()
  if (!record) return
  await deleteFcmToken(record.token)
  await forgetNativeToken()
}

export function pushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const arr = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr
}

export async function getRegistration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.ready
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await getRegistration()
  return reg.pushManager.getSubscription()
}

export async function enablePush(prefs: NotifyPrefs): Promise<{ ok: boolean; reason?: string }> {
  if (!pushSupported()) return { ok: false, reason: 'unsupported' }

  let perm: NotificationPermission
  try {
    perm = await Notification.requestPermission()
  } catch {
    return { ok: false, reason: 'denied' }
  }
  if (perm !== 'granted') return { ok: false, reason: 'denied' }

  try {
    const reg = await getRegistration()
    let sub = await reg.pushManager.getSubscription()
    if (!sub) {
      const vapidKey = await getVapidPublicKey()
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey).buffer as ArrayBuffer,
      })
    }
    const json = sub.toJSON()
    const keys = json.keys as { p256dh: string; auth: string }
    const dto: PushSubscriptionDTO = {
      endpoint: sub.endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
    }
    await savePushSubscription(dto, prefs)
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'Unknown error' }
  }
}

export async function updatePrefs(prefs: NotifyPrefs): Promise<boolean> {
  const sub = await currentSubscription()
  if (!sub) return false
  const json = sub.toJSON()
  const keys = json.keys as { p256dh: string; auth: string }
  const dto: PushSubscriptionDTO = {
    endpoint: sub.endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
  }
  await savePushSubscription(dto, prefs)
  return true
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription()
  if (!sub) return
  await deletePushSubscription(sub.endpoint)
  await sub.unsubscribe()
}

export async function loadPrefs(): Promise<NotifyPrefs | null> {
  const sub = await currentSubscription()
  if (!sub) return null
  return getPushPrefs(sub.endpoint)
}

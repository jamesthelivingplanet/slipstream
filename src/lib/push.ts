import type { NotifyPrefs, PushSubscriptionDTO } from '../../electron/shared/contract.js'
import {
  getVapidPublicKey,
  savePushSubscription,
  deletePushSubscription,
  getPushPrefs,
} from './ipc'

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

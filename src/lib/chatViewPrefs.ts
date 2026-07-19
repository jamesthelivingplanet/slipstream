// Global, cross-session preference for the chat view toggle (TASK-FPH60).
// Shaped exactly like fabPrefs.ts: a writable store is the live source of
// truth, nativeStorage is just the durable backing store, read once and
// mirrored into the store below.
import { writable } from 'svelte/store'
import { nativeStorage } from './nativeStorage'

export const CHAT_VIEW_PREF_KEY = 'slipstream.chatViewMode'

/** Per-user preference: prefer chat view over terminal when a session
 *  supports it (TASK-FPH60). Default false — terminal remains the default. */
export const preferChatView = writable(false)

let loadPromise: Promise<void> | null = null

export function initChatViewPref(): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const stored = await nativeStorage.get(CHAT_VIEW_PREF_KEY)
        if (stored !== null) preferChatView.set(stored !== '0')
      } catch {
        // best-effort; default (false) already set synchronously above
      }
    })()
  }
  return loadPromise
}

export async function setPreferChatView(value: boolean): Promise<void> {
  preferChatView.set(value)
  await nativeStorage.set(CHAT_VIEW_PREF_KEY, value ? '1' : '0')
}

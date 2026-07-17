// Two persisted, cross-component prefs for the mobile "New agent" FAB
// (TASK-I9S44): whether it renders as the pixel angel or a plain material
// disc, and whether it occasionally shows Clippy-style tips. Shaped like
// theme.ts — a writable store is the live source of truth so any component
// (NewAgentFab.svelte, the settings toggle) reflects a change instantly with
// no reload; nativeStorage is just the durable backing store, read once and
// mirrored into the stores below.
import { writable } from 'svelte/store'
import { nativeStorage } from './nativeStorage'
import { FAB_ANGEL_ENABLED_KEY, FAB_TIPS_ENABLED_KEY } from './fabTips'

export const fabAngelEnabled = writable(true)
export const fabTipsEnabled = writable(true)

let loadPromise: Promise<void> | null = null

/** Loads both prefs from nativeStorage into the stores above. Safe to call
 *  from multiple components (NewAgentFab.svelte and the settings tab both
 *  do) — the underlying fetch only ever happens once per session. */
export function initFabPrefs(): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const [angel, tips] = await Promise.all([
          nativeStorage.get(FAB_ANGEL_ENABLED_KEY),
          nativeStorage.get(FAB_TIPS_ENABLED_KEY),
        ])
        if (angel !== null) fabAngelEnabled.set(angel !== '0')
        if (tips !== null) fabTipsEnabled.set(tips !== '0')
      } catch {
        // best-effort; default (both on) already set synchronously above
      }
    })()
  }
  return loadPromise
}

export async function setFabAngelEnabled(value: boolean): Promise<void> {
  fabAngelEnabled.set(value)
  await nativeStorage.set(FAB_ANGEL_ENABLED_KEY, value ? '1' : '0')
}

export async function setFabTipsEnabled(value: boolean): Promise<void> {
  fabTipsEnabled.set(value)
  await nativeStorage.set(FAB_TIPS_ENABLED_KEY, value ? '1' : '0')
}

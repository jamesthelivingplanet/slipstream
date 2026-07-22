// Facade for persisting a few pieces of client state — the auth token, the
// FCM push record, and the server URL override — outside origin-bound
// localStorage when running inside the Capacitor mobile shell (TASK-I9S44).
// The server URL override is also read/written on plain web (TASK-0HDEW):
// nativeStorage falls back to localStorage there, same as every other key.
//
// Same rationale as push.ts: the mobile app's WebView loads this SAME SPA
// over the tailnet — there is no separate mobile build. window.Capacitor
// (and the plugins under window.Capacitor.Plugins) are injected into the
// page at runtime only inside that shell; a plain browser, the installed
// PWA, or the Electron renderer never set window.Capacitor. So this module
// feature-detects the bridge at runtime rather than importing @capacitor/*
// — src/ must stay free of any @capacitor/* npm dependency (a browser tab
// loading this same bundle must never even attempt to resolve it).
//
// Resolution order for a given key:
//   1. Secure-storage plugin (@aparajita/capacitor-secure-storage, exposed
//      as window.Capacitor.Plugins.SecureStorage) — TOKEN_KEY only.
//   2. Preferences plugin (@capacitor/preferences, Plugins.Preferences).
//   3. localStorage.
// Each native tier is optional even when the bridge exists — an older APK
// predating one of these plugins must still work — so every native call is
// wrapped and falls through on absence or failure.

/** Secure-storage key for the auth token (Keystore-backed on Android). */
export const TOKEN_KEY = 'slipstream.token'
/** Preferences key for the server URL override — set by the token gate (web)
 *  and the mobile Server settings tab; web boot derives the RPC WS URL from
 *  it. */
export const DAEMON_URL_KEY = 'slipstream.daemonUrl'
/** Preferences key for the last-registered FCM record, JSON `{token, enabled}`. */
export const FCM_KEY = 'slipstream.fcm'
/** Preferences key for in-progress 'New agent' drafts, JSON array of Session
 *  objects with status 'idle' — so a page reload (which drops the renderer
 *  store entirely) doesn't silently wipe an unsent kickoff prompt (FLO-114). */
export const DRAFTS_KEY = 'slipstream.drafts'

interface CapacitorPreferencesPlugin {
  get(options: { key: string }): Promise<{ value: string | null }>
  set(options: { key: string; value: string }): Promise<void>
  remove(options: { key: string }): Promise<void>
}

interface CapacitorSecureStoragePlugin {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

interface CapacitorAppControlPlugin {
  restart(): Promise<void>
}

interface CapacitorGlobal {
  isPluginAvailable?(name: string): boolean
  Plugins?: {
    Preferences?: CapacitorPreferencesPlugin
    SecureStorage?: CapacitorSecureStoragePlugin
    AppControl?: CapacitorAppControlPlugin
  }
}

function cap(): CapacitorGlobal | undefined {
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor
}

/** True only inside the Capacitor mobile shell. Mirrors push.ts's
 *  nativePushAvailable() — false for a plain browser, the installed PWA, or
 *  the Electron renderer. */
export function isNativeShell(): boolean {
  return typeof window !== 'undefined' && !!cap()
}

function preferencesPlugin(): CapacitorPreferencesPlugin | undefined {
  return cap()?.Plugins?.Preferences
}

function secureStoragePlugin(): CapacitorSecureStoragePlugin | undefined {
  return cap()?.Plugins?.SecureStorage
}

function appControlPlugin(): CapacitorAppControlPlugin | undefined {
  return cap()?.Plugins?.AppControl
}

/** Read a key from the native tiers only (secure storage for TOKEN_KEY, then
 *  Preferences) — never touches localStorage. Returns null if no native tier
 *  is available/has the key, so callers can tell "not in native storage"
 *  apart from "native storage unavailable, ask localStorage instead". */
async function getNativeTier(key: string): Promise<string | null> {
  if (key === TOKEN_KEY) {
    const secure = secureStoragePlugin()
    if (secure) {
      try {
        const value = await secure.getItem(key)
        if (value != null) return value
      } catch {
        // fall through to Preferences
      }
    }
  }

  const prefs = preferencesPlugin()
  if (prefs) {
    try {
      const { value } = await prefs.get({ key })
      if (value != null) return value
    } catch {
      // fall through
    }
  }

  return null
}

/** Write a key to the first available native tier. Returns true if it was
 *  actually written natively; false means no native plugin was available and
 *  the caller should fall back to localStorage itself. */
async function setNativeTier(key: string, value: string): Promise<boolean> {
  if (key === TOKEN_KEY) {
    const secure = secureStoragePlugin()
    if (secure) {
      try {
        await secure.setItem(key, value)
        return true
      } catch {
        // fall through to Preferences
      }
    }
  }

  const prefs = preferencesPlugin()
  if (prefs) {
    try {
      await prefs.set({ key, value })
      return true
    } catch {
      // fall through
    }
  }

  return false
}

/** Best-effort remove from every native tier that might hold the key. */
async function removeNativeTier(key: string): Promise<void> {
  if (key === TOKEN_KEY) {
    const secure = secureStoragePlugin()
    if (secure) {
      try {
        await secure.removeItem(key)
      } catch {
        // ignore
      }
    }
  }

  const prefs = preferencesPlugin()
  if (prefs) {
    try {
      await prefs.remove({ key })
    } catch {
      // ignore
    }
  }
}

function localStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function localStorageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // ignore — private browsing / storage disabled
  }
}

function localStorageRemove(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

/** Full 3-tier read: native (secure/Preferences) → localStorage[key]. */
async function get(key: string): Promise<string | null> {
  const native = await getNativeTier(key)
  if (native != null) return native
  return localStorageGet(key)
}

/** Full 3-tier write: a native plugin wins if one is available, otherwise
 *  localStorage[key]. Never writes to more than one tier, so there is a
 *  single source of truth for the key at any time. */
async function set(key: string, value: string): Promise<void> {
  const wroteNative = await setNativeTier(key, value)
  if (!wroteNative) localStorageSet(key, value)
}

/** Remove the key from every tier (native + localStorage), so a stale value
 *  never lingers behind after a tier switch (e.g. an APK gains the secure
 *  storage plugin between installs). Pass `legacyKey` for values that went
 *  through migrateLegacy() so the pre-migration localStorage copy is cleared
 *  too — otherwise the next migrateLegacy() call would resurrect it (a
 *  logout/disable must actually stick). */
async function remove(key: string, legacyKey?: string): Promise<void> {
  await removeNativeTier(key)
  localStorageRemove(key)
  if (legacyKey) localStorageRemove(legacyKey)
}

/** One-time migration for a key that used to live under a different
 *  localStorage name (pre-TASK-I9S44, everything — including inside the
 *  Capacitor WebView — went through plain localStorage). If `key` is not yet
 *  set in the facade but `legacyKey` has a value in localStorage, copy it
 *  forward via `set()` (best native tier available, or localStorage[key] on
 *  plain web). The legacy localStorage entry is intentionally left in place
 *  — harmless, and avoids a delete-then-fail race if the write throws.
 *  Idempotent: a no-op once `key` is populated. `transform` lets a caller
 *  reshape the legacy value (e.g. wrap a bare token in a JSON record). */
async function migrateLegacy(
  key: string,
  legacyKey: string,
  transform?: (legacyValue: string) => string,
): Promise<void> {
  try {
    const existing = await get(key)
    if (existing != null) return
    const legacy = localStorageGet(legacyKey)
    if (!legacy) return
    await set(key, transform ? transform(legacy) : legacy)
  } catch {
    // best-effort; must never block boot
  }
}

/** Ask the native shell to recreate the Android Activity so a changed daemon
 *  URL takes effect without killing the app process. No-op outside the
 *  native shell, and on an APK predating the AppControl plugin. */
async function restart(): Promise<void> {
  const plugin = appControlPlugin()
  if (!plugin) return
  try {
    await plugin.restart()
  } catch {
    // best-effort
  }
}

export const nativeStorage = {
  isAvailable: isNativeShell,
  get,
  set,
  remove,
  migrateLegacy,
  restart,
}

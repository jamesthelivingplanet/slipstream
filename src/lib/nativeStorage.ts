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

import {
  biometricPluginAvailable,
  promptBiometric,
  type BiometricAppControlPlugin,
} from './biometric.js'

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
/** Preferences key for the "require fingerprint to unlock" toggle (FLO-159),
 *  value '1'/'0' (see isBiometricLockEnabled/setBiometricLockEnabled below).
 *  Read once at boot by initBiometricLock() to decide whether TOKEN_KEY
 *  reads should be gated behind a biometric prompt this session. */
export const BIOMETRIC_LOCK_KEY = 'slipstream.biometricLock'

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

// FLO-159: biometricAvailability/biometricAuthenticate are typed once in
// biometric.ts (BiometricAppControlPlugin) and pulled in here via extends —
// this is the same runtime AppControl plugin object, just one interface
// declaration for its two newest (optional) methods instead of two.
interface CapacitorAppControlPlugin extends BiometricAppControlPlugin {
  restart(): Promise<void>
  /** FLO-151: stash the daemon URL + bearer token the background
   *  ReplyReceiver reads to POST an inline reply without the app running. */
  saveReplyCredentials(options: { url: string; token: string }): Promise<void>
  /** FLO-151: drop the stashed credentials (logout / token rotation). */
  clearReplyCredentials(): Promise<void>
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
  // FLO-159 biometric gate: while `locked` is true, TOKEN_KEY reads as
  // absent WITHOUT touching any storage tier. This is the actual gate — it's
  // what binds the lock to every reader of the token (src/main.ts's boot
  // sequence AND SettingsIntegrations.svelte's pairing-link section, not
  // just the boot path), because both go through this same get(). A `null`
  // here means "locked", not "no token was ever set" — callers that need to
  // tell the two apart (namely main.ts's boot sequence, which decides
  // whether to show TokenGate) MUST check isTokenLocked() before concluding
  // "no token, show TokenGate".
  if (key === TOKEN_KEY && locked) return null
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
  if (key === TOKEN_KEY || key === DAEMON_URL_KEY) {
    void syncReplyCredentials()
  }
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
  if (key === TOKEN_KEY || key === DAEMON_URL_KEY) {
    void syncReplyCredentials()
  }
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

/** FLO-151: keep the native ReplyReceiver's stashed daemon URL + token in
 *  sync with whatever the SPA is actually using, so a notification
 *  RemoteInput reply can POST to /inline-reply even when the app process is
 *  dead. Called from set()/remove() whenever TOKEN_KEY or DAEMON_URL_KEY
 *  changes, and once at boot (main.ts) to backfill existing installs that
 *  pre-date this feature. Best-effort and fire-and-forget — a failure here
 *  must never block a login/server-switch; the worst case is that inline
 *  reply is unavailable until the next successful sync. No-op outside the
 *  native shell (web/Electron have no RemoteInput path).
 *
 *  URL resolution: an explicit DAEMON_URL_KEY override wins; otherwise the
 *  mobile shell's location.origin IS the daemon origin (the WebView loads
 *  the SPA from the daemon, and MainActivity rebuilds the bridge against an
 *  override before the reload) — so falling back to location.origin is
 *  correct in the shell. Only http(s) origins qualify (a sandboxed 'null'
 *  origin is never device-reachable), matching push.ts's nativeAppOrigin(). */
async function syncReplyCredentials(): Promise<void> {
  const plugin = appControlPlugin()
  if (!plugin?.saveReplyCredentials) return
  try {
    const token = await get(TOKEN_KEY)
    const storedUrl = await get(DAEMON_URL_KEY)
    const origin =
      typeof location !== 'undefined' && /^https?:\/\//.test(location.origin)
        ? location.origin
        : null
    const url = storedUrl ?? origin
    if (token && url) {
      await plugin.saveReplyCredentials({ url, token })
    } else if (plugin.clearReplyCredentials) {
      await plugin.clearReplyCredentials()
    }
  } catch {
    // best-effort; swallow
  }
}

// ── Biometric token lock (FLO-159) ──────────────────────────────────────────
//
// A settings toggle that gates the saved server token (TOKEN_KEY) behind the
// device's fingerprint/biometric prompt. The gate itself lives in get()
// above; everything below is the state machine that decides when `locked`
// is true and how it gets flipped back to false.

/** True once initBiometricLock() has armed the gate this boot (native shell +
 *  preference on + plugin available). Distinct from `locked`: `armed` never
 *  goes back to true on its own — it's what the resume re-lock listener
 *  checks before re-locking, and what setBiometricLockEnabled(false) clears
 *  so a mid-session disable takes effect immediately. */
let armed = false
/** The actual gate flag get() reads. */
let locked = false
/** Dedupes concurrent unlockToken() callers (e.g. the boot gate and a
 *  settings-tab read racing) onto a single in-flight native prompt — two
 *  system biometric prompts stacking on top of each other would be broken
 *  UX and is not something the OS reliably handles. */
let unlockPromise: Promise<{ ok: boolean; code?: string; error?: string }> | null = null
/** Set on `visibilitychange` → hidden; read on the matching → visible
 *  transition to decide whether enough time passed to re-lock. */
let lastHiddenAt: number | null = null
/** Guards installResumeRelock() against double-binding — initBiometricLock()
 *  may run more than once across a boot/regate cycle (e.g. a settings
 *  change re-entering the boot-like arm sequence). */
let resumeListenerInstalled = false

/** Grace window (ms) the resume re-lock tolerates between the app being
 *  hidden and becoming visible again before it forces the gate back up.
 *  Exported for the test. See installResumeRelock()'s doc comment for why
 *  this exists at all. */
export const RELOCK_GRACE_MS = 60_000

async function isBiometricLockEnabled(): Promise<boolean> {
  return (await get(BIOMETRIC_LOCK_KEY)) === '1'
}

/** Shared precondition check for "can the gate actually be honored right
 *  now": native shell + the "require fingerprint" preference on + a
 *  new-enough APK exposing biometricAuthenticate. Factored out of
 *  initBiometricLock() so setBiometricLockEnabled(true) can arm the gate for
 *  the rest of THIS session using the exact same rule, instead of a second
 *  copy that could drift out of sync (e.g. arming on an old APK that has no
 *  biometric prompt to actually show later). */
async function canArmBiometricLock(): Promise<boolean> {
  if (!isNativeShell()) return false
  let enabled: boolean
  try {
    enabled = await isBiometricLockEnabled()
  } catch {
    enabled = false
  }
  return enabled && biometricPluginAvailable()
}

async function setBiometricLockEnabled(enabled: boolean): Promise<void> {
  if (enabled) {
    await set(BIOMETRIC_LOCK_KEY, '1')
    // Arm the gate for the rest of THIS session too, not just future cold
    // starts — otherwise a user who flips the toggle on and then backgrounds
    // the app past RELOCK_GRACE_MS is never re-locked, because
    // installResumeRelock()'s visibilitychange handler is gated on `armed`
    // and nothing set it true until the next initBiometricLock() at a cold
    // start. Only do so when the gate can actually be honored (mirrors
    // initBiometricLock()'s own preconditions) — an older APK or a plain
    // browser/Electron must never think it's armed.
    if (await canArmBiometricLock()) {
      armed = true
      installResumeRelock()
    }
    // Deliberately do NOT call lockToken() here: the user just passed a live
    // biometric prompt in SettingsSecurity.svelte to get this far, so
    // locking them out immediately after opting in would be wrong. `armed`
    // true with `locked` false is the intended state coming out of this
    // branch — the gate only engages on the next resume/cold start.
    return
  }
  await remove(BIOMETRIC_LOCK_KEY)
  // Disabling must take effect immediately, without an app restart — drop
  // any armed/locked state right away so the next get(TOKEN_KEY) (this same
  // settings tab included) isn't gated behind a preference that no longer
  // exists.
  armed = false
  locked = false
  unlockPromise = null
}

function isTokenLocked(): boolean {
  return locked
}

/** Force-lock: used by the resume re-lock below, and directly testable/
 *  callable by anything else that wants to re-arm the gate mid-session.
 *  Dispatches `slipstream:biometric-locked` on `window` so mounted UI (see
 *  App.svelte) can throw the gate overlay up — but ONLY on a real
 *  unlocked→locked transition, so calling this repeatedly while already
 *  locked doesn't re-trigger listeners/re-mount the overlay. */
function lockToken(): void {
  if (locked) return
  locked = true
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('slipstream:biometric-locked'))
  }
}

/** Android keeps the Capacitor WebView alive across backgrounding — this SPA
 *  keeps running in place, it does not reload — so without a resume re-lock
 *  the token gate would only ever apply to a cold start: background the app
 *  and switch back and the token would just sit there unlocked. Installs a
 *  `visibilitychange` listener (idempotent — see resumeListenerInstalled)
 *  that records the hidden timestamp, and on the matching resume only
 *  re-locks past RELOCK_GRACE_MS of actual hidden time. The short grace
 *  window is deliberate: switching away to the fingerprint prompt itself, or
 *  to the OS clipboard/share sheet and straight back, must not immediately
 *  re-trigger the gate. */
function installResumeRelock(): void {
  if (resumeListenerInstalled) return
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return
  resumeListenerInstalled = true
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      lastHiddenAt = Date.now()
      return
    }
    if (armed && lastHiddenAt != null && Date.now() - lastHiddenAt >= RELOCK_GRACE_MS) {
      lockToken()
    }
    lastHiddenAt = null
  })
}

/** Call once at boot. Arms (and immediately locks) the gate ONLY when: we're
 *  inside the native shell, the "require fingerprint" preference is on, and
 *  the running APK actually exposes biometricAuthenticate. Otherwise leaves
 *  `locked` false and returns false — an older APK, web/Electron, or the
 *  preference simply being off must never gate the token. Also installs the
 *  resume re-lock listener (idempotent), since this is the natural place to
 *  do it whether or not the gate ends up armed this call. */
async function initBiometricLock(): Promise<boolean> {
  installResumeRelock()

  if (!(await canArmBiometricLock())) {
    armed = false
    return false
  }

  armed = true
  lockToken()
  return true
}

/** Resolve the gate. If not locked, resolves { ok:true } immediately — no
 *  prompt. Otherwise shows the native biometric prompt (deduped: concurrent
 *  callers share the ONE in-flight promise so a boot gate and a settings
 *  read can never stack two system prompts). On success, unlocks and
 *  resolves { ok:true }; on failure/cancel, leaves it locked and resolves
 *  { ok:false, code, error } so the caller can render a specific message. */
async function unlockToken(): Promise<{ ok: boolean; code?: string; error?: string }> {
  if (!locked) return { ok: true }
  if (unlockPromise) return unlockPromise

  unlockPromise = (async () => {
    try {
      const result = await promptBiometric({
        title: 'Unlock Slipstream',
        subtitle: 'Confirm your fingerprint to access your saved server token',
      })
      if (result.authenticated) {
        locked = false
        return { ok: true }
      }
      return { ok: false, code: result.code, error: result.error }
    } finally {
      unlockPromise = null
    }
  })()

  return unlockPromise
}

export const nativeStorage = {
  isAvailable: isNativeShell,
  get,
  set,
  remove,
  migrateLegacy,
  restart,
  syncReplyCredentials,
  isBiometricLockEnabled,
  setBiometricLockEnabled,
  isTokenLocked,
  initBiometricLock,
  unlockToken,
  lockToken,
}

export {
  isBiometricLockEnabled,
  setBiometricLockEnabled,
  isTokenLocked,
  initBiometricLock,
  unlockToken,
  lockToken,
}

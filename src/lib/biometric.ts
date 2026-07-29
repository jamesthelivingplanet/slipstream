// Native biometric-unlock bridge (FLO-159) — the low-level half of "gate the
// saved server token behind a fingerprint". Talks to two methods added to
// the existing custom `AppControl` plugin: biometricAvailability() and
// biometricAuthenticate(). An older APK predates both, so every call here is
// feature-detected exactly like nativeStorage.ts's saveReplyCredentials
// guard — an absent method reads as "unsupported", never as a crash.
//
// Same rationale as haptics.ts/push.ts/nativeStorage.ts: the mobile app's
// WebView loads this SAME SPA over the tailnet — there is no separate mobile
// build. window.Capacitor (and the plugins under window.Capacitor.Plugins)
// are injected into the page at runtime only inside that shell; a plain
// browser, the installed PWA, or the Electron renderer never set
// window.Capacitor. So this module feature-detects the bridge at runtime
// rather than importing @capacitor/* — src/ must stay free of any
// @capacitor/* npm dependency (a browser tab loading this same bundle must
// never even attempt to resolve it).
//
// This module is intentionally the LOW-LEVEL bridge only: no lock state, no
// storage, no re-lock policy. nativeStorage.ts imports this module to build
// the actual token gate (isTokenLocked/unlockToken/lockToken/
// initBiometricLock); this module must never import nativeStorage.ts back —
// keeping the dependency one-directional is what lets "can we even ask the
// OS?" stay independently testable from the gate policy built on top of it.

/** Mirrors the native plugin's `status` values one-for-one — see the plugin
 *  contract (FLO-159). 'unknown' is the native side's own catch-all;
 *  'unsupported' is what THIS module reports when the bridge/method itself
 *  is absent (older APK) or the native call throws. */
export type BiometricAvailabilityStatus =
  | 'available'
  | 'no-hardware'
  | 'hw-unavailable'
  | 'none-enrolled'
  | 'security-update-required'
  | 'unsupported'
  | 'unknown'

export interface BiometricAvailability {
  available: boolean
  status: BiometricAvailabilityStatus
}

/** Mirrors the native plugin's `code` values; 'unsupported' is again this
 *  module's own addition for "there was no plugin to even ask". */
export type BiometricAuthCode =
  | 'user-canceled'
  | 'lockout'
  | 'no-credential'
  | 'canceled'
  | 'no-activity'
  | 'error'
  | 'unsupported'

export interface BiometricAuthResult {
  authenticated: boolean
  error?: string
  code?: BiometricAuthCode
}

/** The two AppControl methods this module needs. Exported so nativeStorage.ts
 *  can extend its own CapacitorAppControlPlugin interface with these instead
 *  of re-declaring the same method signatures a second time — there is one
 *  definition of this plugin surface, here. Optional: an APK predating
 *  FLO-159 has neither method. */
export interface BiometricAppControlPlugin {
  biometricAvailability?(): Promise<{ available: boolean; status: string }>
  biometricAuthenticate?(options?: {
    title?: string
    subtitle?: string
  }): Promise<{ authenticated: boolean; error?: string; code?: string }>
}

interface CapacitorGlobal {
  Plugins?: {
    AppControl?: BiometricAppControlPlugin
  }
}

function cap(): CapacitorGlobal | undefined {
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor
}

function appControlPlugin(): BiometricAppControlPlugin | undefined {
  return cap()?.Plugins?.AppControl
}

/** True only inside the Capacitor mobile shell AND on an APK new enough to
 *  expose biometricAuthenticate — an older APK (AppControl present, but
 *  neither FLO-159 method registered) reads as unavailable, same
 *  degrade-gracefully contract as every other optional AppControl method
 *  (saveReplyCredentials, restart, …) elsewhere in this codebase. */
export function biometricPluginAvailable(): boolean {
  return (
    typeof window !== 'undefined' && typeof appControlPlugin()?.biometricAuthenticate === 'function'
  )
}

/** Ask the native shell whether biometric unlock is usable on this device.
 *  Never throws: resolves { available:false, status:'unsupported' } when the
 *  plugin/method is absent (older APK, or outside the shell entirely) or the
 *  native call itself throws, so callers never need a try/catch of their
 *  own — same best-effort contract as every other native-bridge call in this
 *  codebase (push.ts, widgetSync.ts, nativeStorage.ts). */
export async function checkBiometricAvailability(): Promise<BiometricAvailability> {
  if (!biometricPluginAvailable()) return { available: false, status: 'unsupported' }
  try {
    const result = await appControlPlugin()!.biometricAvailability!()
    return { available: result.available, status: result.status as BiometricAvailabilityStatus }
  } catch {
    return { available: false, status: 'unsupported' }
  }
}

/** Show the native biometric prompt. Never throws: resolves
 *  { authenticated:false, code:'unsupported' } when the plugin/method is
 *  absent, and { authenticated:false, code:'error', error:<message> } if the
 *  native call itself rejects. Per the plugin contract, biometricAuthenticate
 *  itself never rejects for a retryable failed attempt (a wrong fingerprint
 *  keeps the system prompt up rather than resolving/rejecting) — so a
 *  rejection reaching this function means something else went wrong (plugin
 *  crash, bridge error), not "user tried the wrong finger". */
export async function promptBiometric(opts?: {
  title?: string
  subtitle?: string
}): Promise<BiometricAuthResult> {
  if (!biometricPluginAvailable()) return { authenticated: false, code: 'unsupported' }
  try {
    const result = await appControlPlugin()!.biometricAuthenticate!(opts)
    return {
      authenticated: result.authenticated,
      error: result.error,
      code: result.code as BiometricAuthCode | undefined,
    }
  } catch (e) {
    return {
      authenticated: false,
      code: 'error',
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

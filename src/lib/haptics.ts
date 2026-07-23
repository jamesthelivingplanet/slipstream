// Native haptics bridge (FLO-161) — a subtle non-visual echo of the desktop
// watch-pulse animation (MissionControl.svelte's .watch.alert), fired once
// per "needs you" episode while the app is foregrounded.
//
// Same rationale as push.ts/nativeStorage.ts: the mobile app's WebView loads
// this SAME SPA over the tailnet — there is no separate mobile build.
// window.Capacitor (and the plugins under window.Capacitor.Plugins) are
// injected into the page at runtime only inside that shell; a plain browser,
// the installed PWA, or the Electron renderer never set window.Capacitor. So
// this module feature-detects the bridge at runtime rather than importing
// @capacitor/* — src/ must stay free of any @capacitor/* npm dependency (a
// browser tab loading this same bundle must never even attempt to resolve
// it). The @capacitor/haptics package itself lives only in mobile/'s native
// dependency set (mobile/package.json), wired into the Android build via
// `cap sync` — see mobile/android/capacitor.settings.gradle.

interface CapacitorHapticsPlugin {
  impact(options: { style: 'LIGHT' | 'MEDIUM' | 'HEAVY' }): Promise<void>
}

interface CapacitorGlobal {
  isPluginAvailable?(name: string): boolean
  Plugins?: {
    Haptics?: CapacitorHapticsPlugin
  }
}

function cap(): CapacitorGlobal | undefined {
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor
}

/** True only inside the Capacitor mobile shell — mirrors push.ts's
 *  nativePushAvailable()/nativeStorage.ts's isNativeShell(). */
export function hapticsAvailable(): boolean {
  return typeof window !== 'undefined' && !!cap()?.isPluginAvailable?.('Haptics')
}

function hapticsPlugin(): CapacitorHapticsPlugin | undefined {
  return hapticsAvailable() ? cap()?.Plugins?.Haptics : undefined
}

/** True when the page is the one currently on-screen. A backgrounded/killed
 *  WebView can still receive live WS status pushes (the renderer keeps
 *  running), but a buzz the user can't feel is pointless — and FCM already
 *  covers the backgrounded case via a real push notification. */
function isForeground(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible'
}

/** Best-effort single buzz for a session's "needs you" transition. No-ops
 *  outside the Capacitor mobile shell, and outside the foreground — never
 *  throws, matching every other best-effort native-bridge call in this
 *  codebase (push.ts, widgetSync.ts). Callers are responsible for their own
 *  per-episode dedupe (see stores.ts's setSessionStatus / FLO-105's
 *  `notified` map + markSessionInput re-arm) — this function fires
 *  unconditionally on every call. */
export function buzzNeedsYou(): void {
  if (!isForeground()) return
  const plugin = hapticsPlugin()
  if (!plugin) return
  plugin.impact({ style: 'MEDIUM' }).catch(() => {
    // best-effort — a failed native call must never surface to the user
  })
}

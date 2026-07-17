// First-boot onboarding: seen-flag persistence + visibility store (TASK-EQOP4).
// Shaped like fabPrefs.ts — a writable store is the live source of truth so
// every consumer (App.svelte, the pager/modal, the FAB's gating) reflects a
// change instantly, with nativeStorage as the durable backing store, read
// once and mirrored into the store below.
import { writable } from 'svelte/store'
import { nativeStorage } from './nativeStorage'

/** nativeStorage key: '1' once the user has completed or skipped onboarding. */
export const ONBOARDING_SEEN_KEY = 'slipstream.onboardingSeen'

/** True while onboarding should be shown (pager or modal, per onboardingMode).
 *  Starts false so nothing flashes before initOnboarding() resolves — a first
 *  boot briefly shows nothing rather than a false positive. */
export const onboardingVisible = writable(false)

let initPromise: Promise<void> | null = null

/** Loads the seen-flag from nativeStorage and sets onboardingVisible
 *  accordingly. Safe to call multiple times (e.g. from a test or a remount)
 *  — the underlying fetch only ever happens once per session. */
export function initOnboarding(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        const seen = await nativeStorage.get(ONBOARDING_SEEN_KEY)
        onboardingVisible.set(seen !== '1')
      } catch {
        // best-effort; never block boot — leave the default (hidden) rather
        // than risk re-nagging a user on every load of a broken storage tier
      }
    })()
  }
  return initPromise
}

/** Dismiss onboarding (finished, skipped, or the web modal's "Let's go") and
 *  persist that it's been seen so it never reappears on this device. */
export async function markOnboardingSeen(): Promise<void> {
  onboardingVisible.set(false)
  try {
    await nativeStorage.set(ONBOARDING_SEEN_KEY, '1')
  } catch {
    // best-effort; worst case it reappears next boot, which is a
    // recoverable nuisance rather than a broken experience
  }
}

/** Settings → Behavior "Replay intro" entry point. Does not clear the
 *  persisted seen-flag — dismissing the replay just re-persists the same
 *  '1' it already had. */
export function replayOnboarding(): void {
  onboardingVisible.set(true)
}

/** Pure presentation choice: the Capacitor mobile shell gets the full-screen
 *  pager, everything else (plain browser, installed PWA, Electron renderer)
 *  gets the modal. Takes the Capacitor-availability flag as an explicit
 *  argument (callers pass nativeStorage.isAvailable()) rather than reading
 *  window.Capacitor itself, so this stays pure and unit-testable. */
export function onboardingMode(capacitorAvailable: boolean): 'pager' | 'modal' {
  return capacitorAvailable ? 'pager' : 'modal'
}

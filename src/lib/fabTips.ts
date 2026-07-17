// Pure scheduling/rotation logic for the mobile FAB's occasional "Clippy
// mode" tip bubble (TASK-I9S44). No Svelte, no timers, no storage I/O here —
// NewAgentFab.svelte owns the setInterval loop and the nativeStorage calls;
// this module only answers "is it time yet / what's next" questions from
// explicit inputs, the same shape as responsive.ts, so it's unit-testable
// without faking timers or mocking the DOM.

/** nativeStorage key: 0-indexed pointer into fabTipsContent's FAB_TIPS,
 *  persisted so reopening the app resumes the rotation instead of restarting
 *  at tip 0 every time. */
export const FAB_TIP_INDEX_KEY = 'slipstream.fabTipIndex'
/** nativeStorage key: master on/off switch for the tip bubble feature. */
export const FAB_TIPS_ENABLED_KEY = 'slipstream.fabTips'
/** nativeStorage key: pixel-angel sprite vs. plain material FAB. */
export const FAB_ANGEL_ENABLED_KEY = 'slipstream.fabAngel'

/** Minimum time after boot before the very first tip may appear. */
export const FAB_TIP_FIRST_DELAY_MS = 60_000
/** The gap from one tip going away to the next becoming due is jittered
 *  across this range so tips don't land on a metronomic schedule. */
export const FAB_TIP_MIN_GAP_MS = 6 * 60_000
export const FAB_TIP_MAX_GAP_MS = 8 * 60_000
/** How long a shown tip stays up before auto-hiding itself. */
export const FAB_TIP_VISIBLE_MS = 12_000

/** Absolute due-time (ms, same clock as Date.now()) for the first tip, given
 *  the timestamp the FAB/app booted. */
export function firstTipDueAtMs(bootMs: number): number {
  return bootMs + FAB_TIP_FIRST_DELAY_MS
}

/** True once `nowMs` has reached `dueAtMs` — i.e. a tip is allowed to show. */
export function isTipDue(nowMs: number, dueAtMs: number): boolean {
  return nowMs >= dueAtMs
}

/** Absolute time (ms) at which a tip shown at `shownAtMs` should auto-hide. */
export function tipAutoHideAtMs(shownAtMs: number): number {
  return shownAtMs + FAB_TIP_VISIBLE_MS
}

/** Picks the next tip's due-time, `FAB_TIP_MIN_GAP_MS`–`FAB_TIP_MAX_GAP_MS`
 *  after `nowMs`. `rand` is injectable (defaults to Math.random) so tests can
 *  pin the jitter and assert the exact bounds. */
export function nextTipDueAtMs(nowMs: number, rand: () => number = Math.random): number {
  const span = FAB_TIP_MAX_GAP_MS - FAB_TIP_MIN_GAP_MS
  return nowMs + FAB_TIP_MIN_GAP_MS + rand() * span
}

/** Advances a tip index to the next one, wrapping past the end of a
 *  `tipCount`-length list back to 0. */
export function nextTipIndex(currentIndex: number, tipCount: number): number {
  if (tipCount <= 0) return 0
  return (currentIndex + 1) % tipCount
}

/** Clamps a persisted index into `[0, tipCount)` — defends against a stale
 *  or corrupt value (e.g. a shorter/longer tip list after a future edit, or
 *  a non-numeric stored value that parsed as NaN). */
export function clampTipIndex(index: number, tipCount: number): number {
  if (tipCount <= 0) return 0
  if (!Number.isFinite(index) || index < 0) return 0
  return Math.floor(index) % tipCount
}

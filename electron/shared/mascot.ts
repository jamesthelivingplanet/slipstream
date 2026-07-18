/**
 * Single home for the mascot's name and its Duolingo-style push-notification
 * voice (TASK-F0TYG). Importable from both the renderer (src/) and the daemon
 * (electron/) — like usageFormat.ts, this file must NOT pull in any Node
 * built-in or browser global.
 *
 * `src/lib/onboardingContent.ts` re-exports MASCOT_NAME from here so every
 * existing import keeps working; `electron/services/pushService.ts` picks
 * notification copy from the pools below.
 */

/** The mascot's name — an original angel-styled name (from "null"), in the
 *  spirit of Evangelion's Angels but not one of them. See
 *  src/lib/onboardingContent.ts for where this is also rendered in the UI. */
export const MASCOT_NAME = 'Nulliel'

/** Hard cap enforced by mascot.test.ts — keeps a notification title readable
 *  without Android truncating it in the shade. */
export const NOTIFICATION_TITLE_MAX_LENGTH = 65

export type NotificationKind = 'needsInput' | 'needsBlocked' | 'needsApproval' | 'done' | 'running'

/** Duolingo-style playful hooks, Nulliel-voiced. No leading emoji (TASK-F0TYG
 *  follow-up) — the notification's own icon (public/icons/nulliel-*.png /
 *  mobile/assets/nulliel-silhouette.svg) is what puts Nulliel in front of the
 *  user now, so every title names Nulliel directly instead. 3–4 variants per
 *  kind so back-to-back sessions don't all read identically; `pick()` below
 *  selects deterministically per episode. */
export const NOTIFICATION_TITLES: Record<NotificationKind, readonly string[]> = {
  needsInput: [
    `${MASCOT_NAME} says your agent misses you`,
    `An agent is staring at a prompt — ${MASCOT_NAME} noticed`,
    `${MASCOT_NAME} taps the glass — your agent needs a human`,
    `${MASCOT_NAME} relays a question from your agent`,
  ],
  needsBlocked: [
    `${MASCOT_NAME} found your agent stuck in a corner`,
    `An agent hit a wall — ${MASCOT_NAME} suggests you look`,
    `${MASCOT_NAME} spotted a blocker only you can clear`,
  ],
  needsApproval: [
    `Your agent wants permission — ${MASCOT_NAME} is watching you decide`,
    `Sign-off needed — ${MASCOT_NAME} delivers the form`,
    `${MASCOT_NAME} holds the door until you say go`,
  ],
  done: [
    `${MASCOT_NAME} reports: mission complete`,
    `An agent finished — ${MASCOT_NAME} is mildly impressed`,
    `Done! ${MASCOT_NAME} already read the diff`,
    `${MASCOT_NAME} wraps it up with a bow`,
  ],
  running: [
    `${MASCOT_NAME} watches your agent get to work`,
    `Agent launched — ${MASCOT_NAME} rides along`,
    `${MASCOT_NAME} waves your agent off`,
  ],
} as const

/** Tiny deterministic string hash (djb2 variant) — no crypto import needed,
 *  just needs to spread seeds across the pool evenly enough for variety. */
function hashSeed(seed: string): number {
  let h = 5381
  for (let i = 0; i < seed.length; i++) {
    h = (h * 33) ^ seed.charCodeAt(i)
  }
  return h >>> 0
}

/** Deterministically pick one entry from `pool` for a given `seed` (e.g.
 *  `${sessionId}:${kind}`) — the same episode always renders the same line,
 *  while different sessions/kinds spread across the pool. Never throws: an
 *  empty pool returns ''. */
export function pick(pool: readonly string[], seed: string): string {
  if (pool.length === 0) return ''
  const idx = hashSeed(seed) % pool.length
  return pool[idx]
}

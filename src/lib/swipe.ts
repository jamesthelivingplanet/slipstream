/**
 * swipe — pure gesture math for swipe-to-reveal action rows (Mission Control
 * mobile). Kept DOM-free (mirroring touchScroll.ts) so the threshold/axis/
 * settle logic is cheap to unit test independently of pointer events.
 *
 * The component translates a foreground layer by `offset` px (positive =
 * shifted right, revealing the "left" action panel; negative = shifted left,
 * revealing the "right" action panel). These helpers decide which axis a drag
 * is on, how far it may travel, and which side — if any — it should snap to
 * on release.
 */

/** Movement (px) a finger/cursor must travel before the gesture axis locks.
 *  Below this every drag reads as a tap (so a tap still fires the row's
 *  primary click). */
export const AXIS_LOCK_PX = 8

/** Fraction of an action panel's width a drag must clear to stay open on a
 *  slow release; below it the row snaps shut. */
export const OPEN_RATIO = 0.5

/** Release velocity (px/ms) that snaps open regardless of distance — a flick. */
export const FLICK_VELOCITY = 0.6

export type SwipeAxis = 'horizontal' | 'vertical' | null

export type SwipeSide = 'left' | 'right' | null

/**
 * Decide the gesture axis from cumulative movement since pointerdown.
 * Returns null until movement exceeds {@link AXIS_LOCK_PX} on either axis,
 * then commits to whichever axis has the larger magnitude — so a mostly
 * vertical drag (page scroll) never accidentally locks horizontal and steals
 * the scroll.
 */
export function swipeAxis(dx: number, dy: number): SwipeAxis {
  if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return null
  return Math.abs(dx) >= Math.abs(dy) ? 'horizontal' : 'vertical'
}

/**
 * Clamp an in-progress foreground offset to the reachable range, determined
 * by which action panels exist. A side with width 0 (no actions slotted)
 * can't be opened, so the offset is clamped to 0 on that side — the row
 * won't follow a drag in a direction that reveals nothing.
 */
export function clampSwipeOffset(offset: number, leftWidth: number, rightWidth: number): number {
  const max = Math.max(0, leftWidth)
  const min = Math.min(0, -rightWidth)
  const clamped = Math.max(min, Math.min(max, offset))
  // Math.min(0, -0) yields -0, which would otherwise leak through as a
  // negative-zero translateX — harmless for CSS but surprising in equality
  // checks. Normalize to +0.
  return clamped === 0 ? 0 : clamped
}

/**
 * Decide where the foreground should settle on release.
 *  - `offset` is the current translateX (positive = toward the left panel,
 *    negative = toward the right panel).
 *  - `leftWidth`/`rightWidth` are the revealed action panel widths (0 if that
 *    side has no actions — settling toward it is forbidden).
 *  - `velocity` is release velocity in px/ms (positive = finger moving right,
 *    i.e. toward the left panel).
 *
 * A flick (|velocity| ≥ {@link FLICK_VELOCITY}) toward an existing panel wins
 * over position. Otherwise the row stays open only if it crossed
 * {@link OPEN_RATIO} of a panel's width; otherwise it snaps shut.
 */
export function swipeSettle(
  offset: number,
  leftWidth: number,
  rightWidth: number,
  velocity: number,
): SwipeSide {
  if (velocity >= FLICK_VELOCITY && leftWidth > 0) return 'left'
  if (velocity <= -FLICK_VELOCITY && rightWidth > 0) return 'right'
  if (leftWidth > 0 && offset >= leftWidth * OPEN_RATIO) return 'left'
  if (rightWidth > 0 && offset <= -rightWidth * OPEN_RATIO) return 'right'
  return null
}

/** The target translateX for a settled side (0 for closed). */
export function swipeTargetOffset(side: SwipeSide, leftWidth: number, rightWidth: number): number {
  if (side === 'left') return leftWidth
  if (side === 'right') return -rightWidth
  return 0
}

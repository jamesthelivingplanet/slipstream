// Pure geometry for the desktop angel companion's draggable corner-snapping
// (TASK-I9S44). No Svelte, no DOM, no timers — NewAgentFab.svelte owns the
// pointer-event drag loop and reads window.innerWidth/innerHeight; this
// module only turns numbers into other numbers, the same shape as
// responsive.ts and fabTips.ts, so it's unit-testable without a browser.
//
// Desktop-only: mobile keeps its fixed bottom-right position (the original
// right/bottom safe-area formula in NewAgentFab.svelte's <style>) and is not
// draggable, so none of this module applies there.

export type FabCorner = 'tl' | 'tr' | 'bl' | 'br'

const FAB_CORNERS: readonly FabCorner[] = ['tl', 'tr', 'bl', 'br']

/** Type guard for a persisted corner value read back from nativeStorage,
 *  which is untyped string | null — guards against a corrupt/legacy value. */
export function isFabCorner(value: unknown): value is FabCorner {
  return typeof value === 'string' && (FAB_CORNERS as readonly string[]).includes(value)
}

/** nativeStorage key the chosen corner is persisted under. */
export const FAB_CORNER_KEY = 'slipstream.fabCorner'
/** Desktop default before the companion has ever been dragged. */
export const DEFAULT_FAB_CORNER: FabCorner = 'bl'

/** Must match .new-agent-fab's width/height in NewAgentFab.svelte. */
export const FAB_SIZE_PX = 56
/** Margin (px) kept from the viewport edge at every corner. */
export const FAB_CORNER_MARGIN_PX = 20
/** Must match header.bar's height in app.css. */
export const FAB_HEADER_HEIGHT_PX = 52
/** Extra clearance (px) below the header for the two top corners, so the
 *  companion never sits under/behind header controls. */
export const FAB_HEADER_CLEARANCE_PX = 12
/** Gap (px) between the companion and the tip bubble anchored to it. */
export const FAB_TIP_GAP_PX = 14

/** Movement (px) a pointer must travel before a press counts as a drag
 *  rather than a tap — below this, releasing still opens the New Agent
 *  dialog; at or above it, the release snaps to a corner instead of
 *  clicking. */
export const FAB_DRAG_THRESHOLD_PX = 6

/** The nearest of the four screen corners to a point (e.g. the companion's
 *  center at drag release) — whichever quadrant of the viewport it falls
 *  in. Ties (exact center) resolve to bottom/right, matching `<` below. */
export function nearestCorner(
  x: number,
  y: number,
  viewportWidth: number,
  viewportHeight: number,
): FabCorner {
  const vertical = y < viewportHeight / 2 ? 't' : 'b'
  const horizontal = x < viewportWidth / 2 ? 'l' : 'r'
  return `${vertical}${horizontal}` as FabCorner
}

export interface FabPoint {
  left: number
  top: number
}

/** Where the companion should rest for a given corner at the current
 *  viewport size. Always expressed as left/top (never right/bottom) so a
 *  CSS transition between any two corners animates smoothly — flipping
 *  between `left`/`right` or `top`/`bottom` can't animate through the
 *  intermediate `auto` those would otherwise need. */
export function resolveCornerPosition(
  corner: FabCorner,
  viewportWidth: number,
  viewportHeight: number,
): FabPoint {
  const left =
    corner[1] === 'l' ? FAB_CORNER_MARGIN_PX : viewportWidth - FAB_CORNER_MARGIN_PX - FAB_SIZE_PX
  const top =
    corner[0] === 't'
      ? FAB_HEADER_HEIGHT_PX + FAB_HEADER_CLEARANCE_PX
      : viewportHeight - FAB_CORNER_MARGIN_PX - FAB_SIZE_PX
  return { left, top }
}

export interface FabTipAnchor {
  left?: number
  right?: number
  top?: number
  bottom?: number
}

/** Where the tip bubble should anchor given the companion's own resolved
 *  left/top and the corner it's at: opens into the viewport (above the
 *  companion at bottom corners, below it at top corners) and stays flush
 *  with the companion's left/right edge (left-aligned at left corners,
 *  right-aligned at right corners) so it can never run off-screen.
 *  `bottom`/`top` are used for the vertical axis rather than measuring the
 *  bubble's own (content-dependent) height — a bottom-anchored box grows
 *  upward and a top-anchored one grows downward without any measurement. */
export function bubbleAnchorFor(
  corner: FabCorner,
  companion: FabPoint,
  viewportWidth: number,
  viewportHeight: number,
): FabTipAnchor {
  const anchor: FabTipAnchor = {}
  if (corner[0] === 'b') {
    anchor.bottom = viewportHeight - companion.top + FAB_TIP_GAP_PX
  } else {
    anchor.top = companion.top + FAB_SIZE_PX + FAB_TIP_GAP_PX
  }
  if (corner[1] === 'l') {
    anchor.left = companion.left
  } else {
    anchor.right = viewportWidth - companion.left - FAB_SIZE_PX
  }
  return anchor
}

/** Which way the tip bubble's diamond pointer should face for a corner:
 *  down at bottom corners (bubble sits above, pointer points down at the
 *  glyph), up at top corners; aligned to whichever side the bubble itself
 *  is aligned to. */
export function pointerDirectionForCorner(corner: FabCorner): {
  vertical: 'up' | 'down'
  horizontal: 'left' | 'right'
} {
  return {
    vertical: corner[0] === 'b' ? 'down' : 'up',
    horizontal: corner[1] === 'l' ? 'left' : 'right',
  }
}

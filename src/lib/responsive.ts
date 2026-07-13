/** Viewport width (px) at or below which the UI switches to its mobile layout.
 *  Must stay in sync with the `@media (max-width: …)` breakpoints in app.css. */
export const MOBILE_BREAKPOINT = 700

/** Media query string used with window.matchMedia in the renderer. */
export const MOBILE_MEDIA_QUERY = `(max-width: ${MOBILE_BREAKPOINT}px)`

/** True when a viewport of the given width should use the mobile layout. */
export function isMobileWidth(width: number): boolean {
  return width <= MOBILE_BREAKPOINT
}

/** Viewport width (px) at or below which the agent sidebar becomes a
 *  toggleable drawer overlay instead of a fixed sidebar. Covers both
 *  mobile and medium/tablet viewports.
 *  Must stay in sync with the `@media (max-width: …)` breakpoints in app.css. */
export const DRAWER_BREAKPOINT = 900

/** Media query string for drawer mode (agent list is a toggleable overlay). */
export const DRAWER_MEDIA_QUERY = `(max-width: ${DRAWER_BREAKPOINT}px)`

/** True when a viewport of the given width should use drawer layout. */
export function isDrawerWidth(width: number): boolean {
  return width <= DRAWER_BREAKPOINT
}

/** Vertical drag distance (px) at or beyond which a drawer drag dismisses it. */
export const DRAWER_DISMISS_PX = 72

/** Returns true when a downward drawer drag of `deltaY` pixels should dismiss. */
export function shouldDismissDrawer(deltaY: number): boolean {
  return deltaY >= DRAWER_DISMISS_PX
}

/** Minimum visual-viewport shortfall (px) treated as an on-screen keyboard —
 *  smaller deltas are browser chrome (URL bar) show/hide, not a keyboard. */
export const KEYBOARD_MIN_INSET = 80

/** Height (px) of the on-screen keyboard overlapping the layout viewport,
 *  derived from window.innerHeight vs. the visual viewport. 0 when no
 *  keyboard is judged visible. */
export function keyboardInset(
  innerHeight: number,
  vvHeight: number,
  vvOffsetTop: number,
  vvScale = 1,
): number {
  // While pinch-zoomed the visual viewport is smaller than the layout
  // viewport for reasons unrelated to a keyboard — report no inset.
  if (Math.abs(vvScale - 1) > 0.01) return 0
  const inset = Math.round(innerHeight - vvHeight - vvOffsetTop)
  return inset >= KEYBOARD_MIN_INSET ? inset : 0
}

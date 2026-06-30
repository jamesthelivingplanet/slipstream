/** Viewport width (px) at or below which the UI switches to its mobile layout.
 *  Must stay in sync with the `@media (max-width: …)` breakpoints in app.css. */
export const MOBILE_BREAKPOINT = 700

/** Media query string used with window.matchMedia in the renderer. */
export const MOBILE_MEDIA_QUERY = `(max-width: ${MOBILE_BREAKPOINT}px)`

/** True when a viewport of the given width should use the mobile layout. */
export function isMobileWidth(width: number): boolean {
  return width <= MOBILE_BREAKPOINT
}

/** Vertical drag distance (px) at or beyond which a drawer drag dismisses it. */
export const DRAWER_DISMISS_PX = 72

/** Returns true when a downward drawer drag of `deltaY` pixels should dismiss. */
export function shouldDismissDrawer(deltaY: number): boolean {
  return deltaY >= DRAWER_DISMISS_PX
}

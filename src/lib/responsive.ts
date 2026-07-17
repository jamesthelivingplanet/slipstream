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

/** Maximum fraction of the layout viewport height treated as keyboard inset.
 *  While pinch-zoomed the visual-viewport shortfall can be nearly the whole
 *  page; a real on-screen keyboard never covers more than ~60% of the screen,
 *  so clamp rather than crush the layout. */
export const KEYBOARD_MAX_INSET_RATIO = 0.6

/** Height (px) of the on-screen keyboard overlapping the layout viewport,
 *  derived from window.innerHeight vs. the visual viewport. 0 when no
 *  keyboard is judged visible.
 *
 *  An on-screen keyboard only ever exists while an editable element is
 *  focused, so that focus state — not the visual-viewport numbers — is the
 *  authoritative "is there a keyboard?" signal: without it any shortfall is
 *  browser chrome or pinch zoom (returns 0), and with it the shortfall is
 *  honored even while pinch-zoomed (the padding still lands the bottom bars
 *  exactly at the visual-viewport bottom). Gating on focus also self-heals a
 *  stale inset when a visualViewport event is dropped (iOS standalone PWAs
 *  drop them around keyboard close / app backgrounding). */
export function keyboardInset(
  innerHeight: number,
  vvHeight: number,
  vvOffsetTop: number,
  editableFocused: boolean,
): number {
  if (!editableFocused) return 0
  const inset = Math.round(innerHeight - vvHeight - vvOffsetTop)
  if (inset < KEYBOARD_MIN_INSET) return 0
  return Math.min(inset, Math.round(innerHeight * KEYBOARD_MAX_INSET_RATIO))
}

/** Whether the mobile "New agent" FAB should be visible: only on mobile, and
 *  never while the New Agent dialog or Settings panel are open, or while the
 *  on-screen keyboard is covering the bottom of the screen — otherwise it
 *  would sit on top of dialog content or MobileTermInput. */
export function shouldShowFab(
  mobile: boolean,
  dialogOpen: boolean,
  settingsOpen: boolean,
  keyboardInsetPx: number,
): boolean {
  return mobile && !dialogOpen && !settingsOpen && keyboardInsetPx <= 0
}

/** Whether the desktop angel companion should be visible (TASK-I9S44): the
 *  desktop counterpart to shouldShowFab, deliberately kept as a separate
 *  function rather than widening shouldShowFab so mobile's behavior stays
 *  byte-identical. Desktop only (mobile has its own FAB path above), only
 *  when the "Angel mode" setting is on — off means desktop keeps the plain
 *  header "New agent" button and shows no companion at all, unlike mobile's
 *  regular-disc fallback — and never while the New Agent dialog or Settings
 *  panel are open. No keyboard-inset check: desktop has no on-screen
 *  keyboard to cover the companion. */
export function shouldShowDesktopCompanion(
  mobile: boolean,
  angelEnabled: boolean,
  dialogOpen: boolean,
  settingsOpen: boolean,
): boolean {
  return !mobile && angelEnabled && !dialogOpen && !settingsOpen
}

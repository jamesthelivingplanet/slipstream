import type { Action } from 'svelte/action'

/**
 * Keyboard accessibility for modal dialogs: focus management, focus-trap, and
 * a shared Escape handler. Centralized here (and applied via the
 * `trapFocus` action in {@link ResponsivePanel}) so every dialog backed by
 * ResponsivePanel — NewAgentDialog, SettingsModal, ConfirmDialog,
 * OnboardingModal — inherits role="dialog"/aria-modal, initial focus, focus
 * return, a Tab trap, and Escape-to-close, instead of each re-implementing
 * them (and NewAgent/Settings having had none of them at all).
 *
 * Split like {@link ./floating} (placeAnchor/floatingAnchor): the wrap
 * arithmetic is a pure, unit-tested function; only the DOM wiring lives in
 * the (DOM-only, untested) `trapFocus` action.
 */

/** Selector matching elements reachable by Tab. `[tabindex="-1"]` is
 *  excluded so programmatically-focusable-only affordances (e.g. the mobile
 *  drawer's drag handle) aren't Tab stops. */
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
  'details > summary:first-child',
].join(',')

/** Index of `active` within `items`, or -1 when it isn't one of them.
 *  Pure (operates on a pre-collected list) so it's testable without a DOM. */
export function focusIndex(items: HTMLElement[], active: HTMLElement | null): number {
  if (!active) return -1
  return items.indexOf(active)
}

/** The index focus should move to for a Tab/Shift+Tab inside a `count`-sized
 *  focusable list, wrapping around both ends. `current` is the index that
 *  currently holds focus (-1 when none of the list does, e.g. focus hasn't
 *  landed yet or strayed onto the container).
 *
 *  - forward from the last  -> 0 (wrap to first)
 *  - backward from the first-> last (wrap to last)
 *  - backward from none (-1)-> last
 *  - forward from none (-1) -> 0
 *  - empty list             -> -1 (nowhere to go)
 *
 *  Pure and unit-tested; the action applies the result to real elements. */
export function wrapFocusIndex(current: number, count: number, backward: boolean): number {
  if (count <= 0) return -1
  if (current < 0) return backward ? count - 1 : 0
  if (backward) return current === 0 ? count - 1 : current - 1
  return current === count - 1 ? 0 : current + 1
}

/** Whether an element matched by {@link FOCUSABLE_SELECTOR} is actually
 *  focusable right now: not disabled, not aria-hidden, and laid out with a
 *  non-zero box (filters out `display:none`/collapsed ancestors). DOM-only,
 *  so not unit-tested directly — exercised through the action. */
function isFocusable(el: HTMLElement): boolean {
  if (el.hasAttribute('disabled')) return false
  if (el.getAttribute('aria-hidden') === 'true') return false
  const rect = el.getBoundingClientRect()
  return rect.width > 0 || rect.height > 0
}

/** The dialog's Tab-reachable descendants, in DOM order, with hidden/disabled
 *  ones filtered out. */
export function listFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isFocusable)
}

export interface FocusTrapOptions {
  /** Invoked on Escape. Defaults to a no-op so a dismiss-less dialog is
   *  possible, though every current ResponsivePanel consumer passes its
   *  `onClose`. */
  onClose?: () => void
}

/**
 * Svelte action that turns its host element into an accessible, trapping
 * dialog. On mount it remembers the element that had focus (so it can be
 * restored on close), then moves focus onto the first Tab stop inside the
 * host (falling back to the host itself, which must carry `tabindex="-1"`).
 * While mounted it intercepts Tab/Shift+Tab to keep focus looping inside the
 * host and forwards Escape to `onClose`. On destroy it returns focus to the
 * element that had it before the dialog opened.
 *
 * Escape and Tab are bound to the host element (not `window`) on purpose:
 * focus lives inside the top-most dialog, so a keydown only fires for the
 * dialog that actually contains focus. That makes stacking correct for free —
 * a ConfirmDialog opened over the Settings modal sees Escape/Tab handled by
 * the confirm alone, never both at once.
 */
export const trapFocus: Action<HTMLElement, FocusTrapOptions | undefined> = (node, opts) => {
  // The element to hand focus back to on close. Captured at mount (i.e. when
  // the dialog's {#if open} block first renders the host) so it reflects
  // whoever opened the dialog — the FAB, a header button, a Settings tab.
  const previouslyFocused = (document.activeElement as HTMLElement | null) ?? null
  let onClose = opts?.onClose ?? (() => {})

  const focusFirst = () => {
    const focusable = listFocusable(node)
    if (focusable.length > 0) {
      focusable[0].focus()
    } else {
      // Host carries tabindex="-1" so it's a valid focus target itself.
      node.focus()
    }
  }

  // Defer one frame so slotted content (rendered as part of the same {#if}
  // block as the host) is in the tree before we query for focusables.
  const raf = requestAnimationFrame(focusFirst)

  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key === 'Tab') {
      const focusable = listFocusable(node)
      if (focusable.length === 0) {
        // No Tab stops inside: keep focus pinned on the host.
        e.preventDefault()
        return
      }
      const idx = focusIndex(focusable, document.activeElement as HTMLElement | null)
      const next = wrapFocusIndex(idx, focusable.length, e.shiftKey)
      if (next !== idx) {
        e.preventDefault()
        focusable[next].focus()
      }
    }
  }

  node.addEventListener('keydown', onKeydown)

  return {
    update(next) {
      onClose = next?.onClose ?? (() => {})
    },
    destroy() {
      cancelAnimationFrame(raf)
      node.removeEventListener('keydown', onKeydown)
      // Return focus to whoever opened the dialog. Guarded: the element may
      // have been removed from the document in the meantime.
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus()
      }
    },
  }
}

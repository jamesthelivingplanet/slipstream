import type { Action } from 'svelte/action'

export const ANCHOR_GAP = 4

export interface AnchorRect {
  left: number
  top: number
  bottom: number
  width: number
}

export interface AnchorPlacement {
  left: number
  top: number
  width: number
}

/** Pure geometry for placing a menu below a trigger, flipping up when needed. */
export function placeAnchor(
  trigger: AnchorRect,
  menuHeight: number,
  viewportHeight: number,
  gap = ANCHOR_GAP,
): AnchorPlacement {
  const spaceBelow = viewportHeight - trigger.bottom
  const spaceAbove = trigger.top
  const openBelow = spaceBelow >= menuHeight + gap || spaceBelow >= spaceAbove
  const top = openBelow ? trigger.bottom + gap : Math.max(gap, trigger.top - gap - menuHeight)
  return { left: trigger.left, top, width: trigger.width }
}

export interface FloatingAnchorOptions {
  to?: HTMLElement | null
  gap?: number
}

/**
 * Portals a dropdown menu to <body> and pins it below its trigger with
 * position: fixed, so it escapes ancestors that clip overflow (e.g. the
 * modal's .dlg-body scroll area) and the transformed .dialog (which would
 * otherwise make position:fixed resolve against the dialog, not the viewport).
 */
export const floatingAnchor: Action<HTMLElement, FloatingAnchorOptions | undefined> = (
  menu,
  opts,
) => {
  const anchor = opts?.to ?? menu.closest('.select') ?? menu.parentElement
  if (!anchor) return

  let gap = opts?.gap ?? ANCHOR_GAP
  let raf = 0

  const place = () => {
    const rect = anchor.getBoundingClientRect()
    const placement = placeAnchor(
      { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width },
      menu.offsetHeight,
      window.innerHeight,
      gap,
    )
    menu.style.left = `${placement.left}px`
    menu.style.top = `${placement.top}px`
    menu.style.width = `${placement.width}px`
    menu.style.minWidth = `${placement.width}px`
  }

  const schedule = () => {
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(place)
  }

  const onScroll = () => schedule()
  const onResize = () => schedule()
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => schedule()) : null

  document.body.appendChild(menu)
  menu.style.position = 'fixed'
  place()
  ro?.observe(menu)

  window.addEventListener('resize', onResize)
  window.addEventListener('scroll', onScroll, true)

  return {
    update(next) {
      gap = next?.gap ?? ANCHOR_GAP
      schedule()
    },
    destroy() {
      cancelAnimationFrame(raf)
      ro?.disconnect()
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll, true)
      menu.remove()
    },
  }
}

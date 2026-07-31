/** Pure "close on outside click" policy for TerminalView's several dropdown
 *  menus (ticket status, hand-off, update-from-base, mobile "more"). Pulled
 *  out of the window click-handler so the close/stay-open decision is
 *  unit-testable without a real MouseEvent/DOM tree — the caller still does
 *  the actual `Element.closest()` lookups (that part is inherently DOM) and
 *  hands in the resulting booleans. */
export interface MenuFlags {
  menuOpen: boolean
  handoffOpen: boolean
  updateBaseOpen: boolean
  moreOpen: boolean
}

export interface MenuClickInside {
  /** Click landed inside the ticket-status trigger/menu (desktop or mobile). */
  ticketStatus: boolean
  /** Click landed inside the hand-off trigger/menu (desktop or mobile). */
  handoff: boolean
  /** Click landed inside the update-from-base trigger/menu. */
  updateBase: boolean
  /** Click landed inside the mobile "more actions" trigger/menu. */
  more: boolean
}

/** A menu that's open stays open only if the click landed inside its own
 *  anchor; otherwise it closes. A menu that's already closed stays closed
 *  regardless of where the click landed. */
export function closeMenusOutsideClick(flags: MenuFlags, inside: MenuClickInside): MenuFlags {
  return {
    menuOpen: flags.menuOpen && inside.ticketStatus,
    handoffOpen: flags.handoffOpen && inside.handoff,
    updateBaseOpen: flags.updateBaseOpen && inside.updateBase,
    moreOpen: flags.moreOpen && inside.more,
  }
}

import { describe, it, expect } from 'vitest'
import { closeMenusOutsideClick, type MenuFlags, type MenuClickInside } from './terminalMenus.js'

const ALL_OPEN: MenuFlags = {
  menuOpen: true,
  handoffOpen: true,
  updateBaseOpen: true,
  moreOpen: true,
}
const ALL_CLOSED: MenuFlags = {
  menuOpen: false,
  handoffOpen: false,
  updateBaseOpen: false,
  moreOpen: false,
}
const NONE_INSIDE: MenuClickInside = {
  ticketStatus: false,
  handoff: false,
  updateBase: false,
  more: false,
}
const ALL_INSIDE: MenuClickInside = {
  ticketStatus: true,
  handoff: true,
  updateBase: true,
  more: true,
}

describe('closeMenusOutsideClick', () => {
  it('closes every open menu when the click is outside all of them', () => {
    expect(closeMenusOutsideClick(ALL_OPEN, NONE_INSIDE)).toEqual(ALL_CLOSED)
  })

  it('leaves every open menu open when the click is inside all of them', () => {
    expect(closeMenusOutsideClick(ALL_OPEN, ALL_INSIDE)).toEqual(ALL_OPEN)
  })

  it('leaves already-closed menus closed regardless of click location', () => {
    expect(closeMenusOutsideClick(ALL_CLOSED, NONE_INSIDE)).toEqual(ALL_CLOSED)
    expect(closeMenusOutsideClick(ALL_CLOSED, ALL_INSIDE)).toEqual(ALL_CLOSED)
  })

  it('only closes the specific menu whose anchor the click missed', () => {
    const result = closeMenusOutsideClick(ALL_OPEN, {
      ticketStatus: true,
      handoff: false,
      updateBase: true,
      more: true,
    })
    expect(result).toEqual({
      menuOpen: true,
      handoffOpen: false,
      updateBaseOpen: true,
      moreOpen: true,
    })
  })

  it('a click inside one menu does not keep a different, already-open menu open', () => {
    const result = closeMenusOutsideClick(ALL_OPEN, {
      ticketStatus: false,
      handoff: true,
      updateBase: false,
      more: false,
    })
    expect(result).toEqual({
      menuOpen: false,
      handoffOpen: true,
      updateBaseOpen: false,
      moreOpen: false,
    })
  })
})

import { describe, it, expect } from 'vitest'
import { focusIndex, wrapFocusIndex } from './focusTrap.js'

describe('wrapFocusIndex', () => {
  it('wraps forward from the last element to the first', () => {
    expect(wrapFocusIndex(2, 3, false)).toBe(0)
  })

  it('wraps backward from the first element to the last', () => {
    expect(wrapFocusIndex(0, 3, true)).toBe(2)
  })

  it('advances normally in the middle of the list', () => {
    expect(wrapFocusIndex(1, 3, false)).toBe(2)
  })

  it('retreats normally in the middle of the list', () => {
    expect(wrapFocusIndex(2, 3, true)).toBe(1)
  })

  it('sends focus to the first element when none is focused and Tab is forward', () => {
    expect(wrapFocusIndex(-1, 3, false)).toBe(0)
  })

  it('sends focus to the last element when none is focused and Tab is backward', () => {
    expect(wrapFocusIndex(-1, 3, true)).toBe(2)
  })

  it('handles a single-element list by staying put in both directions', () => {
    expect(wrapFocusIndex(0, 1, false)).toBe(0)
    expect(wrapFocusIndex(0, 1, true)).toBe(0)
  })

  it('returns -1 for an empty list (nowhere to focus)', () => {
    expect(wrapFocusIndex(0, 0, false)).toBe(-1)
    expect(wrapFocusIndex(-1, 0, true)).toBe(-1)
  })
})

describe('focusIndex', () => {
  const a = {} as HTMLElement
  const b = {} as HTMLElement
  const c = {} as HTMLElement

  it('returns the index of the active element within the list', () => {
    expect(focusIndex([a, b, c], b)).toBe(1)
  })

  it('returns -1 when active is null', () => {
    expect(focusIndex([a, b, c], null)).toBe(-1)
  })

  it('returns -1 when the active element is not in the list', () => {
    const elsewhere = {} as HTMLElement
    expect(focusIndex([a, b, c], elsewhere)).toBe(-1)
  })
})

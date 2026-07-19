import { describe, it, expect } from 'vitest'
import { termKeyAction, type TermKeyEvent } from './termKeys.js'

function ev(overrides: Partial<TermKeyEvent>): TermKeyEvent {
  return {
    type: 'keydown',
    key: 'a',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...overrides,
  }
}

describe('termKeyAction', () => {
  it('routes Ctrl+V to native', () => {
    expect(termKeyAction(ev({ key: 'v', ctrlKey: true }), false)).toBe('native')
  })

  it('routes Ctrl+Shift+V to native', () => {
    expect(termKeyAction(ev({ key: 'v', ctrlKey: true, shiftKey: true }), false)).toBe('native')
  })

  it('routes Ctrl+V with an uppercase key to native', () => {
    expect(termKeyAction(ev({ key: 'V', ctrlKey: true }), false)).toBe('native')
  })

  it('routes Ctrl+C to native when there is a selection', () => {
    expect(termKeyAction(ev({ key: 'c', ctrlKey: true }), true)).toBe('native')
  })

  it('routes Ctrl+C to xterm when there is no selection', () => {
    expect(termKeyAction(ev({ key: 'c', ctrlKey: true }), false)).toBe('xterm')
  })

  it('routes Ctrl+Shift+C to native when there is a selection', () => {
    expect(termKeyAction(ev({ key: 'c', ctrlKey: true, shiftKey: true }), true)).toBe('native')
  })

  it('routes Ctrl+Alt+V to xterm', () => {
    expect(termKeyAction(ev({ key: 'v', ctrlKey: true, altKey: true }), false)).toBe('xterm')
  })

  it('routes Ctrl+Meta+V to xterm', () => {
    expect(termKeyAction(ev({ key: 'v', ctrlKey: true, metaKey: true }), false)).toBe('xterm')
  })

  it('routes non-keydown events (e.g. keyup) to xterm even with paste-like modifiers', () => {
    expect(termKeyAction(ev({ type: 'keyup', key: 'v', ctrlKey: true }), false)).toBe('xterm')
    expect(termKeyAction(ev({ type: 'keypress', key: 'v', ctrlKey: true }), false)).toBe('xterm')
  })

  it('routes an unrelated key with no modifiers to xterm', () => {
    expect(termKeyAction(ev({ key: 'a' }), false)).toBe('xterm')
  })
})

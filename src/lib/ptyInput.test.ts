import { describe, it, expect } from 'vitest'
import {
  ptySequenceForEdit,
  codePointIndex,
  CURSOR_LEFT,
  CURSOR_RIGHT,
  BACKSPACE,
  type PtyEditState,
} from './ptyInput.js'

describe('ptySequenceForEdit', () => {
  it('appends chars at the end', () => {
    const prev: PtyEditState = { text: 'ab', cursor: 2 }
    const next: PtyEditState = { text: 'abc', cursor: 3 }
    expect(ptySequenceForEdit(prev, next)).toBe('c')
  })

  it('backspaces at the end', () => {
    const prev: PtyEditState = { text: 'abc', cursor: 3 }
    const next: PtyEditState = { text: 'ab', cursor: 2 }
    expect(ptySequenceForEdit(prev, next)).toBe(BACKSPACE)
  })

  it('inserts in the middle', () => {
    // "ac" with cursor at the end (2) becomes "abc" with the new char
    // inserted before the trailing "c"; the selection/cursor lands at 2.
    const prev: PtyEditState = { text: 'ac', cursor: 2 }
    const next: PtyEditState = { text: 'abc', cursor: 2 }
    expect(ptySequenceForEdit(prev, next)).toBe(CURSOR_LEFT + 'b')
  })

  it('deletes in the middle', () => {
    // Cursor sits right after "b" in "abc"; backspacing removes it,
    // leaving "ac" with the cursor between "a" and "c".
    const prev: PtyEditState = { text: 'abc', cursor: 2 }
    const next: PtyEditState = { text: 'ac', cursor: 1 }
    expect(ptySequenceForEdit(prev, next)).toBe(BACKSPACE)
  })

  it('replaces a selection (multi-char delete + insert)', () => {
    const prev: PtyEditState = { text: 'abcdef', cursor: 4 }
    const next: PtyEditState = { text: 'abXYef', cursor: 4 }
    expect(ptySequenceForEdit(prev, next)).toBe(BACKSPACE + BACKSPACE + 'XY')
  })

  it('clears everything', () => {
    const prev: PtyEditState = { text: 'hello', cursor: 5 }
    const next: PtyEditState = { text: '', cursor: 0 }
    expect(ptySequenceForEdit(prev, next)).toBe(BACKSPACE.repeat(5))
  })

  it('repositions the cursor with no text change (arrows only)', () => {
    const prev: PtyEditState = { text: 'abc', cursor: 3 }
    const next: PtyEditState = { text: 'abc', cursor: 0 }
    expect(ptySequenceForEdit(prev, next)).toBe(CURSOR_LEFT.repeat(3))
  })

  it('moves the cursor right with no text change', () => {
    const prev: PtyEditState = { text: 'abc', cursor: 0 }
    const next: PtyEditState = { text: 'abc', cursor: 3 }
    expect(ptySequenceForEdit(prev, next)).toBe(CURSOR_RIGHT.repeat(3))
  })

  it('returns empty string for a true no-op', () => {
    const state: PtyEditState = { text: 'abc', cursor: 2 }
    expect(ptySequenceForEdit(state, { ...state })).toBe('')
  })

  it('deletes an emoji with exactly one BACKSPACE (code-point aware)', () => {
    const prev: PtyEditState = { text: '😀', cursor: 1 }
    const next: PtyEditState = { text: '', cursor: 0 }
    expect(ptySequenceForEdit(prev, next)).toBe(BACKSPACE)
  })
})

describe('codePointIndex', () => {
  it('converts a UTF-16 index past an emoji to a code-point index', () => {
    // "a😀b": "a" at UTF-16 index 0, the emoji occupies indices 1-2
    // (surrogate pair), "b" at UTF-16 index 3.
    expect(codePointIndex('a😀b', 3)).toBe(2)
  })

  it('is a no-op for BMP-only text', () => {
    expect(codePointIndex('abc', 2)).toBe(2)
  })

  it('returns 0 for index 0', () => {
    expect(codePointIndex('a😀b', 0)).toBe(0)
  })
})

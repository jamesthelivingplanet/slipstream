/**
 * Mirrors a composer `<input>` element onto a readline-style PTY line.
 *
 * Mobile terminal keyboards can't send raw keystrokes to xterm.js the way a
 * hardware keyboard does — autocomplete, autocorrect, and IME composition all
 * mutate the DOM input's value directly. Instead we diff the input's text
 * (and cursor position) before/after each edit and replay the minimal
 * sequence of arrow keys, backspaces, and literal characters that would
 * produce the same edit on a readline-style PTY line (bash, a REPL, etc.).
 */

/** Cursor-key / control bytes understood by readline-style TUIs. */
export const CURSOR_LEFT = '\x1b[D'
export const CURSOR_RIGHT = '\x1b[C'
export const BACKSPACE = '\x7f'

export interface PtyEditState {
  /** Full text of the composer input. */
  text: string
  /** Cursor position in CODE POINTS (not UTF-16 units). */
  cursor: number
}

/** Convert a UTF-16 index (e.g. input.selectionStart) to a code-point index. */
export function codePointIndex(text: string, utf16Index: number): number {
  // Count code points in the UTF-16 prefix — surrogate pairs collapse to one.
  return Array.from(text.slice(0, utf16Index)).length
}

function moveCursor(from: number, to: number): string {
  if (to > from) return CURSOR_RIGHT.repeat(to - from)
  if (to < from) return CURSOR_LEFT.repeat(from - to)
  return ''
}

/** Byte sequence that transforms the PTY line from `prev` to `next`. */
export function ptySequenceForEdit(prev: PtyEditState, next: PtyEditState): string {
  const prevChars = Array.from(prev.text)
  const nextChars = Array.from(next.text)
  const prevLen = prevChars.length
  const nextLen = nextChars.length

  // Common prefix.
  let p = 0
  const maxCommon = Math.min(prevLen, nextLen)
  while (p < maxCommon && prevChars[p] === nextChars[p]) p++

  // Common suffix, clamped so prefix + suffix never exceed either length.
  let s = 0
  const maxSuffix = Math.min(prevLen, nextLen) - p
  while (s < maxSuffix && prevChars[prevLen - 1 - s] === nextChars[nextLen - 1 - s]) {
    s++
  }

  const deleted = prevChars.slice(p, prevLen - s)
  const inserted = nextChars.slice(p, nextLen - s)

  if (deleted.length === 0 && inserted.length === 0) {
    return moveCursor(prev.cursor, next.cursor)
  }

  let out = ''
  out += moveCursor(prev.cursor, p + deleted.length)
  out += BACKSPACE.repeat(deleted.length)
  out += inserted.join('')
  out += moveCursor(p + inserted.length, next.cursor)
  return out
}

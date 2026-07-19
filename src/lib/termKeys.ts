/**
 * Decides whether a terminal keydown should be handled natively by the
 * browser (native copy/paste) or passed through to xterm's own processing.
 *
 * Plain Ctrl+V normally maps to the byte \x16 in xterm and the keydown is
 * cancelled, so the browser's native paste event never fires. We want
 * Ctrl+V to always behave like a local terminal's paste (native), while
 * Ctrl+C should only go native when there's a selection to copy — with no
 * selection, Ctrl+C must reach xterm so it sends SIGINT to the agent (the
 * VS Code integrated terminal convention).
 */

export interface TermKeyEvent {
  type: string
  key: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

export type TermKeyRoute = 'native' | 'xterm'

export function termKeyAction(ev: TermKeyEvent, hasSelection: boolean): TermKeyRoute {
  if (ev.type !== 'keydown') return 'xterm'

  const key = ev.key.toLowerCase()
  const plainModifiers = ev.ctrlKey && !ev.altKey && !ev.metaKey

  if (!plainModifiers) return 'xterm'

  if (key === 'v') return 'native'

  if (key === 'c') {
    return hasSelection ? 'native' : 'xterm'
  }

  return 'xterm'
}

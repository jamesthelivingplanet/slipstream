/**
 * ScreenState — headless terminal mirror of a session's PTY screen.
 *
 * `getSessionBuffer` used to hand clients the raw `OutputBuffer` ring buffer:
 * the entire TUI repaint byte history, trimmed to the last 256 KB at an
 * arbitrary character boundary (which can slice an ANSI escape sequence in
 * half) and replayed into a fresh xterm that may not be at the geometry the
 * PTY was at when the bytes were produced. Full-screen TUIs (the agent CLIs
 * this app drives) redraw the same regions repeatedly, so raw replay renders
 * mangled/duplicated fragments.
 *
 * Instead each live session feeds its PTY bytes into a headless `Terminal`
 * (the same VT parser xterm uses in the browser, run here with no DOM) and
 * serializes *the current screen + scrollback* on demand via
 * `@xterm/addon-serialize`. That's always a clean, geometry-consistent
 * repaint. A torn escape sequence at the very start of a feed (truncated
 * head) still prints its orphaned tail as stray characters, same as any VT
 * parser would — but because these are full-screen TUIs that clear + redraw
 * constantly, that garbage is almost always overwritten by the next repaint
 * within the same retained window, so what we *serialize* (current screen)
 * comes out clean even though what we *fed in* briefly wasn't.
 *
 * Pure / no side-effects beyond the wrapped xterm instance: no timers, no
 * filesystem, no native deps. Unit-testable without Electron or node-pty.
 */

import { Terminal, type ITerminalAddon } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'

export class ScreenState {
  private term: Terminal
  private serializeAddon: SerializeAddon
  // 0, not -1: "nothing parsed yet" lives in OutputBuffer's cumulative-seq
  // domain, which starts at 0. A snapshot taken before the session's first
  // output (a fast client racing a slow-to-first-frame agent) must report
  // seq 0 — a negative seq reads as "no snapshot yet" to the client's
  // ReplayGate and would wedge it closed (the exact FLO-103 symptom).
  private parsedSeq = 0
  private lastWrite: Promise<void> = Promise.resolve()

  constructor(cols = 80, rows = 30) {
    this.term = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true })
    this.serializeAddon = new SerializeAddon()
    // The serialize addon's types are declared against @xterm/xterm's Terminal,
    // not @xterm/headless's — the two are structurally identical for the
    // subset the addon uses, but TS sees them as unrelated nominal types.
    this.term.loadAddon(this.serializeAddon as unknown as ITerminalAddon)
  }

  /**
   * Feed a PTY chunk through the VT parser. `seq` is the caller's cumulative
   * sequence number for this chunk (matches `OutputBuffer.push`'s return
   * value) — recorded once xterm finishes parsing the chunk so `snapshot()`
   * can report a seq that's consistent with what's actually been rendered.
   */
  write(chunk: string, seq: number): void {
    this.lastWrite = new Promise((resolve) => {
      this.term.write(chunk, () => {
        this.parsedSeq = seq
        resolve()
      })
    })
  }

  /** Resize the mirror to match the PTY. Clamped so xterm never sees a
   *  degenerate 0-dimension buffer. */
  resize(cols: number, rows: number): void {
    this.term.resize(Math.max(cols, 2), Math.max(rows, 1))
  }

  /**
   * Await full parsing of everything written so far, then serialize the
   * current screen + scrollback. Consistent because xterm invokes write
   * callbacks strictly in order, and our continuation runs on the microtask
   * queue before any new PTY data (a macrotask) can be enqueued.
   */
  async snapshot(): Promise<{ data: string; seq: number }> {
    await this.lastWrite
    return { data: this.serializeAddon.serialize(), seq: this.parsedSeq }
  }

  dispose(): void {
    this.term.dispose()
  }
}

/**
 * Heal a scrollback file for a dead session: replay its raw bytes through a
 * temporary headless terminal at the session's last known geometry and
 * return the serialized screen. This is what makes cold (post-restart)
 * session views immune to the same truncation/geometry problems as live
 * ones — even though the persisted file has no seq bookkeeping of its own.
 */
export async function serializeScrollback(
  raw: string,
  cols: number,
  rows: number,
): Promise<string> {
  const screen = new ScreenState(cols, rows)
  try {
    screen.write(raw, 0)
    const { data } = await screen.snapshot()
    return data
  } finally {
    screen.dispose()
  }
}

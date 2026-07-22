/**
 * ScrollbackStore — bounded rolling file for PTY session scrollback.
 *
 * Appends PTY output chunks to a per-session file under `<root>/scrollback/<id>.log`.
 * Bounds total file size to MAX_CHARS (256 KB) consistent with the in-memory
 * OutputBuffer. Each chunk is appended with O(1) `fs.appendFileSync`; the
 * file is only re-read and re-bounded to the tail when it crosses a high-water
 * mark (2× MAX_CHARS), so a chatty session no longer does a full 256 KB
 * read-modify-rewrite on every PTY chunk. Provides a read snapshot for replay
 * on session resume/restart.
 *
 * Also persists the last-known PTY size alongside the log (`<id>.size.json`),
 * so a dead session's scrollback can be serialized (screenState.ts) at the
 * geometry it was actually produced at, instead of an arbitrary default.
 */

import fs from 'node:fs'
import path from 'node:path'
import { Osc52Stripper } from './oscStrip.js'

const MAX_CHARS = 256 * 1024 // 256 KB
const HIGH_WATER_CHARS = MAX_CHARS * 2 // truncate only once this much is on disk
const SUBDIR = 'scrollback'

export class ScrollbackStore {
  private root: string
  private strippers = new Map<string, Osc52Stripper>()
  /** Cached on-disk length (in chars) per session, so append() can decide
   *  when to re-bound without an fs call on every chunk. Lazily seeded from
   *  statSync on first append (covers resume, where the file already exists). */
  private sizes = new Map<string, number>()

  constructor(root: string) {
    this.root = root
    fs.mkdirSync(path.join(root, SUBDIR), { recursive: true })
  }

  private getStripper(sessionId: string): Osc52Stripper {
    let stripper = this.strippers.get(sessionId)
    if (!stripper) {
      stripper = new Osc52Stripper()
      this.strippers.set(sessionId, stripper)
    }
    return stripper
  }

  private filePath(sessionId: string): string {
    return path.join(this.root, SUBDIR, `${sessionId}.log`)
  }

  private sizeFilePath(sessionId: string): string {
    return path.join(this.root, SUBDIR, `${sessionId}.size.json`)
  }

  /**
   * Append a chunk of PTY output to the session's scrollback file.
   *
   * O(1) per call: `fs.appendFileSync` just extends the file. Only when the
   * file crosses HIGH_WATER_CHARS (2× MAX_CHARS) do we read it back and
   * re-bound it to the MAX_CHARS tail — so the expensive read-modify-rewrite
   * happens roughly once per MAX_CHARS of new output, not once per chunk.
   * (The prior implementation read+rewrote the whole file on every chunk,
   * which on a chatty build stalled the daemon event loop — FLO-134.)
   *
   * OSC 52 clipboard-write sequences are stripped before persisting: they'd
   * otherwise be replayed as live `data` on session resume (re-triggering
   * the renderer's clipboard handler with stale data), waste the scrollback
   * budget on large base64 payloads, and risk corruption from tail-slice
   * truncation mid-sequence.
   */
  append(sessionId: string, chunk: string): void {
    const stripped = this.getStripper(sessionId).push(chunk)
    if (stripped.length === 0) return
    const file = this.filePath(sessionId)
    try {
      let size = this.sizes.get(sessionId)
      if (size === undefined) {
        // First append for this session in this store instance. Seed the
        // counter from the existing file length (covers resume, where the
        // file already exists from a prior run) BEFORE appending, so this
        // chunk isn't double-counted. statSync byte length is an
        // over-estimate for non-ASCII vs. the char-based cap, which only
        // makes the high-water check trip a touch early — harmless.
        try {
          size = fs.statSync(file).size
        } catch {
          size = 0
        }
      }
      fs.appendFileSync(file, stripped, 'utf8')
      size += stripped.length
      if (size > HIGH_WATER_CHARS) {
        const buf = fs.readFileSync(file, 'utf8')
        const tail = buf.slice(buf.length - MAX_CHARS)
        fs.writeFileSync(file, tail, 'utf8')
        size = tail.length
      }
      this.sizes.set(sessionId, size)
    } catch {
      // best-effort: never let scrollback crash the session
    }
  }

  /**
   * Read the entire retained scrollback for a session.
   * Returns empty string if no file exists.
   */
  read(sessionId: string): string {
    const file = this.filePath(sessionId)
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return ''
    }
  }

  /**
   * Delete the scrollback file (and persisted size, if any) for a session
   * (cleanup on session delete). Also drops the session's OSC 52 stripper,
   * since its cross-chunk state has no more scrollback to write into.
   */
  delete(sessionId: string): void {
    const file = this.filePath(sessionId)
    try {
      fs.unlinkSync(file)
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(this.sizeFilePath(sessionId))
    } catch {
      // ignore
    }
    this.strippers.delete(sessionId)
    this.sizes.delete(sessionId)
  }

  /** Persist the last-known PTY size for a session (best-effort). */
  setSize(sessionId: string, cols: number, rows: number): void {
    try {
      fs.writeFileSync(this.sizeFilePath(sessionId), JSON.stringify({ cols, rows }), 'utf8')
    } catch {
      // best-effort: never let scrollback crash the session
    }
  }

  /**
   * Read the last-known PTY size for a session. Returns null if no size was
   * ever persisted, or the file is missing/corrupt/non-positive.
   */
  getSize(sessionId: string): { cols: number; rows: number } | null {
    try {
      const raw = fs.readFileSync(this.sizeFilePath(sessionId), 'utf8')
      const parsed = JSON.parse(raw) as { cols?: unknown; rows?: unknown }
      const { cols, rows } = parsed
      if (typeof cols === 'number' && typeof rows === 'number' && cols > 0 && rows > 0) {
        return { cols, rows }
      }
      return null
    } catch {
      return null
    }
  }
}

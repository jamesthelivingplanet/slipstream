/**
 * ScrollbackStore — bounded rolling file for PTY session scrollback.
 *
 * Appends PTY output chunks to a per-session file under `<root>/scrollback/<id>.log`.
 * Bounds total file size to MAX_CHARS (256 KB) consistent with the in-memory
 * OutputBuffer. Writes synchronously after each append — low-frequency data.
 * Provides a read snapshot for replay on session resume/restart.
 *
 * Also persists the last-known PTY size alongside the log (`<id>.size.json`),
 * so a dead session's scrollback can be serialized (screenState.ts) at the
 * geometry it was actually produced at, instead of an arbitrary default.
 */

import fs from 'node:fs'
import path from 'node:path'

const MAX_CHARS = 256 * 1024 // 256 KB
const SUBDIR = 'scrollback'

export class ScrollbackStore {
  private root: string

  constructor(root: string) {
    this.root = root
    fs.mkdirSync(path.join(root, SUBDIR), { recursive: true })
  }

  private filePath(sessionId: string): string {
    return path.join(this.root, SUBDIR, `${sessionId}.log`)
  }

  private sizeFilePath(sessionId: string): string {
    return path.join(this.root, SUBDIR, `${sessionId}.size.json`)
  }

  /**
   * Append a chunk of PTY output to the session's scrollback file.
   * Bounds the file to MAX_CHARS by keeping only the tail when exceeded.
   */
  append(sessionId: string, chunk: string): void {
    const file = this.filePath(sessionId)
    try {
      let buf = ''
      if (fs.existsSync(file)) {
        buf = fs.readFileSync(file, 'utf8')
      }
      buf += chunk
      if (buf.length > MAX_CHARS) {
        buf = buf.slice(buf.length - MAX_CHARS)
      }
      fs.writeFileSync(file, buf, 'utf8')
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
   * (cleanup on session delete).
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

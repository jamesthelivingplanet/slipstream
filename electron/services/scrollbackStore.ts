/**
  * ScrollbackStore — bounded rolling file for PTY session scrollback.
  *
  * Appends PTY output chunks to a per-session file under `<root>/logs/<id>.log`.
  * Bounds total file size to MAX_CHARS (256 KB) consistent with the in-memory
  * OutputBuffer. Writes synchronously after each append — low-frequency data.
  * Provides a read snapshot for replay on session resume/restart.
  */

import fs from 'node:fs'
import path from 'node:path'

const MAX_CHARS = 256 * 1024 // 256 KB
const SUBDIR = 'logs'

export class ScrollbackStore {
  /**
   * Append a chunk of PTY output to the session's scrollback file.
   * Bounds the file to MAX_CHARS by keeping only the tail when exceeded.
   */
  private root: string

  constructor(root: string) {
    this.root = root
    fs.mkdirSync(path.join(root, SUBDIR), { recursive: true })
  }

  private filePath(sessionId: string): string {
    return path.join(this.root, SUBDIR, `${sessionId}.log`)
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
   * Delete the scrollback file for a session (cleanup on session delete).
   */
  delete(sessionId: string): void {
    const file = this.filePath(sessionId)
    try {
      fs.unlinkSync(file)
    } catch {
      // ignore
    }
  }
}

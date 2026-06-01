/**
 * OutputBuffer — bounded ring-buffer for PTY session output.
 *
 * Retains the last MAX_BYTES characters of output for replay to late-joining
 * consumers (desktop panes that mount after spawn, web clients reconnecting
 * mid-session). Tracks a monotonically increasing byte sequence number so
 * callers can detect and discard duplicate chunks after a snapshot.
 *
 * Pure / no side-effects: no timers, no imports beyond the JS built-ins.
 * Unit-testable without native modules.
 */

const MAX_BYTES = 256 * 1024 // 256 KB

export class OutputBuffer {
  private buf = ''
  private cumSeq = 0

  /**
   * Append a PTY chunk. Bounds the retained buffer to MAX_BYTES (keeps the
   * last MAX_BYTES characters when exceeded). Returns the new cumulative
   * sequence number (total characters ever pushed, even trimmed ones).
   */
  push(chunk: string): number {
    this.buf += chunk
    this.cumSeq += chunk.length
    if (this.buf.length > MAX_BYTES) {
      this.buf = this.buf.slice(this.buf.length - MAX_BYTES)
    }
    return this.cumSeq
  }

  /**
   * Return a point-in-time snapshot of the retained buffer and the cumulative
   * sequence number. Consumers use `seq` as a high-water mark: live chunks
   * with `seq <= snap.seq` are duplicates and should be skipped.
   */
  snapshot(): { data: string; seq: number } {
    return { data: this.buf, seq: this.cumSeq }
  }
}

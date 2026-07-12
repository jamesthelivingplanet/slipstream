/**
 * ReplayGate — gates live PTY chunks against the buffer snapshot fetch.
 *
 * `TerminalView` subscribes to live session data before it has fetched the
 * initial screen snapshot (so no chunks are missed in the gap). Until the
 * snapshot resolves, chunks must be held rather than written — writing them
 * straight to a fresh xterm would race the snapshot write and interleave.
 * `applySnapshot` writes the snapshot then flushes held chunks newer than it
 * (dropping duplicates already represented in the snapshot). `fail()` opens
 * the gate stream-only — used when the snapshot fetch itself fails (e.g. a
 * fresh start racing the backend session's creation) so a missing session
 * can't wedge the view closed forever.
 */
export class ReplayGate {
  private snapSeq = -1
  private held: Array<[string, number]> = []

  constructor(private sink: (chunk: string) => void) {}

  get open(): boolean {
    return this.snapSeq >= 0
  }

  /** Route a live chunk: sink immediately once open, else hold it. */
  push(chunk: string, seq: number): void {
    if (this.open) {
      this.sink(chunk)
      return
    }
    this.held.push([chunk, seq])
  }

  /** Write the snapshot, then flush held chunks newer than it, dropping
   *  duplicates. No-op if already open.
   *
   *  `seq`/`chunkSeq` are cumulative character counts (see OutputBuffer.push),
   *  and the server coalesces PTY output into 40ms batches (rpc.ts), so a
   *  held batch's seq is its END, not its start. A batch can therefore
   *  STRADDLE the snapshot boundary — start before `seq`, end after it — in
   *  which case only the bytes beyond the boundary are new; replaying the
   *  batch whole would double-write its covered head into the terminal. */
  applySnapshot(data: string, seq: number): void {
    if (this.open) return
    this.sink(data)
    for (const [chunk, chunkSeq] of this.held) {
      if (chunkSeq <= seq) continue // fully covered by the snapshot
      const startSeq = chunkSeq - chunk.length
      this.sink(startSeq >= seq ? chunk : chunk.slice(seq - startSeq))
    }
    this.held.length = 0
    // Clamp: `open` is `snapSeq >= 0`, so a producer handing us a negative
    // seq must never leave the gate wedged closed.
    this.snapSeq = Math.max(0, seq)
  }

  /** Open the gate without a snapshot (fetch failed): flush everything held
   *  and pass subsequent chunks straight through. No-op if already open. */
  fail(): void {
    if (this.open) return
    for (const [chunk] of this.held) {
      this.sink(chunk)
    }
    this.held.length = 0
    this.snapSeq = 0
  }
}

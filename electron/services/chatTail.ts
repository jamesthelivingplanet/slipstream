/**
 * chatTail — generic fs.watch-based tail-and-parse mechanism, factored out of
 * the original Claude Code transcript tail (TASK-FPH60) so the pi session-file
 * tail (TASK-FPH60 pi extension) reuses it instead of duplicating the
 * byte-offset read loop. Only `resolveFile`/`parse` differ between backends —
 * opencode does NOT use this (no file to watch; it's polled instead, see
 * sessionManager.ts's opencode chat poller).
 *
 * A watched file may not exist yet (the transcript/session file is created on
 * the agent's first turn), so resolution is lazy: retried on a backstop timer
 * and on-demand via the returned handle's `poke()` (sessionManager wires this
 * to PTY data, which fires constantly while the agent works — the common path
 * to resolving fast). Once resolved, only the file's tail is re-read on each
 * fs event using a byte-offset cursor (`completeLines`) that never consumes a
 * still-being-written trailing line, and parsed messages are deduped by
 * `uuid` before `onMessage` fires — a re-delivered tail read (or a fs.watch
 * coalescing quirk) never produces a duplicate.
 */
import * as fs from 'node:fs'
import { completeLines } from './transcriptMessages.js'

const DEFAULT_RETRY_INTERVAL_MS = 2000
const DEFAULT_RETRY_TIMEOUT_MS = 5 * 60_000

export interface ChatTailCursor<T> {
  /** Parse `raw` (a `completeLines().complete` chunk, or a full read) and
   *  return only the messages not already delivered by this cursor. */
  next(raw: string): T[]
}

/** Generic uuid-dedupe cursor, parameterized by parser. `createChatCursor` in
 *  transcriptMessages.ts is the claude-specific instance of this shape (kept
 *  as-is for its existing tests); pi's tail uses this directly. */
export function createCursor<T extends { uuid: string }>(
  parse: (raw: string) => T[],
): ChatTailCursor<T> {
  const seen = new Set<string>()
  return {
    next(raw: string): T[] {
      const fresh: T[] = []
      for (const msg of parse(raw)) {
        if (seen.has(msg.uuid)) continue
        seen.add(msg.uuid)
        fresh.push(msg)
      }
      return fresh
    },
  }
}

export interface ChatTailHandle {
  /** Nudge resolution/re-read now (e.g. on PTY data). No-op once resolved and
   *  idle — the fs.watch takes over. Safe to call after dispose (no-op). */
  poke(): void
  /** Stop watching/retrying. Idempotent. */
  dispose(): void
}

/**
 * Start tailing a lazily-resolved file. See module doc for the full
 * mechanism. `onMessage` fires once per newly-seen message, oldest first,
 * for each batch of complete lines read.
 */
export function startChatTail<T extends { uuid: string }>(opts: {
  /** Resolve the file to tail right now, or null if it doesn't exist yet.
   *  Synchronous — same contract as transcriptPathFor. Called repeatedly
   *  until it returns non-null (or the retry timeout elapses). */
  resolveFile: () => string | null
  parse: (raw: string) => T[]
  onMessage: (msg: T) => void
  retryIntervalMs?: number
  retryTimeoutMs?: number
}): ChatTailHandle {
  const retryIntervalMs = opts.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS
  const retryTimeoutMs = opts.retryTimeoutMs ?? DEFAULT_RETRY_TIMEOUT_MS
  const retryDeadline = Date.now() + retryTimeoutMs

  let disposed = false
  let file: string | null = null
  let offset = 0
  let watcher: ReturnType<typeof fs.watch> | undefined
  let retryTimer: ReturnType<typeof setInterval> | undefined
  const cursor = createCursor(opts.parse)

  function clearRetry(): void {
    if (retryTimer) {
      clearInterval(retryTimer)
      retryTimer = undefined
    }
  }

  function tail(): void {
    if (!file) return
    let stat: fs.Stats
    try {
      stat = fs.statSync(file)
    } catch {
      return // file briefly missing between watch events — next event retries
    }
    if (stat.size < offset) offset = 0 // rotated/truncated — restart
    if (stat.size <= offset) return

    let fd: number
    try {
      fd = fs.openSync(file, 'r')
    } catch {
      return
    }
    const length = stat.size - offset
    const buf = Buffer.alloc(length)
    try {
      fs.readSync(fd, buf, 0, length, offset)
    } catch {
      return
    } finally {
      fs.closeSync(fd)
    }

    const { complete, consumedBytes } = completeLines(buf.toString('utf8'))
    if (consumedBytes === 0) return // trailing partial line — wait for more data
    offset += consumedBytes
    for (const msg of cursor.next(complete)) {
      opts.onMessage(msg)
    }
  }

  function resolve(): void {
    if (file || disposed) return
    const found = opts.resolveFile()
    if (!found) {
      if (Date.now() > retryDeadline) dispose()
      return
    }
    file = found
    clearRetry() // stop the retry timer — it's served its purpose
    tail() // catch up on whatever was already written
    try {
      const w = fs.watch(file, { persistent: false }, () => tail())
      w.on('error', () => {
        /* ignore */
      })
      watcher = w
    } catch {
      // Watch failed (e.g. fs limits) — the file is still readable on future
      // poke()-triggered attempts, just without live push.
    }
  }

  function dispose(): void {
    disposed = true
    clearRetry()
    watcher?.close()
    watcher = undefined
  }

  retryTimer = setInterval(resolve, retryIntervalMs)
  resolve() // resume/attach: the file may already exist

  return { poke: resolve, dispose }
}

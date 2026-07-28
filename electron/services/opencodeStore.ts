/**
 * opencodeStore.ts — durable fallback reader for opencode chat history.
 *
 * sessionChatReader's opencode branch reads messages from the TUI's embedded
 * HTTP server (fetchOpencodeMessages in opencodeSessions.ts), which is
 * in-memory, live-process state: a port + session id captured while the TUI
 * is running. Once that process exits — or the daemon restarts, which wipes
 * all in-memory session state — there is no port to ask, and the chat panel
 * (and the handoff prompt, which needs the prior agent's conversation) would
 * see an entire opencode session's history vanish. claude-code (JSONL
 * transcript) and pi (session file) don't have this gap; only opencode does,
 * because its message store historically wasn't consulted as a fallback.
 *
 * opencode itself doesn't lose this data — it persists every message/part to
 * a durable SQLite database at `<XDG_DATA_HOME or ~/.local/share>/opencode/
 * opencode.db` (sibling to the per-message JSON files opencodeUsage.ts reads
 * under `opencode/storage/`; same base-dir convention, different subpath).
 * This module reads that database directly and reassembles rows into the
 * exact `OpencodeMessage[]` shape opencodeSessions.ts's `fetchOpencodeMessages`
 * returns, so sessionChatReader can feed both through the same pure mapper
 * (`opencodeMessagesToChat`) — no second mapper, no shape drift.
 *
 * Best-effort, matching sessionChatReader's "never throws" contract: opening
 * the db, querying it, and parsing each row's JSON `data` column can each
 * fail independently (db file missing because opencode was never run, a
 * writer holding a lock, a schema opencode changes out from under us, a
 * truncated row from a crash mid-write) and none of that should surface as an
 * error — a missing history is a `{ available: false, messages: [] }` outcome
 * for the caller, not a crash. Malformed rows are skipped individually rather
 * than failing the whole read, since one bad row shouldn't hide the rest of
 * an otherwise-readable conversation.
 */
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

import type {
  OpencodeMessage,
  OpencodeMessageInfo,
  OpencodeMessagePart,
} from './opencodeSessions.js'

/** Path to opencode's durable SQLite store. Mirrors the base-dir idiom in
 *  opencodeStorageRoot() (opencodeUsage.ts) — same env var, same fallback —
 *  but the db file sits directly under `opencode/`, not `opencode/storage/`. */
export function opencodeDbPath(): string {
  const base = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share')
  return path.join(base, 'opencode', 'opencode.db')
}

interface RowWithData {
  id: string
  data: string
}

/** Best-effort JSON.parse of a `data` column into a plain object. Returns
 *  null for unparseable JSON or a non-object result (array/primitive/null) —
 *  callers skip the row rather than propagate a shape they can't use. */
function parseDataObject(raw: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(raw)
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * Read one opencode session's messages (with their parts) from the durable
 * SQLite store, oldest first — the same order fetchOpencodeMessages' HTTP
 * response uses, so callers don't need to re-sort. Returns `[]` on any
 * failure: no db file, a locked/corrupt db, an unexpected schema, or a
 * session id with no rows. `dbPath` defaults to `opencodeDbPath()` and is
 * injectable so tests point it at a temp fixture instead of the real store.
 *
 * Row shapes (verified against a live opencode.db): `message.data` and
 * `part.data` hold the JSON body opencode's HTTP API would return, EXCEPT
 * the row's own `id` is a separate column, not inside `data` — spliced back
 * in below so the result matches what fetchOpencodeMessages returns.
 */
export function readOpencodeMessagesFromStore(
  sessionId: string,
  dbPath: string = opencodeDbPath(),
): OpencodeMessage[] {
  let db: Database.Database
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
  } catch {
    // Missing file, unreadable, locked, or not a SQLite db at all.
    return []
  }

  try {
    const messageRows = db
      .prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC')
      .all(sessionId) as RowWithData[]

    const partStmt = db.prepare(
      'SELECT id, data FROM part WHERE message_id = ? ORDER BY time_created ASC',
    )

    const out: OpencodeMessage[] = []
    for (const row of messageRows) {
      const infoData = parseDataObject(row.data)
      if (!infoData) continue // malformed message row — skip, don't fail the read

      let partRows: RowWithData[]
      try {
        partRows = partStmt.all(row.id) as RowWithData[]
      } catch {
        partRows = []
      }

      const parts: OpencodeMessagePart[] = []
      for (const partRow of partRows) {
        const partData = parseDataObject(partRow.data)
        if (!partData) continue // malformed part row — skip, keep the rest
        parts.push({ ...partData, id: partRow.id } as unknown as OpencodeMessagePart)
      }

      out.push({ info: { ...infoData, id: row.id } as OpencodeMessageInfo, parts })
    }
    return out
  } catch {
    // Query failed outright — e.g. table missing/renamed under a schema we
    // don't recognize. Degrade to "nothing recoverable" rather than throw.
    return []
  } finally {
    try {
      db.close()
    } catch {
      // best-effort cleanup — nothing to do if close itself fails
    }
  }
}

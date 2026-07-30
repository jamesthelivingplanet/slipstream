/**
 * opencodeStore.ts — durable fallback reader for opencode (and kilo) chat
 * history.
 *
 * sessionChatReader's embedded-server branch (opencode, and kilo — an
 * opencode fork, see usesEmbeddedServer in agentBackend.ts) reads messages
 * from the TUI's embedded HTTP server (fetchOpencodeMessages in
 * opencodeSessions.ts), which is in-memory, live-process state: a port +
 * session id captured while the TUI is running. Once that process exits — or
 * the daemon restarts, which wipes all in-memory session state — there is no
 * port to ask, and the chat panel (and the handoff prompt, which needs the
 * prior agent's conversation) would see an entire session's history vanish.
 * claude-code (JSONL transcript) and pi (session file) don't have this gap;
 * only opencode/kilo do, because their message store historically wasn't
 * consulted as a fallback.
 *
 * opencode itself doesn't lose this data — it persists every message/part to
 * a durable SQLite database at `<XDG_DATA_HOME or ~/.local/share>/opencode/
 * opencode.db` (sibling to the per-message JSON files opencodeUsage.ts reads
 * under `opencode/storage/`; same base-dir convention, different subpath).
 * Kilo, being an opencode fork, persists to its OWN durable SQLite database
 * at the equivalent `kilo/kilo.db` path (see `kiloDbPath` below) — NOT
 * opencode's db. This module reads either database directly and reassembles
 * rows into the exact `OpencodeMessage[]` shape opencodeSessions.ts's
 * `fetchOpencodeMessages` returns, so sessionChatReader can feed both
 * opencode's and kilo's rows through the same pure mapper
 * (`opencodeMessagesToChat`) — no second mapper, no shape drift.
 *
 * Kilo verification caveat: inspection of a real `~/.local/share/kilo/
 * kilo.db` on this machine confirmed the `message`/`part` table schema is
 * IDENTICAL to opencode's (same columns: `message(id, session_id,
 * time_created, time_updated, data)`, `part(id, message_id, session_id,
 * time_created, time_updated, data)`), which is why this module is reused
 * unchanged rather than forked. However, that db's tables were EMPTY at
 * inspection time (kilo was installed but had never recorded a session), so
 * the JSON *shape* of the `data` column — the actual fields inside
 * `message.data`/`part.data` that `parseDataObject` hands to
 * `opencodeMessagesToChat` — is verified only against opencode's schema
 * documentation/behavior, not against a real kilo-produced row. If kilo's
 * `data` JSON shape ever diverges from opencode's, this module's per-row
 * best-effort contract (below) means the worst case is silently skipped rows
 * (an honest empty/partial read), never a crash — strictly better than the
 * bug this fixes (kilo chat reads being routed into opencode's own db, where
 * a kilo session id matches nothing at all).
 *
 * Best-effort, matching sessionChatReader's "never throws" contract: opening
 * the db, querying it, and parsing each row's JSON `data` column can each
 * fail independently (db file missing because opencode/kilo was never run, a
 * writer holding a lock, a schema change out from under us, a truncated row
 * from a crash mid-write) and none of that should surface as an error — a
 * missing history is a `{ available: false, messages: [] }` outcome for the
 * caller, not a crash. Malformed rows are skipped individually rather than
 * failing the whole read, since one bad row shouldn't hide the rest of an
 * otherwise-readable conversation.
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

/** Path to kilo's OWN durable SQLite store — a separate file from opencode's,
 *  despite kilo being an opencode fork with a schema-identical message/part
 *  store (see module doc comment's verification caveat). Same base-dir idiom
 *  as opencodeDbPath() (XDG_DATA_HOME, else ~/.local/share), but under
 *  `kilo/kilo.db` rather than `opencode/opencode.db`. Reading a kilo session
 *  id out of opencode's db (or vice versa) matches nothing — this is the
 *  fix for that mismatch, not a new reader/mapper. */
export function kiloDbPath(): string {
  const base = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share')
  return path.join(base, 'kilo', 'kilo.db')
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
 * Read one opencode-OR-kilo session's messages (with their parts) from the
 * durable SQLite store, oldest first — the same order fetchOpencodeMessages'
 * HTTP response uses, so callers don't need to re-sort. Returns `[]` on any
 * failure: no db file, a locked/corrupt db, an unexpected schema, or a
 * session id with no rows. `dbPath` defaults to `opencodeDbPath()`; pass
 * `kiloDbPath()` (or an override) explicitly to read kilo's store instead —
 * see sessionChatReader.ts's kind-based dbPath selection. Also injectable so
 * tests point it at a temp fixture instead of either real store.
 *
 * Row shapes (verified against a live opencode.db; schema-only for kilo, per
 * the module doc comment's caveat): `message.data` and `part.data` hold the
 * JSON body opencode's HTTP API would return, EXCEPT the row's own `id` is a
 * separate column, not inside `data` — spliced back in below so the result
 * matches what fetchOpencodeMessages returns.
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

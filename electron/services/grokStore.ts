/**
 * grokStore.ts — durable reader for grok-dev's chat history.
 *
 * grok persists every session/message to a SQLite database at
 * `~/.grok/grok.db` (verified against grok-dev v1.1.7's compiled source);
 * this module reads it directly and hands rows to the pure mapper in
 * grokChatMessages.ts, in the style of opencodeStore.ts (opencode's
 * equivalent durable-store reader).
 *
 * Unlike opencode, Slipstream does not persist a grok session id alongside
 * the session row (no `session.grokSid` analogous to `session.opencodeSid`)
 * — grok has no live embedded-server source to capture one from in the
 * first place (sessionChatReader.ts's comment: "antigravity and grok have
 * no reader"). So session *selection* has to happen here, by worktree: find
 * grok's `workspaces` row for the session's cwd, then take the newest
 * `sessions` row under that workspace. This mirrors grok's own `--session
 * latest` resume semantics and pi's newest-file selection
 * (`findNewestPiSessionFile` in piSessions.ts) — same idea, different store
 * shape.
 *
 * Best-effort, matching sessionChatReader's "never throws" contract: opening
 * the db, querying it, and parsing each row's `message_json` can each fail
 * independently (db file missing because grok was never run, a writer
 * holding a lock, a schema grok changes out from under us, a truncated row
 * from a crash mid-write) and none of that should surface as an error — no
 * matching workspace/session, or no db at all, is an empty result for the
 * caller, not a crash. Malformed rows are skipped individually by the mapper
 * rather than failing the whole read.
 */
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

import type { SessionChatMessageDTO } from '../shared/contract.js'
import { parseGrokMessages, type GrokMessageRow } from './grokChatMessages.js'

/** Path to grok's durable SQLite store. No env override is known to exist
 *  for grok-dev (unlike opencode's XDG_DATA_HOME or claude-code's
 *  CLAUDE_CONFIG_DIR), so this is a fixed default; callers needing a
 *  different location (tests, above all) pass `dbPath` explicitly to
 *  `readGrokMessagesFromStore`/`selectNewestGrokSessionId` instead. */
export function grokDbPath(): string {
  return path.join(os.homedir(), '.grok', 'grok.db')
}

interface WorkspaceIdRow {
  id: string
}

interface SessionIdRow {
  id: string
}

/**
 * Pick the newest grok session for a given worktree path, or null when
 * nothing matches. Exported as its own unit so tests can exercise selection
 * against an in-memory/temp db without going through file I/O.
 *
 * Matching: `workspaces.canonical_path === worktreePath`; if no workspace
 * matches that way, fall back to `workspaces.git_root === worktreePath` (a
 * worktree's canonical_path can differ from its repo's git_root, and grok
 * may have only recorded one or the other depending on how it was invoked
 * there). "Newest" is `sessions` ordered by `updated_at` (falling back to
 * `created_at` when `updated_at` is null), matching grok's own `--session
 * latest` resume semantics.
 */
export function selectNewestGrokSessionId(
  db: Database.Database,
  worktreePath: string,
): string | null {
  let workspaceRows = db
    .prepare('SELECT id FROM workspaces WHERE canonical_path = ?')
    .all(worktreePath) as WorkspaceIdRow[]
  if (workspaceRows.length === 0) {
    workspaceRows = db
      .prepare('SELECT id FROM workspaces WHERE git_root = ?')
      .all(worktreePath) as WorkspaceIdRow[]
  }
  if (workspaceRows.length === 0) return null

  const workspaceIds = workspaceRows.map((w) => w.id)
  const placeholders = workspaceIds.map(() => '?').join(',')
  const sessionRow = db
    .prepare(
      `SELECT id FROM sessions
       WHERE workspace_id IN (${placeholders})
       ORDER BY COALESCE(updated_at, created_at) DESC, created_at DESC
       LIMIT 1`,
    )
    .get(...workspaceIds) as SessionIdRow | undefined

  return sessionRow?.id ?? null
}

/**
 * Read a worktree's grok chat history from the durable SQLite store, oldest
 * first. Returns `[]` on any failure: no db file, a locked/corrupt db, an
 * unexpected schema, or no session found for the worktree. `dbPath` defaults
 * to `grokDbPath()` and is injectable so tests point it at a temp fixture
 * instead of the real per-machine store.
 */
export function readGrokMessagesFromStore(
  worktreePath: string,
  dbPath: string = grokDbPath(),
): SessionChatMessageDTO[] {
  let db: Database.Database
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
  } catch {
    // Missing file, unreadable, locked, or not a SQLite db at all.
    return []
  }

  try {
    const sessionId = selectNewestGrokSessionId(db, worktreePath)
    if (!sessionId) return []

    const rows = db
      .prepare(
        'SELECT session_id, seq, role, message_json, created_at FROM messages WHERE session_id = ? ORDER BY seq ASC',
      )
      .all(sessionId) as GrokMessageRow[]

    return parseGrokMessages(rows)
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

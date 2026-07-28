/**
 * antigravityStore.ts — best-effort durable reader for antigravity's (`agy`)
 * per-conversation SQLite chat history (TASK-N6X4R).
 *
 * antigravity persists each conversation to its OWN SQLite file at
 * `~/.gemini/antigravity-cli/conversations/<uuid>.db`, table `steps(idx,
 * step_type, status, metadata, error_details, permissions, task_details,
 * render_info, step_payload, step_format)`. This module opens one such db
 * read-only, reads `steps` ordered by `idx` ASC, and hands each row's
 * `step_payload` to the reverse-engineered, best-effort mapper in
 * antigravityChatMessages.ts — see that file's module doc for the honest
 * framing (no `.proto` schema obtainable, mapping is empirically recovered
 * from two samples, drift-detection notes).
 *
 * Unlike grok (one `grok.db` with a `workspaces` table scoping sessions to
 * a cwd — see grokStore.ts) or opencode (durable store keyed by a sid
 * Slipstream persists on the session row), the `steps` table documented for
 * this reader carries NO workspace/cwd column at all. So on its own, this
 * module has no way to answer "which conversation belongs to this session's
 * worktree" — that scoping signal, if it exists at all in antigravity's
 * data, lives outside what's documented here. This module exposes only the
 * primitives that ARE possible without it:
 *   - readAntigravityMessagesFromDb: read ONE known conversation db (by
 *     path or by conversation id under the default directory) — the
 *     primitive a caller uses once it has a conversation id from elsewhere.
 *   - listAntigravityConversationIds / readNewestAntigravityConversation:
 *     enumerate/read by file mtime, newest first — the only ordering signal
 *     available without a workspace table. Best-effort fallback for a
 *     caller with no better selection signal (e.g. exactly one antigravity
 *     conversation ever run on this machine).
 * Wiring a specific session to a specific conversation id (e.g. a future
 * `session.antigravityConversationId` column) is left to the caller.
 *
 * Never throws, matching sessionChatReader's "never throws" contract:
 * opening the db, querying it, and mapping each row can each fail
 * independently (db file missing because antigravity was never run, a
 * writer holding a lock, a schema `agy` changes out from under us, a
 * truncated row from a crash mid-write) and none of that should surface as
 * an error — a missing/unreadable db, or a query against an unexpected
 * schema, degrades to `[]`, never a throw. Malformed rows are skipped
 * individually by the mapper rather than failing the whole read.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

import type { SessionChatMessageDTO } from '../shared/contract.js'
import { parseAntigravitySteps, type AntigravityStepRow } from './antigravityChatMessages.js'

const DB_EXTENSION = '.db'

/** Default directory antigravity stores per-conversation SQLite dbs in. */
export function antigravityConversationsDir(): string {
  return path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations')
}

/** Expected db path for a given conversation id under `dir` (defaults to
 *  antigravityConversationsDir()). Pure path-joining — does not check the
 *  file exists. */
export function antigravityDbPathFor(
  conversationId: string,
  dir: string = antigravityConversationsDir(),
): string {
  return path.join(dir, `${conversationId}${DB_EXTENSION}`)
}

/**
 * List every `<uuid>.db` file in the conversations dir, newest-first by
 * file mtime — the only ordering signal available without a workspace/cwd
 * table (see module doc). `[]` when the directory doesn't exist or isn't
 * readable (antigravity never run, wrong machine/user, or `dir` points
 * somewhere else entirely — tests pass a temp dir here so real user data is
 * never touched). Returned strings are conversation ids (filename with the
 * `.db` extension stripped) — no further validation of the filename shape,
 * consistent with this whole reader's best-effort posture.
 */
export function listAntigravityConversationIds(
  dir: string = antigravityConversationsDir(),
): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const withMtime = entries
    .filter((e) => e.isFile() && e.name.endsWith(DB_EXTENSION))
    .map((e) => {
      const full = path.join(dir, e.name)
      let mtimeMs = 0
      try {
        mtimeMs = fs.statSync(full).mtimeMs
      } catch {
        // Vanished between readdir and stat, or unreadable — sorts last
        // rather than aborting the whole listing.
      }
      return { id: e.name.slice(0, -DB_EXTENSION.length), mtimeMs }
    })

  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return withMtime.map((f) => f.id)
}

interface StepRow {
  idx: number
  step_type: number
  step_payload: Buffer | null
}

/**
 * Read one conversation's chat history from its SQLite db, oldest first
 * (steps ordered by `idx` ASC). Returns `[]` on any failure: missing file,
 * locked/corrupt db, or an unexpected schema (a column renamed/dropped in
 * an `agy` upgrade) — never throws. `dbPath` defaults to this
 * conversation's expected path under antigravityConversationsDir() and is
 * injectable so tests use a temp fixture instead of the real per-machine
 * store.
 */
export function readAntigravityMessagesFromDb(
  conversationId: string,
  dbPath: string = antigravityDbPathFor(conversationId),
): SessionChatMessageDTO[] {
  let db: Database.Database
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
  } catch {
    // Missing file, unreadable, locked, or not a SQLite db at all.
    return []
  }

  try {
    const rows = db
      .prepare('SELECT idx, step_type, step_payload FROM steps ORDER BY idx ASC')
      .all() as StepRow[]
    const stepRows: AntigravityStepRow[] = rows.map((r) => ({
      idx: r.idx,
      step_type: r.step_type,
      step_payload: r.step_payload,
    }))
    return parseAntigravitySteps(stepRows, conversationId)
  } catch {
    // Query failed outright — e.g. table/column missing under a schema we
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

/**
 * Convenience: read the most-recently-modified conversation on disk, with
 * NO cwd/session scoping (see module doc — this reader has no signal for
 * that). Returns null when there are no conversation dbs at all. Exists so
 * a caller with no better selection signal has a usable, honest default
 * rather than reimplementing this same newest-file fallback itself —
 * mirrors piSessions.ts's findNewestPiSessionFile in spirit, but by mtime
 * across whole conversation files rather than lines within one.
 */
export function readNewestAntigravityConversation(
  dir: string = antigravityConversationsDir(),
): { conversationId: string; messages: SessionChatMessageDTO[] } | null {
  const [newest] = listAntigravityConversationIds(dir)
  if (!newest) return null
  const messages = readAntigravityMessagesFromDb(newest, antigravityDbPathFor(newest, dir))
  return { conversationId: newest, messages }
}

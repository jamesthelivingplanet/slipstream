import Database from 'better-sqlite3'
import type {
  RepoDTO,
  SessionDTO,
  RepoSettings,
  PromptTemplateDTO,
  SessionOutcomeDTO,
  SessionAgentEventDTO,
} from '../shared/contract.js'
import { runMigrations } from './migrations.js'

/** Open (or create) a SQLite database at `file` and apply the schema. */
export function openDb(file: string): Database.Database {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  runMigrations(db)
  return db
}

// better-sqlite3 doesn't cache prepared statements itself, and every DAO
// below is called on the hot path (e.g. upsertSession on every status
// persist, on the same event loop that pumps PTY data). Cache per-db rather
// than at module scope: multiple Database instances can exist in one process
// (tests, the CLI helpers in cli/manageTokens.ts and cli/slipstream.ts, the
// long-lived one in core/services.ts), so a statement prepared against one
// db can't be reused against another.
const stmtCache = new WeakMap<Database.Database, Map<string, Database.Statement>>()

function prepared(db: Database.Database, sql: string): Database.Statement {
  let cache = stmtCache.get(db)
  if (!cache) {
    cache = new Map()
    stmtCache.set(db, cache)
  }
  let stmt = cache.get(sql)
  if (!stmt) {
    stmt = db.prepare(sql)
    cache.set(sql, stmt)
  }
  return stmt
}

// ── Typed DAO helpers ────────────────────────────────────────────────────────

export function upsertRepo(db: Database.Database, repo: RepoDTO): void {
  prepared(
    db,
    `
    INSERT INTO repos (id, org, name, base, path, remoteUrl, ownerId)
    VALUES (@id, @org, @name, @base, @path, @remoteUrl, @ownerId)
    ON CONFLICT(id) DO UPDATE SET
      org       = excluded.org,
      name      = excluded.name,
      base      = excluded.base,
      path      = excluded.path,
      remoteUrl = excluded.remoteUrl,
      ownerId   = excluded.ownerId
  `,
  ).run({ ...repo, remoteUrl: repo.remoteUrl ?? null, ownerId: repo.ownerId ?? 'local' })
}

export function allRepos(db: Database.Database): RepoDTO[] {
  return prepared(
    db,
    'SELECT id, org, name, base, path, remoteUrl, ownerId FROM repos',
  ).all() as RepoDTO[]
}

export function getRepo(db: Database.Database, id: string): RepoDTO | undefined {
  return prepared(
    db,
    'SELECT id, org, name, base, path, remoteUrl, ownerId FROM repos WHERE id = ?',
  ).get(id) as RepoDTO | undefined
}

export function upsertSession(db: Database.Database, session: SessionDTO): void {
  prepared(
    db,
    `
    INSERT INTO sessions (id, tid, title, prompt, repoId, branch, status, port, systemPrompt, agentKind, opencodeSid, createdAt, ownerId, prUrl, src)
    VALUES (@id, @tid, @title, @prompt, @repoId, @branch, @status, @port, @systemPrompt, @agentKind, @opencodeSid, @createdAt, @ownerId, @prUrl, @src)
    ON CONFLICT(id) DO UPDATE SET
      tid          = excluded.tid,
      title        = excluded.title,
      prompt       = excluded.prompt,
      repoId       = excluded.repoId,
      branch       = excluded.branch,
      status       = excluded.status,
      port         = excluded.port,
      systemPrompt = excluded.systemPrompt,
      agentKind    = excluded.agentKind,
      opencodeSid  = excluded.opencodeSid,
      createdAt    = excluded.createdAt,
      ownerId      = excluded.ownerId,
      prUrl        = excluded.prUrl,
      src          = excluded.src
  `,
  ).run({
    ...session,
    port: session.port ?? null,
    systemPrompt: session.systemPrompt ?? null,
    agentKind: session.agentKind ?? 'claude-code',
    opencodeSid: session.opencodeSid ?? null,
    ownerId: session.ownerId ?? 'local',
    prUrl: session.prUrl ?? null,
    src: session.src ?? null,
  })
}

export function allSessions(db: Database.Database): SessionDTO[] {
  return prepared(db, 'SELECT * FROM sessions').all() as SessionDTO[]
}

export function getSession(db: Database.Database, id: string): SessionDTO | undefined {
  return prepared(db, 'SELECT * FROM sessions WHERE id = ?').get(id) as SessionDTO | undefined
}

export function deleteSession(db: Database.Database, id: string): void {
  db.transaction(() => {
    prepared(db, 'DELETE FROM session_outcomes WHERE sessionId = ?').run(id)
    prepared(db, 'DELETE FROM session_agent_events WHERE sessionId = ?').run(id)
    prepared(db, 'DELETE FROM sessions WHERE id = ?').run(id)
  })()
}

export function upsertSessionOutcome(db: Database.Database, o: SessionOutcomeDTO): void {
  prepared(
    db,
    `
    INSERT INTO session_outcomes (sessionId, result, summary, details, reportedAt)
    VALUES (@sessionId, @result, @summary, @details, @reportedAt)
    ON CONFLICT(sessionId) DO UPDATE SET
      result     = excluded.result,
      summary    = excluded.summary,
      details    = excluded.details,
      reportedAt = excluded.reportedAt
  `,
  ).run({ ...o, details: o.details ?? null })
}

export function getSessionOutcome(
  db: Database.Database,
  sessionId: string,
): SessionOutcomeDTO | undefined {
  const row = prepared(
    db,
    'SELECT sessionId, result, summary, details, reportedAt FROM session_outcomes WHERE sessionId = ?',
  ).get(sessionId) as (SessionOutcomeDTO & { details: string | null }) | undefined
  if (!row) return undefined
  return { ...row, details: row.details ?? undefined }
}

export function allSessionOutcomes(db: Database.Database): SessionOutcomeDTO[] {
  const rows = prepared(
    db,
    'SELECT sessionId, result, summary, details, reportedAt FROM session_outcomes',
  ).all() as (SessionOutcomeDTO & { details: string | null })[]
  return rows.map((row) => ({ ...row, details: row.details ?? undefined }))
}

export function deleteSessionOutcome(db: Database.Database, sessionId: string): void {
  prepared(db, 'DELETE FROM session_outcomes WHERE sessionId = ?').run(sessionId)
}

// ── Session agent events (FLO-104) ───────────────────────────────────────────

/** INSERT OR IGNORE on the (sessionId, kind, ts) unique index — the watcher
 *  replays the whole events.ndjson after a daemon restart, so inserts must be
 *  idempotent. */
export function insertSessionAgentEvent(db: Database.Database, e: SessionAgentEventDTO): void {
  prepared(
    db,
    `
    INSERT OR IGNORE INTO session_agent_events (sessionId, kind, message, path, ts)
    VALUES (@sessionId, @kind, @message, @path, @ts)
  `,
  ).run({ ...e, message: e.message ?? null, path: e.path ?? null })
}

export function listSessionAgentEvents(
  db: Database.Database,
  sessionId: string,
): SessionAgentEventDTO[] {
  const rows = prepared(
    db,
    'SELECT sessionId, kind, message, path, ts FROM session_agent_events WHERE sessionId = ? ORDER BY ts',
  ).all(sessionId) as (SessionAgentEventDTO & { message: string | null; path: string | null })[]
  return rows.map((row) => ({
    ...row,
    message: row.message ?? undefined,
    path: row.path ?? undefined,
  }))
}

export function deleteSessionAgentEvents(db: Database.Database, sessionId: string): void {
  prepared(db, 'DELETE FROM session_agent_events WHERE sessionId = ?').run(sessionId)
}

export function deleteRepo(db: Database.Database, id: string): void {
  db.transaction(() => {
    prepared(db, 'DELETE FROM repo_settings WHERE repoId = ?').run(id)
    prepared(db, 'DELETE FROM repos WHERE id = ?').run(id)
  })()
}

export function getRepoSettings(db: Database.Database, repoId: string): RepoSettings {
  const row = prepared(db, 'SELECT installCmd, startCmd FROM repo_settings WHERE repoId = ?').get(
    repoId,
  ) as RepoSettings | undefined
  return row ?? { installCmd: '', startCmd: '' }
}

export function setRepoSettings(db: Database.Database, repoId: string, s: RepoSettings): void {
  prepared(
    db,
    `
    INSERT INTO repo_settings (repoId, installCmd, startCmd)
    VALUES (?, ?, ?)
    ON CONFLICT(repoId) DO UPDATE SET
      installCmd = excluded.installCmd,
      startCmd   = excluded.startCmd
  `,
  ).run(repoId, s.installCmd, s.startCmd)
}

// ── Prompt templates (FLO-98) ────────────────────────────────────────────────

export function allPromptTemplates(db: Database.Database, repoId: string): PromptTemplateDTO[] {
  return prepared(
    db,
    'SELECT id, repoId, name, body, createdAt, ownerId FROM prompt_templates WHERE repoId = ? ORDER BY createdAt',
  ).all(repoId) as PromptTemplateDTO[]
}

export function getPromptTemplate(
  db: Database.Database,
  id: string,
): PromptTemplateDTO | undefined {
  return prepared(
    db,
    'SELECT id, repoId, name, body, createdAt, ownerId FROM prompt_templates WHERE id = ?',
  ).get(id) as PromptTemplateDTO | undefined
}

export function upsertPromptTemplate(db: Database.Database, t: PromptTemplateDTO): void {
  prepared(
    db,
    `
    INSERT INTO prompt_templates (id, repoId, name, body, createdAt, ownerId)
    VALUES (@id, @repoId, @name, @body, @createdAt, @ownerId)
    ON CONFLICT(id) DO UPDATE SET
      repoId    = excluded.repoId,
      name      = excluded.name,
      body      = excluded.body,
      createdAt = excluded.createdAt,
      ownerId   = excluded.ownerId
  `,
  ).run({ ...t, ownerId: t.ownerId ?? 'local' })
}

export function deletePromptTemplate(db: Database.Database, id: string): void {
  prepared(db, 'DELETE FROM prompt_templates WHERE id = ?').run(id)
}

export interface PushSubscriptionRow {
  endpoint: string
  p256dh: string
  auth: string
  needs: number
  done: number
  running: number
  createdAt: number
}

export function upsertPushSubscription(
  db: Database.Database,
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  prefs: { needs: boolean; done: boolean; running: boolean },
  now: number,
): void {
  prepared(
    db,
    `
    INSERT INTO push_subscriptions (endpoint, p256dh, auth, needs, done, running, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      p256dh   = excluded.p256dh,
      auth     = excluded.auth,
      needs    = excluded.needs,
      done     = excluded.done,
      running  = excluded.running
  `,
  ).run(
    sub.endpoint,
    sub.keys.p256dh,
    sub.keys.auth,
    prefs.needs ? 1 : 0,
    prefs.done ? 1 : 0,
    prefs.running ? 1 : 0,
    now,
  )
}

export function allPushSubscriptions(db: Database.Database): PushSubscriptionRow[] {
  return prepared(db, 'SELECT * FROM push_subscriptions').all() as PushSubscriptionRow[]
}

export function getPushSubscription(
  db: Database.Database,
  endpoint: string,
): PushSubscriptionRow | undefined {
  return prepared(db, 'SELECT * FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as
    PushSubscriptionRow | undefined
}

export function deletePushSubscription(db: Database.Database, endpoint: string): void {
  prepared(db, 'DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint)
}

// ── Native push (FCM) device tokens (TASK-I9S44) ─────────────────────────────

export interface FcmTokenRow {
  token: string
  ownerId: string
  platform: string
  createdAt: number
  /** App origin the client registered this token from (TASK-F0TYG,
   *  migration 7) — null for rows saved before the migration or by a client
   *  that couldn't determine a real http(s) origin. */
  origin: string | null
}

/** Dedupe by token (PRIMARY KEY): re-registering the same physical device
 *  token just refreshes ownerId/platform/createdAt/origin in place. */
export function upsertFcmToken(
  db: Database.Database,
  token: string,
  ownerId: string,
  platform: string,
  now: number,
  origin?: string,
): void {
  prepared(
    db,
    `
    INSERT INTO push_fcm_tokens (token, ownerId, platform, createdAt, origin)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET
      ownerId  = excluded.ownerId,
      platform = excluded.platform,
      origin   = excluded.origin
  `,
  ).run(token, ownerId, platform, now, origin ?? null)
}

export function allFcmTokens(db: Database.Database): FcmTokenRow[] {
  return prepared(db, 'SELECT * FROM push_fcm_tokens').all() as FcmTokenRow[]
}

/** Owner-scoped delete: a cross-owner token id silently deletes nothing
 *  (0 rows affected) rather than throwing — same no-existence-leak posture as
 *  the other fire-and-forget, unguessable-id-addressed ops (see
 *  IDENTITY-SEAM.md). */
export function deleteFcmToken(db: Database.Database, token: string, ownerId: string): void {
  prepared(db, 'DELETE FROM push_fcm_tokens WHERE token = ? AND ownerId = ?').run(token, ownerId)
}

// ── Per-device/per-user auth tokens (FLO-143) ────────────────────────────────
//
// Only tokenHash (SHA-256 of the plaintext credential) is ever persisted —
// see electron/services/deviceTokenStore.ts, the module that owns hashing and
// is the only writer of this table.

export interface DeviceTokenRow {
  id: string
  ownerId: string
  tokenHash: string
  label: string
  createdAt: number
  revokedAt: number | null
}

export function insertDeviceToken(db: Database.Database, row: DeviceTokenRow): void {
  prepared(
    db,
    `
    INSERT INTO device_tokens (id, ownerId, tokenHash, label, createdAt, revokedAt)
    VALUES (@id, @ownerId, @tokenHash, @label, @createdAt, @revokedAt)
  `,
  ).run(row)
}

export function getDeviceTokenByHash(
  db: Database.Database,
  tokenHash: string,
): DeviceTokenRow | undefined {
  return prepared(db, 'SELECT * FROM device_tokens WHERE tokenHash = ?').get(tokenHash) as
    DeviceTokenRow | undefined
}

export function getDeviceToken(db: Database.Database, id: string): DeviceTokenRow | undefined {
  return prepared(db, 'SELECT * FROM device_tokens WHERE id = ?').get(id) as
    DeviceTokenRow | undefined
}

export function allDeviceTokens(db: Database.Database): DeviceTokenRow[] {
  return prepared(db, 'SELECT * FROM device_tokens ORDER BY createdAt').all() as DeviceTokenRow[]
}

/** Revocation is final, not a toggle: only ever sets revokedAt from NULL, and
 *  a missing/already-revoked id is a silent no-op (idempotent). */
export function revokeDeviceToken(db: Database.Database, id: string, revokedAt: number): void {
  prepared(db, 'UPDATE device_tokens SET revokedAt = ? WHERE id = ? AND revokedAt IS NULL').run(
    revokedAt,
    id,
  )
}

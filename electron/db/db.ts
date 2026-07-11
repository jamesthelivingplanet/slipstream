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

// ── Typed DAO helpers ────────────────────────────────────────────────────────

export function upsertRepo(db: Database.Database, repo: RepoDTO): void {
  db.prepare(
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
  return db
    .prepare('SELECT id, org, name, base, path, remoteUrl, ownerId FROM repos')
    .all() as RepoDTO[]
}

export function getRepo(db: Database.Database, id: string): RepoDTO | undefined {
  return db
    .prepare('SELECT id, org, name, base, path, remoteUrl, ownerId FROM repos WHERE id = ?')
    .get(id) as RepoDTO | undefined
}

export function upsertSession(db: Database.Database, session: SessionDTO): void {
  db.prepare(
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
  return db.prepare('SELECT * FROM sessions').all() as SessionDTO[]
}

export function getSession(db: Database.Database, id: string): SessionDTO | undefined {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionDTO | undefined
}

export function deleteSession(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM session_outcomes WHERE sessionId = ?').run(id)
  db.prepare('DELETE FROM session_agent_events WHERE sessionId = ?').run(id)
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
}

export function upsertSessionOutcome(db: Database.Database, o: SessionOutcomeDTO): void {
  db.prepare(
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
  const row = db
    .prepare(
      'SELECT sessionId, result, summary, details, reportedAt FROM session_outcomes WHERE sessionId = ?',
    )
    .get(sessionId) as (SessionOutcomeDTO & { details: string | null }) | undefined
  if (!row) return undefined
  return { ...row, details: row.details ?? undefined }
}

export function allSessionOutcomes(db: Database.Database): SessionOutcomeDTO[] {
  const rows = db
    .prepare('SELECT sessionId, result, summary, details, reportedAt FROM session_outcomes')
    .all() as (SessionOutcomeDTO & { details: string | null })[]
  return rows.map((row) => ({ ...row, details: row.details ?? undefined }))
}

export function deleteSessionOutcome(db: Database.Database, sessionId: string): void {
  db.prepare('DELETE FROM session_outcomes WHERE sessionId = ?').run(sessionId)
}

// ── Session agent events (FLO-104) ───────────────────────────────────────────

/** INSERT OR IGNORE on the (sessionId, kind, ts) unique index — the watcher
 *  replays the whole events.ndjson after a daemon restart, so inserts must be
 *  idempotent. */
export function insertSessionAgentEvent(db: Database.Database, e: SessionAgentEventDTO): void {
  db.prepare(
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
  const rows = db
    .prepare(
      'SELECT sessionId, kind, message, path, ts FROM session_agent_events WHERE sessionId = ? ORDER BY ts',
    )
    .all(sessionId) as (SessionAgentEventDTO & { message: string | null; path: string | null })[]
  return rows.map((row) => ({
    ...row,
    message: row.message ?? undefined,
    path: row.path ?? undefined,
  }))
}

export function deleteSessionAgentEvents(db: Database.Database, sessionId: string): void {
  db.prepare('DELETE FROM session_agent_events WHERE sessionId = ?').run(sessionId)
}

export function deleteRepo(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM repo_settings WHERE repoId = ?').run(id)
  db.prepare('DELETE FROM repos WHERE id = ?').run(id)
}

export function getRepoSettings(db: Database.Database, repoId: string): RepoSettings {
  const row = db
    .prepare('SELECT installCmd, startCmd FROM repo_settings WHERE repoId = ?')
    .get(repoId) as RepoSettings | undefined
  return row ?? { installCmd: '', startCmd: '' }
}

export function setRepoSettings(db: Database.Database, repoId: string, s: RepoSettings): void {
  db.prepare(
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
  return db
    .prepare(
      'SELECT id, repoId, name, body, createdAt, ownerId FROM prompt_templates WHERE repoId = ? ORDER BY createdAt',
    )
    .all(repoId) as PromptTemplateDTO[]
}

export function getPromptTemplate(
  db: Database.Database,
  id: string,
): PromptTemplateDTO | undefined {
  return db
    .prepare('SELECT id, repoId, name, body, createdAt, ownerId FROM prompt_templates WHERE id = ?')
    .get(id) as PromptTemplateDTO | undefined
}

export function upsertPromptTemplate(db: Database.Database, t: PromptTemplateDTO): void {
  db.prepare(
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
  db.prepare('DELETE FROM prompt_templates WHERE id = ?').run(id)
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
  db.prepare(
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
  return db.prepare('SELECT * FROM push_subscriptions').all() as PushSubscriptionRow[]
}

export function getPushSubscription(
  db: Database.Database,
  endpoint: string,
): PushSubscriptionRow | undefined {
  return db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as
    PushSubscriptionRow | undefined
}

export function deletePushSubscription(db: Database.Database, endpoint: string): void {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint)
}

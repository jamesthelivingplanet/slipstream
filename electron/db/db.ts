import Database from 'better-sqlite3'
import type { RepoDTO, SessionDTO, RepoSettings } from '../shared/contract.js'
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
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
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

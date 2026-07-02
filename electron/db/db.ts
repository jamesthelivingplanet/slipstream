import Database from 'better-sqlite3'
import type { RepoDTO, SessionDTO, RepoSettings } from '../shared/contract.js'

// Inlined (not read from schema.sql) so the bundled main.js has no runtime
// dependency on a sibling file the bundler doesn't copy.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  id        TEXT PRIMARY KEY,
  org       TEXT NOT NULL,
  name      TEXT NOT NULL,
  base      TEXT NOT NULL,
  path      TEXT NOT NULL,
  remoteUrl TEXT,
  ownerId   TEXT DEFAULT 'local'
);

CREATE TABLE IF NOT EXISTS sessions (
  id        TEXT PRIMARY KEY,
  tid       TEXT NOT NULL,
  title     TEXT NOT NULL,
  prompt    TEXT NOT NULL,
  repoId    TEXT NOT NULL,
  branch    TEXT NOT NULL,
  status    TEXT NOT NULL DEFAULT 'idle',
  port      INTEGER,
  systemPrompt TEXT,
  agentKind TEXT NOT NULL DEFAULT 'claude-code',
  opencodeSid TEXT,
  createdAt INTEGER NOT NULL,
  ownerId   TEXT DEFAULT 'local',
  prUrl     TEXT
);

CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS repo_settings (
  repoId     TEXT PRIMARY KEY,
  installCmd TEXT NOT NULL DEFAULT '',
  startCmd   TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  needs      INTEGER NOT NULL DEFAULT 1,
  done       INTEGER NOT NULL DEFAULT 1,
  running    INTEGER NOT NULL DEFAULT 0,
  createdAt  INTEGER NOT NULL
);
`

/** Open (or create) a SQLite database at `file` and apply the schema. */
export function openDb(file: string): Database.Database {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
  if (!cols.some((c) => c.name === 'systemPrompt')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN systemPrompt TEXT`)
  }
  if (!cols.some((c) => c.name === 'agentKind')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN agentKind TEXT NOT NULL DEFAULT 'claude-code'`)
  }
  if (!cols.some((c) => c.name === 'opencodeSid')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN opencodeSid TEXT`)
  }
  if (!cols.some((c) => c.name === 'ownerId')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN ownerId TEXT DEFAULT 'local'`)
  }
  if (!cols.some((c) => c.name === 'prUrl')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN prUrl TEXT`)
  }
  const repoCols = db.prepare(`PRAGMA table_info(repos)`).all() as { name: string }[]
  if (!repoCols.some((c) => c.name === 'remoteUrl')) {
    db.exec(`ALTER TABLE repos ADD COLUMN remoteUrl TEXT`)
  }
  if (!repoCols.some((c) => c.name === 'ownerId')) {
    db.exec(`ALTER TABLE repos ADD COLUMN ownerId TEXT DEFAULT 'local'`)
  }
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
    INSERT INTO sessions (id, tid, title, prompt, repoId, branch, status, port, systemPrompt, agentKind, opencodeSid, createdAt, ownerId, prUrl)
    VALUES (@id, @tid, @title, @prompt, @repoId, @branch, @status, @port, @systemPrompt, @agentKind, @opencodeSid, @createdAt, @ownerId, @prUrl)
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
      prUrl        = excluded.prUrl
  `,
  ).run({
    ...session,
    port: session.port ?? null,
    systemPrompt: session.systemPrompt ?? null,
    agentKind: session.agentKind ?? 'claude-code',
    opencodeSid: session.opencodeSid ?? null,
    ownerId: session.ownerId ?? 'local',
    prUrl: session.prUrl ?? null,
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

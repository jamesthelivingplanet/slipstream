import Database from 'better-sqlite3'
import type { RepoDTO, SessionDTO } from '../shared/contract.js'

// Inlined (not read from schema.sql) so the bundled main.js has no runtime
// dependency on a sibling file the bundler doesn't copy.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  id    TEXT PRIMARY KEY,
  org   TEXT NOT NULL,
  name  TEXT NOT NULL,
  base  TEXT NOT NULL,
  path  TEXT NOT NULL
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
  createdAt INTEGER NOT NULL
);
`

/** Open (or create) a SQLite database at `file` and apply the schema. */
export function openDb(file: string): Database.Database {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  return db
}

// ── Typed DAO helpers ────────────────────────────────────────────────────────

export function upsertRepo(db: Database.Database, repo: RepoDTO): void {
  db.prepare(`
    INSERT INTO repos (id, org, name, base, path)
    VALUES (@id, @org, @name, @base, @path)
    ON CONFLICT(id) DO UPDATE SET
      org  = excluded.org,
      name = excluded.name,
      base = excluded.base,
      path = excluded.path
  `).run(repo)
}

export function allRepos(db: Database.Database): RepoDTO[] {
  return db.prepare('SELECT id, org, name, base, path FROM repos').all() as RepoDTO[]
}

export function getRepo(db: Database.Database, id: string): RepoDTO | undefined {
  return db.prepare('SELECT id, org, name, base, path FROM repos WHERE id = ?').get(id) as RepoDTO | undefined
}

export function upsertSession(db: Database.Database, session: SessionDTO): void {
  db.prepare(`
    INSERT INTO sessions (id, tid, title, prompt, repoId, branch, status, port, createdAt)
    VALUES (@id, @tid, @title, @prompt, @repoId, @branch, @status, @port, @createdAt)
    ON CONFLICT(id) DO UPDATE SET
      tid       = excluded.tid,
      title     = excluded.title,
      prompt    = excluded.prompt,
      repoId    = excluded.repoId,
      branch    = excluded.branch,
      status    = excluded.status,
      port      = excluded.port,
      createdAt = excluded.createdAt
  `).run({ ...session, port: session.port ?? null })
}

export function allSessions(db: Database.Database): SessionDTO[] {
  return db.prepare('SELECT * FROM sessions').all() as SessionDTO[]
}

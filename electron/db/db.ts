import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { RepoDTO, SessionDTO } from '../shared/contract.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Open (or create) a SQLite database at `file` and apply schema.sql. */
export function openDb(file: string): Database.Database {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8')
  db.exec(schema)
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

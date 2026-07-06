// Numbered schema migrations driven by PRAGMA user_version.
//
// MIGRATIONS[i] migrates the DB from user_version i to i+1. Migration 0 is the
// frozen baseline schema and is deliberately idempotent (CREATE TABLE IF NOT
// EXISTS, no ALTERs): a DB created under the old ad-hoc scheme sits at
// user_version 0 but already contains every baseline column, so replaying the
// baseline is a no-op and only the real post-baseline migrations then run.
//
// RULES: never edit an existing migration or the baseline SCHEMA to add a
// column — always append a new migration. Each migration runs exactly once,
// tracked by user_version.

// Minimal DB surface the migration runner needs. better-sqlite3's Database
// satisfies this structurally, and tests can supply a lightweight fake without
// loading the native module.
export interface MigrationDb {
  pragma(source: string, options?: { simple?: boolean }): unknown
  exec(source: string): void
  transaction(fn: () => void): () => void
}

// Inlined (not read from schema.sql) so the bundled main.js has no runtime
// dependency on a sibling file the bundler doesn't copy.
//
// Frozen baseline schema (migration 0). NEVER add columns here; append a
// numbered migration below instead.
export const SCHEMA = `
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

export type Migration = (db: MigrationDb) => void

export const MIGRATIONS: Migration[] = [
  // 1 — baseline schema (idempotent)
  (db) => db.exec(SCHEMA),
  // 2 — FLO-83: persist the ticket source per session so it round-trips on reload
  (db) => db.exec(`ALTER TABLE sessions ADD COLUMN src TEXT`),
  // 3 — FLO-98: per-repo reusable prompt templates
  (db) =>
    db.exec(`CREATE TABLE IF NOT EXISTS prompt_templates (
  id        TEXT PRIMARY KEY,
  repoId    TEXT NOT NULL,
  name      TEXT NOT NULL,
  body      TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  ownerId   TEXT DEFAULT 'local'
)`),
]

/** Apply any migrations newer than the DB's current user_version, atomically. */
export function runMigrations(db: MigrationDb): void {
  const current = db.pragma('user_version', { simple: true }) as number
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      MIGRATIONS[v](db)
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
}

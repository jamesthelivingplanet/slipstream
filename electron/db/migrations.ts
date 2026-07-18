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
  // 4 — FLO-97: structured final session outcomes, reported via the app MCP's
  // report_outcome tool and durable independent of the output ring buffer.
  (db) =>
    db.exec(`
CREATE TABLE session_outcomes (
  sessionId  TEXT PRIMARY KEY,
  result     TEXT NOT NULL,
  summary    TEXT NOT NULL,
  details    TEXT,
  reportedAt INTEGER NOT NULL
)
`),
  // 5 — FLO-104: checkpoint/artifact/approval events reported by the slipstream
  // CLI via events.ndjson. The unique index makes replay idempotent: the
  // watcher re-delivers the whole file after a daemon restart and inserts use
  // INSERT OR IGNORE.
  (db) =>
    db.exec(`
CREATE TABLE session_agent_events (
  sessionId TEXT NOT NULL,
  kind      TEXT NOT NULL,
  message   TEXT,
  path      TEXT,
  ts        INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_session_agent_events_dedupe
  ON session_agent_events (sessionId, kind, ts)
`),
  // 6 — TASK-I9S44: native push (FCM HTTP v1) device tokens. Deduped by
  // token (PRIMARY KEY); owner-scoped like every other per-user table (see
  // IDENTITY-SEAM.md) so the daemon fans out a notification only to the
  // owning session's own devices.
  (db) =>
    db.exec(`
CREATE TABLE push_fcm_tokens (
  token     TEXT PRIMARY KEY,
  ownerId   TEXT NOT NULL DEFAULT 'local',
  platform  TEXT NOT NULL,
  createdAt INTEGER NOT NULL
)
`),
  // 7 — TASK-F0TYG: per-token app origin, so the daemon can build a
  // device-reachable image URL for the native FCM notification's full-color
  // Nulliel picture (Android SDK fetches it from the device, not the
  // daemon — cleartext http(s) isn't reliably fetched, so pushService.ts only
  // uses this when it starts with https://). Nullable: rows saved before this
  // migration, or by a client that couldn't determine a real origin, just
  // fall back to no image.
  (db) => db.exec(`ALTER TABLE push_fcm_tokens ADD COLUMN origin TEXT`),
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

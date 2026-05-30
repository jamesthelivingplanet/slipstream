-- Flotilla Phase 1 schema

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

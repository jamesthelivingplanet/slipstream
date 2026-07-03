import { describe, it, expect } from 'vitest'
import { runMigrations, MIGRATIONS, type MigrationDb } from './migrations.js'

function makeFakeDb(opts: { userVersion?: number; existingSessionCols?: string[] } = {}) {
  let userVersion = opts.userVersion ?? 0
  const sessionCols = new Set(opts.existingSessionCols ?? [])
  const execLog: string[] = []
  const db: MigrationDb = {
    pragma(source, options) {
      const m = source.match(/^\s*user_version\s*=\s*(\d+)\s*$/)
      if (m) {
        userVersion = Number(m[1])
        return undefined
      }
      if (source.trim() === 'user_version') {
        return options?.simple ? userVersion : [{ user_version: userVersion }]
      }
      return undefined
    },
    exec(source) {
      execLog.push(source)
      const alter = source.match(/ALTER TABLE sessions ADD COLUMN (\w+)/)
      if (alter) {
        const col = alter[1]
        if (sessionCols.has(col)) throw new Error(`duplicate column name: ${col}`)
        sessionCols.add(col)
      }
      // CREATE TABLE IF NOT EXISTS (baseline) is a no-op in this fake.
    },
    transaction(fn) {
      return () => fn()
    },
  }
  return {
    db,
    get version() {
      return userVersion
    },
    sessionCols,
    execLog,
  }
}

describe('runMigrations', () => {
  it('runs every migration on a fresh DB and stamps the final user_version', () => {
    const f = makeFakeDb({ userVersion: 0 })
    runMigrations(f.db)
    expect(f.version).toBe(MIGRATIONS.length)
    expect(f.sessionCols.has('src')).toBe(true)
  })

  it('migrates a legacy old-scheme DB (user_version 0, all pre-existing columns) without duplicate-column errors', () => {
    const f = makeFakeDb({
      userVersion: 0,
      existingSessionCols: ['systemPrompt', 'agentKind', 'opencodeSid', 'ownerId', 'prUrl'],
    })
    expect(() => runMigrations(f.db)).not.toThrow()
    expect(f.version).toBe(MIGRATIONS.length)
    expect(f.sessionCols.has('src')).toBe(true)
  })

  it('is a no-op when already at the latest version', () => {
    const f = makeFakeDb({ userVersion: MIGRATIONS.length })
    runMigrations(f.db)
    expect(f.execLog).toHaveLength(0)
    expect(f.version).toBe(MIGRATIONS.length)
  })
})

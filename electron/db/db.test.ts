import { describe, it, expect } from 'vitest'
import type Database from 'better-sqlite3'
import { deleteSession, deleteRepo } from './db.js'

/** Minimal in-memory fake standing in for better-sqlite3 (which is built for
 *  Electron's ABI and can't load under Node vitest — see
 *  docs/NATIVE-MODULES.md). Tracks how many distinct SQL strings get prepared
 *  and lets a transaction be forced to fail partway through, to exercise the
 *  atomicity of deleteSession/deleteRepo. */
function makeDb() {
  const tables = {
    sessions: new Set<string>(),
    session_outcomes: new Set<string>(),
    session_agent_events: new Set<string>(),
    repos: new Set<string>(),
    repo_settings: new Set<string>(),
  }
  const prepareCalls: string[] = []
  let failOn: string | null = null

  const db = {
    prepare(sql: string) {
      prepareCalls.push(sql)
      if (failOn && sql.includes(failOn)) {
        return {
          run: () => {
            throw new Error(`simulated failure: ${failOn}`)
          },
        }
      }
      if (/DELETE FROM session_outcomes/.test(sql)) {
        return { run: (id: string) => tables.session_outcomes.delete(id) }
      }
      if (/DELETE FROM session_agent_events/.test(sql)) {
        return { run: (id: string) => tables.session_agent_events.delete(id) }
      }
      if (/DELETE FROM sessions/.test(sql)) {
        return { run: (id: string) => tables.sessions.delete(id) }
      }
      if (/DELETE FROM repo_settings/.test(sql)) {
        return { run: (id: string) => tables.repo_settings.delete(id) }
      }
      if (/DELETE FROM repos/.test(sql)) {
        return { run: (id: string) => tables.repos.delete(id) }
      }
      throw new Error(`unexpected SQL in fake db: ${sql}`)
    },
    transaction(fn: () => void) {
      return () => {
        // Mimic better-sqlite3: run inside a snapshot, roll back on throw.
        const snapshot = {
          sessions: new Set(tables.sessions),
          session_outcomes: new Set(tables.session_outcomes),
          session_agent_events: new Set(tables.session_agent_events),
          repos: new Set(tables.repos),
          repo_settings: new Set(tables.repo_settings),
        }
        try {
          fn()
        } catch (err) {
          tables.sessions = snapshot.sessions
          tables.session_outcomes = snapshot.session_outcomes
          tables.session_agent_events = snapshot.session_agent_events
          tables.repos = snapshot.repos
          tables.repo_settings = snapshot.repo_settings
          throw err
        }
      }
    },
  }
  return {
    db: db as unknown as Database.Database,
    tables,
    prepareCalls,
    setFailOn: (fragment: string | null) => {
      failOn = fragment
    },
  }
}

describe('deleteSession', () => {
  it('removes the session and its child rows', () => {
    const { db, tables } = makeDb()
    tables.sessions.add('s1')
    tables.session_outcomes.add('s1')
    tables.session_agent_events.add('s1')

    deleteSession(db, 's1')

    expect(tables.sessions.has('s1')).toBe(false)
    expect(tables.session_outcomes.has('s1')).toBe(false)
    expect(tables.session_agent_events.has('s1')).toBe(false)
  })

  it('rolls back all deletes if one statement in the transaction fails', () => {
    const { db, tables, setFailOn } = makeDb()
    tables.sessions.add('s1')
    tables.session_outcomes.add('s1')
    tables.session_agent_events.add('s1')
    setFailOn('DELETE FROM sessions')

    expect(() => deleteSession(db, 's1')).toThrow()

    // Earlier deletes in the same transaction must not have stuck.
    expect(tables.session_outcomes.has('s1')).toBe(true)
    expect(tables.session_agent_events.has('s1')).toBe(true)
    expect(tables.sessions.has('s1')).toBe(true)
  })
})

describe('deleteRepo', () => {
  it('removes the repo and its settings row', () => {
    const { db, tables } = makeDb()
    tables.repos.add('r1')
    tables.repo_settings.add('r1')

    deleteRepo(db, 'r1')

    expect(tables.repos.has('r1')).toBe(false)
    expect(tables.repo_settings.has('r1')).toBe(false)
  })

  it('rolls back if the second delete fails', () => {
    const { db, tables, setFailOn } = makeDb()
    tables.repos.add('r1')
    tables.repo_settings.add('r1')
    setFailOn('DELETE FROM repos')

    expect(() => deleteRepo(db, 'r1')).toThrow()

    expect(tables.repo_settings.has('r1')).toBe(true)
    expect(tables.repos.has('r1')).toBe(true)
  })
})

describe('statement caching', () => {
  it('prepares each distinct SQL string at most once per db instance', () => {
    const { db, tables, prepareCalls } = makeDb()
    tables.sessions.add('a')
    tables.sessions.add('b')
    tables.session_outcomes.add('a')
    tables.session_outcomes.add('b')
    tables.session_agent_events.add('a')
    tables.session_agent_events.add('b')

    deleteSession(db, 'a')
    deleteSession(db, 'b')

    // 3 distinct DELETE statements used by deleteSession, each prepared once
    // despite deleteSession being called twice.
    expect(prepareCalls.length).toBe(3)
  })
})

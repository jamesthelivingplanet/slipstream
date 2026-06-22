import Database from 'better-sqlite3'
import { allSessions, upsertSession, getSession, deleteSession } from '../db/db.js'
import type { ISessionStore } from '../shared/contract.js'

export function createSessionStore(db: Database.Database): ISessionStore {
  return {
    list() { return allSessions(db) },
    get(id) { return getSession(db, id) },
    upsert(s) { upsertSession(db, s) },
    delete(id) { deleteSession(db, id) },
  }
}

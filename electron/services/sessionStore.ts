import Database from 'better-sqlite3'
import { allSessions, upsertSession, getSession, deleteSession } from '../db/db.js'
import type { ISessionStore, SessionDTO } from '../shared/contract.js'

export function createSessionStore(db: Database.Database): ISessionStore {
  return {
    list() {
      return allSessions(db)
    },
    get(id) {
      return getSession(db, id)
    },
    upsert(s) {
      upsertSession(db, s)
    },
    delete(id) {
      deleteSession(db, id)
    },
  }
}

/**
 * On daemon restart, PTY processes are gone but their session rows are still
 * marked 'running' or 'needs' in the DB. Mark them 'interrupted' so the UI
 * can surface them and the user can resume.
 */
export function restoreInterruptedSessions(store: ISessionStore): SessionDTO[] {
  const interrupted: SessionDTO[] = []
  for (const session of store.list()) {
    if (session.status === 'running' || session.status === 'needs') {
      const updated: SessionDTO = { ...session, status: 'interrupted' }
      store.upsert(updated)
      interrupted.push(updated)
    }
  }
  return interrupted
}

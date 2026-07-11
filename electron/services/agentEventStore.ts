import Database from 'better-sqlite3'
import {
  insertSessionAgentEvent,
  listSessionAgentEvents,
  deleteSessionAgentEvents,
} from '../db/db.js'
import type { IAgentEventStore } from '../shared/contract.js'

export function createAgentEventStore(db: Database.Database): IAgentEventStore {
  return {
    insert(e) {
      insertSessionAgentEvent(db, e)
    },
    list(sessionId) {
      return listSessionAgentEvents(db, sessionId)
    },
    delete(sessionId) {
      deleteSessionAgentEvents(db, sessionId)
    },
  }
}

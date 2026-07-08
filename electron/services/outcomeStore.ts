import Database from 'better-sqlite3'
import {
  allSessionOutcomes,
  upsertSessionOutcome,
  getSessionOutcome,
  deleteSessionOutcome,
} from '../db/db.js'
import type { IOutcomeStore } from '../shared/contract.js'

export function createOutcomeStore(db: Database.Database): IOutcomeStore {
  return {
    get(sessionId) {
      return getSessionOutcome(db, sessionId)
    },
    upsert(o) {
      upsertSessionOutcome(db, o)
    },
    list() {
      return allSessionOutcomes(db)
    },
    delete(sessionId) {
      deleteSessionOutcome(db, sessionId)
    },
  }
}

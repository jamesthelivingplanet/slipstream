import Database from 'better-sqlite3'
import {
  allPromptTemplates,
  getPromptTemplate,
  upsertPromptTemplate,
  deletePromptTemplate,
} from '../db/db.js'
import type { IPromptTemplateStore } from '../shared/contract.js'

/** DB-backed store for per-repo reusable prompt templates (FLO-98). */
export function createPromptTemplateStore(db: Database.Database): IPromptTemplateStore {
  return {
    list(repoId) {
      return allPromptTemplates(db, repoId)
    },
    get(id) {
      return getPromptTemplate(db, id)
    },
    upsert(t) {
      upsertPromptTemplate(db, t)
    },
    delete(id) {
      deletePromptTemplate(db, id)
    },
  }
}

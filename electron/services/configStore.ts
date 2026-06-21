import Database from 'better-sqlite3'

export interface IConfigStore {
  get(key: string): string | undefined
  set(key: string, value: string): void
}

export function createConfigStore(db: Database.Database): IConfigStore {
  const getStmt = db.prepare<[string], { value: string }>('SELECT value FROM config WHERE key = ?')
  const setStmt = db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  return {
    get(key: string): string | undefined {
      return getStmt.get(key)?.value
    },
    set(key: string, value: string): void {
      setStmt.run(key, value)
    },
  }
}

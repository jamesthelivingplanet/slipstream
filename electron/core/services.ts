import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { openDb } from '../db/db.js'
import { createRepoRegistry } from '../services/repoRegistry.js'
import { createWorktreeManager } from '../services/worktreeManager.js'
import { createSessionManager } from '../services/sessionManager.js'
import { createPortBroker } from '../services/portBroker.js'
import { createEmptyProvider } from '../tickets/emptyProvider.js'
import type { IpcDeps } from '../ipc.js'

/**
 * Resolve the data directory without touching the Electron `app` API.
 * Matches app.getPath('userData') for appName 'flotilla'.
 * Override via FLOTILLA_DATA_DIR env var (shared DB between desktop + server).
 */
export function resolveDataDir(): string {
  if (process.env.FLOTILLA_DATA_DIR) return process.env.FLOTILLA_DATA_DIR

  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'flotilla')
    case 'win32':
      return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'flotilla')
    default:
      // Linux / XDG
      return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'flotilla')
  }
}

/** Construct all backend services wired to the given data root. */
export function createServices(root: string): IpcDeps {
  fs.mkdirSync(root, { recursive: true })
  const db = openDb(path.join(root, 'flotilla.db'))
  return {
    repos: createRepoRegistry(db, root),
    worktrees: createWorktreeManager(root),
    sessions: createSessionManager(),
    ports: createPortBroker(),
    tickets: createEmptyProvider(),
  }
}

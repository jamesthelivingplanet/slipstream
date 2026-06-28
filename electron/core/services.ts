import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { openDb } from '../db/db.js'
import { createRepoRegistry } from '../services/repoRegistry.js'
import { createWorktreeManager } from '../services/worktreeManager.js'
import { createSessionManager } from '../services/sessionManager.js'
import { createPortBroker } from '../services/portBroker.js'
import { createConfigStore } from '../services/configStore.js'
import { createLinearProvider } from '../tickets/linearProvider.js'
import { createSessionStore } from '../services/sessionStore.js'
import { createEditorLauncher } from '../services/editorLauncher.js'
import { createAppRunner } from '../services/appRunner.js'
import { createPushService, createDbPushStore } from '../services/pushService.js'
import { createRunLogger } from '../services/runLogger.js'
import type { IpcDeps } from '../ipc.js'

/**
 * Resolve the data directory without touching the Electron `app` API.
 * Matches app.getPath('userData') for appName 'slipstream'.
 * Override via SLIPSTREAM_DATA_DIR env var (shared DB between desktop + server).
 */
export function resolveDataDir(): string {
  if (process.env.SLIPSTREAM_DATA_DIR) return process.env.SLIPSTREAM_DATA_DIR

  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'slipstream')
    case 'win32':
      return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'slipstream')
    default:
      // Linux / XDG
      return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'slipstream')
  }
}

/** Construct all backend services wired to the given data root. */
export function createServices(root: string): IpcDeps {
  fs.mkdirSync(root, { recursive: true })
  const db = openDb(path.join(root, 'slipstream.db'))
  const configStore = createConfigStore(db)
  const sessionStore = createSessionStore(db)
  const runLogger = createRunLogger(root)
  const sessions = createSessionManager(runLogger)
  const push = createPushService({
    config: configStore,
    store: createDbPushStore(db),
    sessions,
    sessionStore,
  })
  return {
    repos: createRepoRegistry(db, root),
    worktrees: createWorktreeManager(os.homedir()),
    sessions,
    ports: createPortBroker(),
    tickets: createLinearProvider(configStore),
    config: configStore,
    sessionStore,
    editor: createEditorLauncher(),
    appRunner: createAppRunner(),
    push,
    logger: runLogger,
  }
}

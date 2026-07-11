import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { openDb } from '../db/db.js'
import { createRepoRegistry } from '../services/repoRegistry.js'
import { createWorktreeManager } from '../services/worktreeManager.js'
import { createSessionManager } from '../services/sessionManager.js'
import { createPortBroker } from '../services/portBroker.js'
import { createConfigStore, createSafeStorageEncryptor } from '../services/configStore.js'
import { createLinearProvider } from '../tickets/linearProvider.js'
import { createJiraProvider } from '../tickets/jiraProvider.js'
import { createCompositeProvider } from '../tickets/compositeProvider.js'
import { createSessionStore, restoreInterruptedSessions } from '../services/sessionStore.js'
import { createPromptTemplateStore } from '../services/promptTemplates.js'
import { createTicketWriteback } from '../services/ticketWriteback.js'
import { createOutcomeStore } from '../services/outcomeStore.js'
import { createEditorLauncher } from '../services/editorLauncher.js'
import { createAppRunner } from '../services/appRunner.js'
import { createTailscaleExposer } from '../services/tailscale.js'
import { createPushService, createDbPushStore } from '../services/pushService.js'
import { createRunLogger } from '../services/runLogger.js'
import { createWriteCoordinator } from '../services/writeCoordinator.js'
import { createSessionReaper } from '../services/sessionReaper.js'
import { createSessionScheduler } from '../services/sessionScheduler.js'
import { launchSession } from '../services/sessionLauncher.js'
import { createSessionPersistence } from '../services/sessionPersistence.js'
import { createPrStatusService } from '../services/prStatus.js'
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
      return path.join(
        process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
        'slipstream',
      )
    default:
      // Linux / XDG
      return path.join(
        process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
        'slipstream',
      )
  }
}

/** Construct all backend services wired to the given data root. */
export function createServices(root: string): IpcDeps {
  fs.mkdirSync(root, { recursive: true })
  try {
    fs.chmodSync(root, 0o700)
  } catch {
    // best-effort: non-POSIX filesystems / Windows may not support chmod
  }
  const db = openDb(path.join(root, 'slipstream.db'))
  const configStore = createConfigStore(db, { encryptor: createSafeStorageEncryptor() })
  const sessionStore = createSessionStore(db)
  const outcomeStore = createOutcomeStore(db)
  // FLO-46: mark orphaned in-flight sessions as interrupted on boot
  restoreInterruptedSessions(sessionStore)
  const runLogger = createRunLogger(root)
  const sessions = createSessionManager(runLogger, root)
  const linear = createLinearProvider(configStore)
  const jira = createJiraProvider(configStore)
  const tickets = createCompositeProvider([linear, jira])
  // FLO-98: post the PR link back to the ticket on the session's `pr` event.
  // ORDERING: must be registered BEFORE createSessionPersistence — both listen
  // to 'pr', and the write-back's `persisted.prUrl === url` restart-dedupe must
  // read the value from *before* persistence records the new URL (EventEmitter
  // invokes listeners in registration order).
  createTicketWriteback({ sessions, store: sessionStore, tickets, logger: runLogger })
  // FLO-69: persist session status/PR changes at the daemon level (once per
  // process), not per connected client. This is what lets an agent that
  // finishes with no UI attached still write its final state to SQLite.
  // FLO-97: also persists structured session outcomes reported via the app
  // MCP's report_outcome tool.
  createSessionPersistence({ sessions, store: sessionStore, outcomes: outcomeStore })
  const push = createPushService({
    config: configStore,
    store: createDbPushStore(db),
    sessions,
    sessionStore,
  })
  const deps: IpcDeps = {
    // TASK-7EA83: managed clones live under ~/.repositories (beside ~/.worktrees), not the app data dir.
    repos: createRepoRegistry(db, os.homedir()),
    worktrees: createWorktreeManager(os.homedir()),
    sessions,
    ports: createPortBroker(),
    tickets,
    ticketProviders: { linear, jira },
    config: configStore,
    sessionStore,
    promptTemplates: createPromptTemplateStore(db),
    outcomeStore,
    editor: createEditorLauncher(),
    appRunner: createAppRunner(),
    tailscale: createTailscaleExposer(),
    push,
    logger: runLogger,
    writeCoordinator: createWriteCoordinator(),
    prStatus: createPrStatusService({ config: configStore }),
    appMcp: {
      configDir: path.join(root, 'mcp'),
      appMcpJsPath: fileURLToPath(new URL('./app-mcp.js', import.meta.url)),
      electronPath: process.execPath,
      dataDir: root,
    },
  }

  const reaper = createSessionReaper({
    sessions,
    store: sessionStore,
    config: configStore,
    viewers: (id) => deps.writeCoordinator?.viewers(id) ?? 0,
    logger: runLogger,
  })
  reaper.start()

  // FLO-95: caps concurrently live agents, queueing excess startSession calls
  // and draining them as slots free up. The reaper (above) is the other end
  // of this lifecycle — reaping a session is what frees a slot for the next
  // queued start.
  const scheduler = createSessionScheduler({
    sessions,
    store: sessionStore,
    config: configStore,
    launch: (req) => launchSession(deps, req),
    logger: runLogger,
  })
  deps.scheduler = scheduler
  scheduler.start()

  return deps
}

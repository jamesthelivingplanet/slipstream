import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { openDb } from '../db/db.js'
import { createRepoRegistry } from '../services/repoRegistry.js'
import { createWorktreeManager } from '../services/worktreeManager.js'
import { createSessionManager } from '../services/sessionManager.js'
import { createPortBroker } from '../services/portBroker.js'
import {
  createConfigStore,
  createSafeStorageEncryptor,
  createServerEncryptor,
} from '../services/configStore.js'
import { createLinearProvider } from '../tickets/linearProvider.js'
import { createJiraProvider } from '../tickets/jiraProvider.js'
import { createCompositeProvider } from '../tickets/compositeProvider.js'
import { createSessionStore, restoreInterruptedSessions } from '../services/sessionStore.js'
import { createPromptTemplateStore } from '../services/promptTemplates.js'
import { createOutcomeStore } from '../services/outcomeStore.js'
import { createAgentEventStore } from '../services/agentEventStore.js'
import { createClipboardStore } from '../services/clipboardStore.js'
import { provisionCliWrapper, provisionClipboardShims } from '../services/agentCliProvision.js'
import { createEditorLauncher } from '../services/editorLauncher.js'
import { createAppRunner } from '../services/appRunner.js'
import { createTailscaleExposer } from '../services/tailscale.js'
import { createPushService, createDbPushStore, createDbFcmStore } from '../services/pushService.js'
import { createRunLogger } from '../services/runLogger.js'
import { createWriteCoordinator } from '../services/writeCoordinator.js'
import { createSessionReaper } from '../services/sessionReaper.js'
import { createSessionScheduler } from '../services/sessionScheduler.js'
import { launchSession } from '../services/sessionLauncher.js'
import { createPrStatusService } from '../services/prStatus.js'
import { createDeviceTokenStore } from '../services/deviceTokenStore.js'
import { wirePrEventListeners } from './wirePrEventListeners.js'
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
  const configStore = createConfigStore(db, {
    encryptor: createSafeStorageEncryptor() ?? createServerEncryptor({ dataDir: root }),
  })
  const sessionStore = createSessionStore(db)
  const outcomeStore = createOutcomeStore(db)
  const agentEventStore = createAgentEventStore(db)
  // FLO-46: mark orphaned in-flight sessions as interrupted on boot
  restoreInterruptedSessions(sessionStore)
  const runLogger = createRunLogger(root)
  const sessions = createSessionManager(runLogger, root)
  const linear = createLinearProvider(configStore)
  const jira = createJiraProvider(configStore)
  const tickets = createCompositeProvider([linear, jira])
  // FLO-98/FLO-69/FLO-97/FLO-104: wires the ticket write-back and session
  // persistence `pr`-event listeners in the one order that keeps the
  // write-back's restart-dedupe correct — see wirePrEventListeners.ts.
  wirePrEventListeners({
    sessions,
    store: sessionStore,
    tickets,
    outcomes: outcomeStore,
    agentEvents: agentEventStore,
    logger: runLogger,
  })
  const push = createPushService({
    config: configStore,
    store: createDbPushStore(db),
    fcmStore: createDbFcmStore(db),
    sessions,
    sessionStore,
  })
  const deps: IpcDeps = {
    dataDir: root,
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
    agentEventStore,
    clipboardStore: createClipboardStore(root),
    editor: createEditorLauncher(),
    appRunner: createAppRunner(),
    tailscale: createTailscaleExposer(),
    push,
    logger: runLogger,
    writeCoordinator: createWriteCoordinator(),
    prStatus: createPrStatusService({ config: configStore }),
    deviceTokens: createDeviceTokenStore(db),
    agentCli: {
      binDir: path.join(root, 'bin'),
      cliJsPath: fileURLToPath(new URL('./slipstream-cli.js', import.meta.url)),
      electronPath: process.execPath,
      dataDir: root,
    },
  }

  // FLO-104: one static wrapper at <root>/bin/slipstream puts the agent CLI on
  // every session PTY's PATH. Best-effort: a wrapper failure shouldn't stop the
  // daemon (sessions still run, just without the CLI — health check surfaces it).
  // TASK-CWLL6: clipboard-tool PATH shims ride the same binDir.
  try {
    provisionCliWrapper({
      binDir: deps.agentCli!.binDir,
      cliJsPath: deps.agentCli!.cliJsPath,
      electronPath: deps.agentCli!.electronPath,
    })
  } catch {
    // surfaced via getCliStatus
  }
  try {
    provisionClipboardShims(deps.agentCli!.binDir)
  } catch {
    // best-effort: same rationale as the wrapper above
  }
  // One-time cleanup of the retired per-session MCP config dir.
  fs.rmSync(path.join(root, 'mcp'), { recursive: true, force: true })

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

import type {
  IRepoRegistry,
  IWorktreeManager,
  ISessionManager,
  IPortBroker,
  ITicketProvider,
  ISessionStore,
  IAppRunner,
} from './shared/contract.js'
import type { IConfigStore } from './services/configStore.js'
import type { IEditorLauncher } from './services/editorLauncher.js'
import type { IPushService } from './services/pushService.js'
import type { RunLogger } from './services/runLogger.js'

/**
 * IpcDeps — the service bag consumed by createRpc (transport-free) and the
 * WS server. Kept here as the single definition used by server.ts, rpc.ts, and
 * their tests. The registerIpc Electron adapter has been removed; the renderer
 * now reaches all services over the WebSocket (same path as web mode).
 */
export interface IpcDeps {
  repos: IRepoRegistry
  worktrees: IWorktreeManager
  sessions: ISessionManager
  ports: IPortBroker
  tickets: ITicketProvider
  config: IConfigStore
  sessionStore: ISessionStore
  editor: IEditorLauncher
  appRunner: IAppRunner
  push: IPushService
  /** Optional process-level logger for startup/uncaught errors. */
  logger?: RunLogger
}

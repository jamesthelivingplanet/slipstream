import type {
  IRepoRegistry,
  IWorktreeManager,
  ISessionManager,
  IPortBroker,
  ITicketProvider,
  ISessionStore,
  IPromptTemplateStore,
  IOutcomeStore,
  IAppRunner,
  ITailscaleExposer,
  TicketSource,
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
  /** Per-source providers, used only for scope listing (Settings picker);
   *  per-ticket routing goes through `tickets` (the composite). */
  ticketProviders?: Partial<Record<TicketSource, ITicketProvider>>
  config: IConfigStore
  sessionStore: ISessionStore
  /** Per-repo reusable prompt templates (FLO-98). */
  promptTemplates: IPromptTemplateStore
  /** Structured final session outcomes (FLO-97), reported via the app MCP's
   *  report_outcome tool and persisted independent of the output ring buffer. */
  outcomeStore: IOutcomeStore
  editor: IEditorLauncher
  appRunner: IAppRunner
  /** Optional: when present, launched apps are also published on the tailnet. */
  tailscale?: ITailscaleExposer
  push: IPushService
  /** Optional process-level logger for startup/uncaught errors. */
  logger?: RunLogger
  /** Shared per-session write-lock coordinator. Optional: when absent, rpc treats
   *  every client as the writer (single-user / test fallback). */
  writeCoordinator?: import('./services/writeCoordinator.js').IWriteCoordinator
  appMcp?: {
    configDir: string
    appMcpJsPath: string
    electronPath: string
    dataDir: string
  }
  /** Optional: post-handoff PR/MR status (FLO-96). Optional (like `tailscale`)
   *  so tests can omit it; when absent, sessionPrStatus returns null. */
  prStatus?: import('./services/prStatus.js').IPrStatusService
}

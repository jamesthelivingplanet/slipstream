/**
 * Slipstream — shared contract (single source of truth for Phase 1).
 *
 * Every main-process service and the renderer bridge implement the interfaces
 * defined here. Do NOT change this file in a service PR — if a signature needs
 * to change, that is a coordinated decision. Agents implement against it.
 *
 * Filesystem conventions (locked):
 *   repos      → <root>/.repositories/<id>
 *   worktrees  → ~/.worktrees/<org>-<name>/<branch>
 *   branches   → always cut from the repo's base branch (main/master/develop)
 *   <root>     → app data dir (see paths.ts, owned by integration layer)
 */

export type SessionStatus =
  'idle' | 'running' | 'needs' | 'done' | 'errored' | 'interrupted' | 'reaped'
export type TicketSource = 'jira' | 'linear'
export type BackendKind = 'claude-code' | 'opencode' | 'pi'
export type GitHost = 'github' | 'gitlab'

/** Resolved caller identity. Single-user today ({ id: 'local' }); the seam
 *  exists so a future multi-user tier can map tokens → distinct owners. */
export interface Identity {
  id: string
}

export interface NotifyPrefs {
  needs: boolean
  done: boolean
  running: boolean
}

/** Session GC / cost-guard policy (FLO-52). Reaps idle/abandoned/finished PTYs. */
export interface GcPolicy {
  enabled: boolean // master switch
  onlyAbandoned: boolean // only reap sessions with 0 attached clients (viewers)
  autoStopOnDone: boolean // reap a live session whose status is 'done'
  idleMs: number // reap after this much output silence; 0 = disabled
  maxAgeMs: number // reap after this age regardless; 0 = disabled
}
export const DEFAULT_GC_POLICY: GcPolicy = {
  enabled: true,
  onlyAbandoned: true,
  autoStopOnDone: true,
  idleMs: 0,
  maxAgeMs: 0,
}
/** Result of an out-of-band self-test handshake against the app's own MCP
 *  server (electron/mcp/appMcp.ts). Never spawned inside an agent session —
 *  see McpHealthParams / checkAppMcp — so it adds no agent context. */
export interface McpStatusDTO {
  up: boolean // true iff the app's self-test handshake succeeded
  serverName?: string // serverInfo.name from initialize
  protocolVersion?: string // protocolVersion from initialize
  tools: string[] // tool names from tools/list
  checkedAt: number // epoch ms of this self-test
  error?: string // present when up === false
  lastActivityAt?: number // epoch ms of most recent real MCP activity (status.json/pr.json mtime across sessions), if any
}

export interface RepoDiagnostic {
  id: string
  org: string
  name: string
  path: string
  exists: boolean // path exists on disk
  isWorktree: boolean // `git rev-parse --is-inside-work-tree` succeeds at path
  configuredRemote?: string // remoteUrl stored in the DB (RepoDTO.remoteUrl)
  actualRemote?: string // `git remote get-url origin` at path, if resolvable
  remoteMatches: boolean // configured === actual after normalization; true when both absent
}

export interface DiagnosticsDTO {
  daemon: {
    wsUrl: string
    httpBase: string
    port?: number
    pid: number // the daemon process pid (process.pid inside the daemon)
    mode: 'local' | 'remote'
    dataDir: string
    dbPath: string
  }
  versions: {
    node: string
    electron?: string
    v8: string
    chrome?: string
  }
  repos: RepoDiagnostic[]
}

/** Result of a New Agent dialog PATH preflight for an agent's CLI binary. */
export interface AgentCliCheck {
  kind: BackendKind
  bin: string
  found: boolean
  path?: string
}

export interface PushSubscriptionDTO {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export interface RepoDTO {
  id: string // slug, e.g. "acme-api"
  org: string
  name: string
  base: string // base branch: main | master | develop | …
  path: string // absolute path to the repo checkout under .repositories
  remoteUrl?: string // git origin URL — stable identity used to self-heal a moved checkout
  ownerId?: string // owner identity; 'local' for the single-user tier
}

export interface RepoSettings {
  installCmd: string // '' when undefined
  startCmd: string // '' when undefined
}

export interface WorktreeInfo {
  branch: string
  path: string // absolute path under .worktrees
  dirty: boolean // uncommitted changes present
  ahead: number // commits ahead of base
  behind: number
  added: number // diff stat vs base
  deleted: number
}

export interface DiffLineDTO {
  kind: 'context' | 'add' | 'del'
  text: string // content without the leading +/-/space marker
  oldLine: number | null // null for 'add'
  newLine: number | null // null for 'del'
  noNewline?: boolean // "\ No newline at end of file" followed this line
}

export interface DiffHunkDTO {
  header: string // full "@@ -a,b +c,d @@ ctx" line
  oldStart: number
  newStart: number
  lines: DiffLineDTO[]
}

export interface DiffFileDTO {
  path: string // new path (old path when status='deleted')
  oldPath?: string // set when status='renamed'
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
  binary: boolean
  truncated: boolean // hunks dropped past the per-file cap
  additions: number
  deletions: number
  hunks: DiffHunkDTO[]
}

/** Full worktree diff vs the merge-base with the repo's base branch,
 *  including uncommitted and untracked changes (the agent's working state). */
export interface WorktreeDiffDTO {
  branch: string
  base: string // repo.base
  mergeBase: string // sha; '' when it couldn't be computed
  files: DiffFileDTO[]
  truncated: boolean // total size cap hit
  error?: string // human message when the diff failed entirely
}

export interface SessionDTO {
  id: string // uuid
  tid: string // ticket id, e.g. "PROJ-128"
  title: string
  prompt: string
  repoId: string
  branch: string
  status: SessionStatus
  port?: number // assigned by floo on start
  systemPrompt?: string
  agentKind?: BackendKind
  opencodeSid?: string
  createdAt: number
  ownerId?: string // owner identity; 'local' for the single-user tier
  prUrl?: string // MR/PR URL opened for this session's branch
  src?: TicketSource // ticket source this session came from; persisted so it round-trips on reload (FLO-83)
}

export interface WorkflowState {
  id: string
  name: string
  type?: string // linear: backlog|unstarted|started|completed|canceled (jira status categories map onto unstarted|started|completed)
}

/** A selectable ticket scope: a Linear team or a Jira project. */
export interface ScopeOption {
  id: string
  key: string // e.g. Linear team key "FLO", Jira project key "PROJ"
  name: string
}

/** Per-source ticket provider settings (credentials + scoping), struct
 *  get/set like EditorConfig. Credential fields are ''-when-unset; which
 *  ones apply depends on the source (linear: apiKey; jira: baseUrl/email/
 *  apiToken). scopeKeys empty = all teams/projects. */
export interface TicketSourceSettings {
  configured: boolean // read-only: credentials present (ignored on set)
  scopeKeys: string[] // linear team keys / jira project keys; [] = no scope filter
  onlyMine: boolean // restrict to assigned-to-me-or-unassigned
  apiKey: string // linear
  baseUrl: string // jira, e.g. https://yourteam.atlassian.net
  email: string // jira
  apiToken: string // jira
}
export interface TicketDTO {
  id: string
  tid: string
  src: TicketSource
  title: string
  description?: string
  done: boolean // ticket's workflow state is completed
  repoHint?: string // repo id this ticket likely maps to
  status?: WorkflowState
}

export interface EditorConfig {
  command: string // desktop editor command, e.g. "code" or "zed"
  mobileCommand: string // optional mobile editor command; "" when unset
}

export interface WriteLockState {
  sessionId: string
  canWrite: boolean // does THIS client currently hold the write lock
  viewers: number // number of clients attached to this session
}

/** Live-session snapshot for the GC reaper (electron/services/sessionReaper.ts). */
export interface LiveSessionInfo {
  id: string
  status: SessionStatus
  createdAt: number // ms epoch when the session started
  lastActivityAt: number // ms epoch of last PTY output (spawn time if none yet)
}

/* ───────── main-process service interfaces ───────── */

export interface IRepoRegistry {
  list(): Promise<RepoDTO[]>
  /** Validates absPath is a git work tree with commits; throws on failure. Idempotent.
   *  Stamps the repo with `ownerId` (defaults to 'local' for the single-user tier). */
  register(absPath: string, ownerId?: string): Promise<RepoDTO>
  /** Clone a repo from its git remote URL into the managed location
   *  (`<root>/.repositories/<id>`) and register it. Idempotent: reuses an
   *  existing managed clone with the same remote. Throws a clear error when the
   *  clone fails (bad URL, auth, network). Stamps `ownerId` (defaults 'local'). */
  registerByUrl(remoteUrl: string, ownerId?: string): Promise<RepoDTO>
  get(id: string): Promise<RepoDTO | undefined>
  /** Resolve the repo's current on-disk path, self-healing the DB when the
   *  checkout was moved/renamed. Throws a clear error when no checkout can be found. */
  resolvePath(id: string): Promise<RepoDTO>
  remove(id: string): Promise<void>
  getSettings(id: string): Promise<RepoSettings>
  setSettings(id: string, settings: RepoSettings): Promise<void>
}

export interface IWorktreeManager {
  /** `.worktrees/<org>-<name>/<branch>` (pure, synchronous, unit-tested). */
  pathFor(repo: RepoDTO, branch: string): string
  create(repo: RepoDTO, branch: string): Promise<WorktreeInfo>
  /** Refuses (removed:false, reason) when dirty/unmerged unless opts.force. */
  remove(
    repo: RepoDTO,
    branch: string,
    opts?: { force?: boolean },
  ): Promise<{ removed: boolean; reason?: string }>
  status(repo: RepoDTO, branch: string): Promise<WorktreeInfo>
  /** Structured diff of the worktree vs merge-base(repo.base, HEAD) — includes
   *  uncommitted and untracked changes. Returns an `error` DTO rather than
   *  throwing when the worktree/merge-base is unavailable. */
  diff(repo: RepoDTO, branch: string): Promise<WorktreeDiffDTO>
  list(repo: RepoDTO): Promise<WorktreeInfo[]>
}

export interface SessionEvents {
  data: (sessionId: string, chunk: string, seq: number) => void
  status: (sessionId: string, status: SessionStatus) => void
  exit: (sessionId: string, code: number) => void
  pr: (sessionId: string, prUrl: string) => void
}

export interface StartSessionInput {
  tid: string
  title: string
  src?: TicketSource
  prompt: string
  repo: RepoDTO
  branch: string
  cwd: string // worktree path (created by caller before start)
  env?: Record<string, string>
  systemPrompt?: string
  agentKind?: BackendKind
  opencodePort?: number
  mcpConfigPath?: string
  sessionId?: string
}

export interface ResumeSessionInput {
  session: SessionDTO
  cwd: string
  env?: Record<string, string>
  opencodePort?: number
  mcpConfigPath?: string
}

export interface ISessionStore {
  list(): SessionDTO[]
  get(id: string): SessionDTO | undefined
  upsert(s: SessionDTO): void
  delete(id: string): void
}

/** Owns node-pty processes. Extends Node's EventEmitter (typed via SessionEvents). */
export interface ISessionManager {
  start(input: StartSessionInput): SessionDTO
  resume(input: ResumeSessionInput): SessionDTO
  has(sessionId: string): boolean
  write(sessionId: string, data: string): void
  resize(sessionId: string, cols: number, rows: number): void
  kill(sessionId: string): void
  killAll(): void
  on<E extends keyof SessionEvents>(event: E, listener: SessionEvents[E]): void
  off<E extends keyof SessionEvents>(event: E, listener: SessionEvents[E]): void
  getBuffer(sessionId: string): { data: string; seq: number }
  attachRemoteControl(input: ResumeSessionInput): SessionDTO
  /** Record the opencode server's session id so status polling can begin.
   *  No-op for non-opencode sessions or when no port was assigned. */
  setOpencodeSid(sessionId: string, sid: string): void
  /** Snapshot of every live PTY session, for the GC reaper. */
  liveSessions(): LiveSessionInfo[]
  /** Reap a session for the cost guard: kill the PTY and mark it 'reaped'.
   *  Distinct from kill() so the exit is recorded as a policy reap, not a crash. */
  reap(sessionId: string): void
}

/**
 * Classifies an agent's live state from its PTY output + lifecycle.
 * Designed to be pure/testable: feed chunks, query status. The hard, valuable
 * part of the product — start with coarse heuristics.
 */
export interface IStatusDetector {
  push(chunk: string): void
  markExit(code: number): void
  /** Current best-guess status given everything pushed so far + idle timing. */
  status(): SessionStatus
}

export interface IPortBroker {
  /** Shells out to `floo claim <service>` in cwd; returns the sticky port. */
  claim(cwd: string, service: string): Promise<number>
}

export interface IAppRunner {
  /**
   * Spawn `command` as a detached shell process in `cwd`, tracked under `key`
   * (repo+branch). If a live process for `key` already exists, no new process
   * is spawned and the existing pid is returned with reused=true — repeated
   * "Run" clicks dedup instead of accumulating orphaned dev servers.
   */
  run(
    key: string,
    cwd: string,
    command: string,
    env?: Record<string, string>,
  ): Promise<{ pid: number; reused: boolean }>
  /** Kill the tracked process group for `key`. Returns true if one was running. */
  stop(key: string): Promise<boolean>
  /** Whether a live tracked process exists for `key`. */
  isRunning(key: string): boolean
}

export interface ITailscaleExposer {
  /**
   * Publish `http://127.0.0.1:<port>` on the tailnet via `tailscale serve`,
   * tracked under `key` (repo+branch, same key as IAppRunner). Resolves to the
   * tailnet URL, or null when tailscaled isn't running on this machine (the
   * common desktop/no-tailscale case — not an error). Idempotent per key.
   */
  expose(key: string, port: number): Promise<string | null>
  /** Tear down the serve mount for `key`. Best-effort; no-op if not exposed. */
  unexpose(key: string): Promise<void>
  /** The URL previously returned by expose() for `key`, if still tracked. */
  urlFor(key: string): string | null
}

export interface ITicketProvider {
  readonly id: string
  listTickets(): Promise<TicketDTO[]>
  /** Available scopes (Linear teams / Jira projects) for the settings picker.
   *  Throws with a readable message on bad credentials — doubles as a
   *  connection test. Optional: single-purpose providers may omit it. */
  listScopes?(): Promise<ScopeOption[]>
  /** tid is the human identifier e.g. "FLO-17". `src` routes to the right
   *  sub-provider when multiple sources are active (composite); concrete
   *  providers ignore it. */
  getTicketStatus(
    tid: string,
    src?: TicketSource,
  ): Promise<{ current: WorkflowState | null; available: WorkflowState[] }>
  setTicketStatus(tid: string, stateId: string, src?: TicketSource): Promise<WorkflowState>
  /**
   * Transition the ticket to this provider's "in progress" / started state
   * (e.g. Linear "In Progress"). Best-effort and idempotent: returns the new
   * state, or null when no transition applies (no provider configured, no
   * started state exists, or the ticket is already in a started state).
   * `src` routes to the right sub-provider (composite); concrete providers ignore it.
   */
  startTicket(tid: string, src?: TicketSource): Promise<WorkflowState | null>
  /**
   * Transition the ticket back to this provider's "to do" / unstarted state
   * (e.g. Linear "To Do"). Best-effort and idempotent: returns the new
   * state, or null when no transition applies (ticket is not currently in a
   * started/in-progress state, no provider configured, no unstarted state
   * exists, or the ticket is already unstarted).
   * `src` routes to the right sub-provider (composite); concrete providers ignore it.
   */
  resetTicket(tid: string, src?: TicketSource): Promise<WorkflowState | null>
}

/* ───────── IPC: renderer-facing bridge (window.slipstream) ───────── */

export interface SlipstreamApi {
  listRepos(): Promise<RepoDTO[]>
  registerRepo(absPath: string): Promise<RepoDTO>
  /** Clone a repo from its git remote URL into the managed location and register
   *  it. Rejects with a descriptive Error when the clone fails. */
  registerRepoByUrl(remoteUrl: string): Promise<RepoDTO>
  /** Opens a native folder picker, registers the chosen repo. null if cancelled.
   *  Rejects with a descriptive Error if the folder isn't a valid git repo. */
  pickAndRegisterRepo(): Promise<RepoDTO | null>
  removeRepo(id: string): Promise<void>
  listTickets(): Promise<TicketDTO[]>
  getTicketStatus(
    tid: string,
    src?: TicketSource,
  ): Promise<{ current: WorkflowState | null; available: WorkflowState[] }>
  setTicketStatus(tid: string, stateId: string, src?: TicketSource): Promise<WorkflowState>
  getLinearKey(): Promise<string | null>
  setLinearKey(key: string): Promise<void>
  /** Struct get/set for a ticket source's credentials + scoping, mirroring EditorConfig. */
  getTicketSettings(src: TicketSource): Promise<TicketSourceSettings>
  setTicketSettings(src: TicketSource, cfg: TicketSourceSettings): Promise<void>
  /** Live-fetches Linear teams / Jira projects for the settings scope picker.
   *  Rejects with a readable error on bad credentials — doubles as a connection test. */
  listTicketScopes(src: TicketSource): Promise<ScopeOption[]>
  getEditorConfig(): Promise<EditorConfig>
  setEditorConfig(cfg: EditorConfig): Promise<void>
  /** Launch the configured editor on the session's worktree. mobile=true uses the mobile command when set. Rejects with a descriptive Error on failure. */
  openInEditor(input: { repoId: string; branch: string; mobile?: boolean }): Promise<void>

  /** Creates the worktree, claims a port, spawns claude. Returns the session. */
  startSession(input: {
    tid: string
    title: string
    prompt: string
    repoId: string
    description?: string
    agentKind?: BackendKind
    src?: TicketSource
  }): Promise<SessionDTO>
  writeSession(id: string, data: string): void
  resizeSession(id: string, cols: number, rows: number): void
  killSession(id: string): Promise<void>
  cleanupSession(
    id: string,
    opts?: { force?: boolean },
  ): Promise<{ removed: boolean; reason?: string }>
  listSessions(): Promise<SessionDTO[]>
  resumeSession(id: string): Promise<SessionDTO>
  attachRemoteControl(id: string): Promise<SessionDTO>
  worktreeStatus(repoId: string, branch: string): Promise<WorktreeInfo>
  worktreeDiff(repoId: string, branch: string): Promise<WorktreeDiffDTO>

  /** Returns an unsubscribe fn. */
  onSessionData(cb: (id: string, data: string, seq: number) => void): () => void
  onSessionStatus(cb: (id: string, status: SessionStatus) => void): () => void
  getSessionBuffer(id: string): Promise<{ data: string; seq: number }>
  getRepoSettings(id: string): Promise<RepoSettings>
  setRepoSettings(id: string, settings: RepoSettings): Promise<void>
  runApp(input: { repoId: string; branch: string }): Promise<{
    started: boolean
    reason?: string
    port?: number
    pid?: number
    reused?: boolean
    /** Tailnet URL when the daemon exposed the app via `tailscale serve`. */
    url?: string
  }>
  stopApp(input: { repoId: string; branch: string }): Promise<{ stopped: boolean }>
  appStatus(input: { repoId: string; branch: string }): Promise<{ running: boolean; url?: string }>
  getVapidPublicKey(): Promise<string>
  savePushSubscription(sub: PushSubscriptionDTO, prefs: NotifyPrefs): Promise<void>
  deletePushSubscription(endpoint: string): Promise<void>
  getPushPrefs(endpoint: string): Promise<NotifyPrefs | null>
  getGitToken(host: GitHost): Promise<string | null>
  setGitToken(host: GitHost, token: string): Promise<void>
  onSessionPr(cb: (id: string, prUrl: string) => void): () => void

  /** Register this client as viewing a session. Grants the write lock if free,
   *  otherwise the client is view-only. Returns the current lock state. */
  attachSession(id: string): Promise<WriteLockState>
  /** Stop viewing a session (releases the write lock if held). Fire-and-forget. */
  detachSession(id: string): void
  /** Claim the write lock for a session, demoting the current holder to view-only. */
  takeWrite(id: string): Promise<WriteLockState>
  /** Subscribe to write-lock state changes for sessions this client is viewing. Returns unsubscribe fn. */
  onSessionWriteLock(cb: (state: WriteLockState) => void): () => void

  getGcPolicy(): Promise<GcPolicy>
  setGcPolicy(policy: GcPolicy): Promise<void>

  /** Out-of-band self-test of the app's own MCP server: spawns it directly
   *  and runs the initialize/tools-list handshake outside of any agent
   *  session, so it never adds anything to an agent's context. */
  getMcpStatus(): Promise<McpStatusDTO>

  /** Everything a Settings → Diagnostics tab needs: daemon identity, runtime
   *  versions, and per-repo path/remote health. Extends (does not duplicate)
   *  getMcpStatus — call that separately for the MCP self-test section. */
  getDiagnostics(): Promise<DiagnosticsDTO>

  /** Preflight check for the New Agent dialog: is `kind`'s CLI binary on PATH
   *  on the daemon/server machine? Lets the UI warn before Start rather than
   *  failing only at spawn time with a red bubble. */
  checkAgentCli(kind: BackendKind): Promise<AgentCliCheck>
}

export const IPC = {
  listRepos: 'repos:list',
  registerRepo: 'repos:register',
  registerRepoByUrl: 'repos:registerUrl',
  pickRepo: 'repos:pick',
  removeRepo: 'repos:remove',
  listTickets: 'tickets:list',
  getTicketStatus: 'tickets:status',
  setTicketStatus: 'tickets:setStatus',
  getTicketSettings: 'tickets:getSettings',
  setTicketSettings: 'tickets:setSettings',
  listTicketScopes: 'tickets:listScopes',
  startSession: 'session:start',
  writeSession: 'session:write',
  resizeSession: 'session:resize',
  killSession: 'session:kill',
  cleanupSession: 'session:cleanup',
  listSessions: 'session:list',
  resumeSession: 'session:resume',
  attachRemoteControl: 'session:attachRemoteControl',
  sessionData: 'session:data', // main → renderer
  sessionStatus: 'session:status', // main → renderer
  getSessionBuffer: 'session:buffer',
  worktreeStatus: 'worktree:status',
  worktreeDiff: 'worktree:diff',
  getLinearKey: 'config:getLinearKey',
  setLinearKey: 'config:setLinearKey',
  getEditorConfig: 'config:getEditorConfig',
  setEditorConfig: 'config:setEditorConfig',
  openInEditor: 'editor:open',
  getRepoSettings: 'repos:getSettings',
  setRepoSettings: 'repos:setSettings',
  runApp: 'app:run',
  stopApp: 'app:stop',
  appStatus: 'app:status',
  getVapidPublicKey: 'push:vapidKey',
  savePushSubscription: 'push:save',
  deletePushSubscription: 'push:delete',
  getPushPrefs: 'push:prefs',
  getGitToken: 'config:getGitToken',
  setGitToken: 'config:setGitToken',
  sessionPr: 'session:pr', // main → renderer push
  attachSession: 'session:attach',
  detachSession: 'session:detach',
  takeWrite: 'session:takeWrite',
  sessionWriteLock: 'session:writeLock', // main → renderer push
  getGcPolicy: 'gc:getPolicy',
  setGcPolicy: 'gc:setPolicy',
  getMcpStatus: 'mcp:status',
  getDiagnostics: 'diag:get',
  checkAgentCli: 'agent:checkCli',
} as const

declare global {
  interface Window {
    slipstream: SlipstreamApi
    __slipstreamWeb?: boolean
    __slipstreamDaemon?: { url: string; token: string; reused?: boolean } | null
    __slipstreamNative?: { pickFolder(): Promise<string | null> }
  }
}

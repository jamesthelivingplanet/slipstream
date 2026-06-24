/**
 * Slipstream — shared contract (single source of truth for Phase 1).
 *
 * Every main-process service and the renderer bridge implement the interfaces
 * defined here. Do NOT change this file in a service PR — if a signature needs
 * to change, that is a coordinated decision. Agents implement against it.
 *
 * Filesystem conventions (locked):
 *   repos      → <root>/.repositories/<id>
 *   worktrees  → <root>/.worktrees/<org>-<name>/<branch>
 *   branches   → always cut from the repo's base branch (main/master/develop)
 *   <root>     → app data dir (see paths.ts, owned by integration layer)
 */

export type SessionStatus = 'idle' | 'running' | 'needs' | 'done' | 'errored'
export type TicketSource = 'jira' | 'linear'

export interface RepoDTO {
  id: string          // slug, e.g. "acme-api"
  org: string
  name: string
  base: string        // base branch: main | master | develop | …
  path: string        // absolute path to the repo checkout under .repositories
}

export interface RepoSettings {
  installCmd: string   // '' when undefined
  startCmd: string     // '' when undefined
}

export interface WorktreeInfo {
  branch: string
  path: string        // absolute path under .worktrees
  dirty: boolean      // uncommitted changes present
  ahead: number       // commits ahead of base
  behind: number
  added: number       // diff stat vs base
  deleted: number
}

export interface SessionDTO {
  id: string          // uuid
  tid: string         // ticket id, e.g. "PROJ-128"
  title: string
  prompt: string
  repoId: string
  branch: string
  status: SessionStatus
  port?: number       // assigned by floo on start
  systemPrompt?: string
  createdAt: number
}

export interface WorkflowState {
  id: string
  name: string
  type?: string   // linear: backlog|unstarted|started|completed|canceled
}
export interface TicketDTO {
  id: string
  tid: string
  src: TicketSource
  title: string
  description?: string
  done: boolean       // ticket's workflow state is completed
  repoHint?: string   // repo id this ticket likely maps to
  status?: WorkflowState
}

export interface EditorConfig {
  command: string        // desktop editor command, e.g. "code" or "zed"
  mobileCommand: string  // optional mobile editor command; "" when unset
}

/* ───────── main-process service interfaces ───────── */

export interface IRepoRegistry {
  list(): Promise<RepoDTO[]>
  /** Validates absPath is a git work tree with commits; throws on failure. Idempotent. */
  register(absPath: string): Promise<RepoDTO>
  get(id: string): Promise<RepoDTO | undefined>
  remove(id: string): Promise<void>
  getSettings(id: string): Promise<RepoSettings>
  setSettings(id: string, settings: RepoSettings): Promise<void>
}

export interface IWorktreeManager {
  /** `.worktrees/<org>-<name>/<branch>` (pure, synchronous, unit-tested). */
  pathFor(repo: RepoDTO, branch: string): string
  create(repo: RepoDTO, branch: string): Promise<WorktreeInfo>
  /** Refuses (removed:false, reason) when dirty/unmerged unless opts.force. */
  remove(repo: RepoDTO, branch: string, opts?: { force?: boolean }): Promise<{ removed: boolean; reason?: string }>
  status(repo: RepoDTO, branch: string): Promise<WorktreeInfo>
  list(repo: RepoDTO): Promise<WorktreeInfo[]>
}

export interface SessionEvents {
  data: (sessionId: string, chunk: string, seq: number) => void
  status: (sessionId: string, status: SessionStatus) => void
  exit: (sessionId: string, code: number) => void
}

export interface StartSessionInput {
  tid: string
  title: string
  prompt: string
  repo: RepoDTO
  branch: string
  cwd: string         // worktree path (created by caller before start)
  env?: Record<string, string>
  systemPrompt?: string
}

export interface ResumeSessionInput {
  session: SessionDTO
  cwd: string
  env?: Record<string, string>
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
  /** Spawn `command` as a detached shell process in `cwd` with `env` merged over process.env. Returns the spawned pid. */
  run(cwd: string, command: string, env?: Record<string, string>): Promise<{ pid: number }>
}

export interface ITicketProvider {
  readonly id: string
  listTickets(): Promise<TicketDTO[]>
  /** tid is the human identifier e.g. "FLO-17". */
  getTicketStatus(tid: string): Promise<{ current: WorkflowState | null; available: WorkflowState[] }>
  setTicketStatus(tid: string, stateId: string): Promise<WorkflowState>
  /**
   * Transition the ticket to this provider's "in progress" / started state
   * (e.g. Linear "In Progress"). Best-effort and idempotent: returns the new
   * state, or null when no transition applies (no provider configured, no
   * started state exists, or the ticket is already in a started state).
   */
  startTicket(tid: string): Promise<WorkflowState | null>
}

/* ───────── IPC: renderer-facing bridge (window.slipstream) ───────── */

export interface SlipstreamApi {
  listRepos(): Promise<RepoDTO[]>
  registerRepo(absPath: string): Promise<RepoDTO>
  /** Opens a native folder picker, registers the chosen repo. null if cancelled.
   *  Rejects with a descriptive Error if the folder isn't a valid git repo. */
  pickAndRegisterRepo(): Promise<RepoDTO | null>
  removeRepo(id: string): Promise<void>
  listTickets(): Promise<TicketDTO[]>
  getTicketStatus(tid: string): Promise<{ current: WorkflowState | null; available: WorkflowState[] }>
  setTicketStatus(tid: string, stateId: string): Promise<WorkflowState>
  getLinearKey(): Promise<string | null>
  setLinearKey(key: string): Promise<void>
  getEditorConfig(): Promise<EditorConfig>
  setEditorConfig(cfg: EditorConfig): Promise<void>
  /** Launch the configured editor on the session's worktree. mobile=true uses the mobile command when set. Rejects with a descriptive Error on failure. */
  openInEditor(input: { repoId: string; branch: string; mobile?: boolean }): Promise<void>

  /** Creates the worktree, claims a port, spawns claude. Returns the session. */
  startSession(input: { tid: string; title: string; prompt: string; repoId: string; description?: string }): Promise<SessionDTO>
  writeSession(id: string, data: string): void
  resizeSession(id: string, cols: number, rows: number): void
  killSession(id: string): Promise<void>
  cleanupSession(id: string, opts?: { force?: boolean }): Promise<{ removed: boolean; reason?: string }>
  listSessions(): Promise<SessionDTO[]>
  resumeSession(id: string): Promise<SessionDTO>
  attachRemoteControl(id: string): Promise<SessionDTO>
  worktreeStatus(repoId: string, branch: string): Promise<WorktreeInfo>

  /** Returns an unsubscribe fn. */
  onSessionData(cb: (id: string, data: string, seq: number) => void): () => void
  onSessionStatus(cb: (id: string, status: SessionStatus) => void): () => void
  getSessionBuffer(id: string): Promise<{ data: string; seq: number }>
  getRepoSettings(id: string): Promise<RepoSettings>
  setRepoSettings(id: string, settings: RepoSettings): Promise<void>
  runApp(input: { repoId: string; branch: string }): Promise<{ started: boolean; reason?: string; port?: number }>
}

export const IPC = {
  listRepos: 'repos:list',
  registerRepo: 'repos:register',
  pickRepo: 'repos:pick',
  removeRepo: 'repos:remove',
  listTickets: 'tickets:list',
  getTicketStatus: 'tickets:status',
  setTicketStatus: 'tickets:setStatus',
  startSession: 'session:start',
  writeSession: 'session:write',
  resizeSession: 'session:resize',
  killSession: 'session:kill',
  cleanupSession: 'session:cleanup',
  listSessions: 'session:list',
  resumeSession: 'session:resume',
  attachRemoteControl: 'session:attachRemoteControl',
  sessionData: 'session:data',     // main → renderer
  sessionStatus: 'session:status', // main → renderer
  getSessionBuffer: 'session:buffer',
  worktreeStatus: 'worktree:status',
  getLinearKey: 'config:getLinearKey',
  setLinearKey: 'config:setLinearKey',
  getEditorConfig: 'config:getEditorConfig',
  setEditorConfig: 'config:setEditorConfig',
  openInEditor: 'editor:open',
  getRepoSettings: 'repos:getSettings',
  setRepoSettings: 'repos:setSettings',
  runApp: 'app:run',
} as const

declare global {
  interface Window {
    slipstream: SlipstreamApi
  }
}

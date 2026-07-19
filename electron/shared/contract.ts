/**
 * Slipstream — shared contract (single source of truth for Phase 1).
 *
 * Every main-process service and the renderer bridge implement the interfaces
 * defined here. Do NOT change this file in a service PR — if a signature needs
 * to change, that is a coordinated decision. Agents implement against it.
 *
 * Filesystem conventions (locked):
 *   repos      → ~/.repositories/<id>
 *   worktrees  → ~/.worktrees/<org>-<name>/<branch>
 *   branches   → always cut from the repo's base branch (main/master/develop)
 */

export type SessionStatus =
  'idle' | 'running' | 'needs' | 'done' | 'errored' | 'interrupted' | 'reaped' | 'queued'
export type TicketSource = 'jira' | 'linear'
export type BackendKind = 'claude-code' | 'opencode' | 'pi' | 'antigravity' | 'grok' | 'kilo'
/** Runtime-enumerable list mirroring BackendKind — reused for validation
 *  (e.g. rpc.ts's handoffSession) instead of a hardcoded string check. */
export const BACKEND_KINDS: readonly BackendKind[] = [
  'claude-code',
  'opencode',
  'pi',
  'antigravity',
  'grok',
  'kilo',
]
export type GitHost = 'github' | 'gitlab' | 'bitbucket' | 'gitea'

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
/** Session-start scheduler policy (FLO-95). Caps concurrently live agents;
 *  excess startSession calls queue and drain as slots free up (the GC policy
 *  is the other end of this lifecycle: reaping frees a slot). */
export interface SchedulerPolicy {
  maxConcurrent: number // 0 = unlimited: every start fires immediately (pre-FLO-95 behavior)
}
export const DEFAULT_SCHEDULER_POLICY: SchedulerPolicy = { maxConcurrent: 0 }
/** Result of an out-of-band self-test of the agent-facing `slipstream` CLI
 *  (electron/cli/slipstream.ts). Never run inside an agent session — see
 *  CliHealthParams / checkSlipstreamCli — so it adds no agent context. */
export interface CliStatusDTO {
  up: boolean // true iff the self-test (`slipstream help`) exited 0 with usage text
  commands: string[] // command names parsed from the usage output
  checkedAt: number // epoch ms of this self-test
  error?: string // present when up === false
  lastActivityAt?: number // epoch ms of most recent real CLI activity (sentinel mtimes across sessions), if any
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

/** A registered native FCM device token (TASK-I9S44) — the Capacitor mobile
 *  shell's counterpart to PushSubscriptionDTO's Web Push subscription. Inert
 *  until a Firebase service-account credential is configured server-side
 *  (see docs/SECURITY.md §6); saving a token before then just persists it. */
export interface FcmTokenDTO {
  token: string
  platform: 'android' | 'ios'
  /** The app origin (location.origin) the client loaded from when it
   *  registered this token (TASK-F0TYG) — lets the daemon build a
   *  device-reachable image URL (e.g. `${origin}/icons/nulliel-512.png`) for
   *  the native notification without a config key. Per-token/per-device,
   *  since the same identity can reach the daemon from different origins
   *  (tailnet host, LAN IP, …). Omitted (not just falsy) when the client
   *  can't determine a real http(s) origin. */
  origin?: string
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

export type WorktreeUpdateMode = 'rebase' | 'merge'

/**
 * Result of IWorktreeManager.updateFromBase. Action-style result object
 * (like remove()) — expected failures are data, not thrown errors.
 */
export interface WorktreeUpdateResultDTO {
  updated: boolean
  mode: WorktreeUpdateMode
  /** The rebase/merge hit conflicts; it was aborted and the worktree restored. */
  conflicted?: boolean
  /** Human-readable reason when updated === false. */
  reason?: string
  /** Uncommitted changes could not be re-applied after the operation (or its
   *  abort) and were left in `git stash` by --autostash. */
  stashSaved?: boolean
  /** Fresh worktree status after the attempt, when determinable. */
  info?: WorktreeInfo
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

export interface PromptTemplateDTO {
  id: string // uuid
  repoId: string
  name: string
  body: string // the reusable prompt text
  createdAt: number
  ownerId?: string // owner identity; 'local' for the single-user tier
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

/** Per-turn token usage parsed from a Claude Code transcript JSONL. The four
 *  fields mirror the Anthropic usage object's token counts (cache creation +
 *  cache read counted separately so cache savings are visible). */
export interface UsageTokens {
  input: number
  output: number
  cacheCreation: number
  cacheRead: number
}

/** Aggregate usage for a single session, derived from its transcript JSONL
 *  (FLO-94). `costUsd` is an ESTIMATE computed from a model-family pricing
 *  table (see electron/services/usage.ts) — the token counts are the
 *  authoritative metric; dollars are a convenient, approximate rollup. */
export interface SessionUsage {
  sessionId: string
  exists: boolean // false when no transcript file is present yet (session may be pre-first-turn)
  tokens: UsageTokens
  costUsd: number // estimate; 0 until the first assistant turn lands
  turns: number // number of assistant turns counted
  model?: string // last-seen model alias, e.g. "claude-sonnet-5"
}

export type OutcomeResult = 'success' | 'partial' | 'failure'

/** Structured final summary for a session, reported by the agent via the app
 *  MCP's report_outcome tool (FLO-97). Durable in SQLite — the 256 KB output
 *  ring buffer is NOT the record. */
export interface SessionOutcomeDTO {
  sessionId: string
  result: OutcomeResult
  summary: string // short human-readable statement of what happened
  details?: string // optional longer notes (markdown)
  reportedAt: number // epoch ms
}

/** One row of the session-history view (FLO-97): a persisted session joined
 *  with its structured outcome and transcript usage. */
export interface SessionHistoryEntry {
  session: SessionDTO
  outcome: SessionOutcomeDTO | null
  usage: SessionUsage | null // null when no transcript/turns yet
}

export interface IOutcomeStore {
  get(sessionId: string): SessionOutcomeDTO | undefined
  upsert(o: SessionOutcomeDTO): void
  list(): SessionOutcomeDTO[]
  delete(sessionId: string): void
}

/* ───────── Agent CLI events (FLO-104) ───────── */

/** Why a session is in `needs`, as reported by the slipstream CLI. Carried as
 *  metadata on the `status` event — deliberately NOT a new SessionStatus
 *  member, so every status consumer (detector, reaper, UI badges) stays
 *  reason-blind. */
export type NeedsReason = 'input' | 'blocked' | 'approval'

/** Extra context on a `status` event sourced from the status.json sentinel. */
export interface StatusMeta {
  reason?: NeedsReason
  message?: string
}

export type AgentEventKind = 'checkpoint' | 'artifact' | 'approval'

/** One structured event appended by the slipstream CLI to the session's
 *  events.ndjson sentinel (FLO-104). Persisted, no dedicated UI panel. */
export interface SessionAgentEventDTO {
  sessionId: string
  kind: AgentEventKind
  message?: string
  /** Absolute path of the published artifact copy (kind 'artifact' only). */
  path?: string
  ts: number // epoch ms, as written by the CLI
}

export interface IAgentEventStore {
  /** Idempotent on (sessionId, kind, ts) — watcher replays after a daemon
   *  restart re-deliver history and must not duplicate rows. */
  insert(e: SessionAgentEventDTO): void
  list(sessionId: string): SessionAgentEventDTO[]
  delete(sessionId: string): void
}

/** Per-session "virtual clipboard" image (TASK-CWLL6): the renderer uploads a
 *  clipboard PNG here before sending Ctrl+V to the PTY, so PATH-shimmed
 *  clipboard tools on the agent side can serve it. Single-slot per session —
 *  each sync overwrites the previous image. */
export interface IClipboardStore {
  /** Persist decoded PNG bytes for a session, overwriting any previous image. */
  save(sessionId: string, data: Buffer): void
  /** Remove the persisted image (session removed/GC'd). No-op if absent. */
  delete(sessionId: string): void
}

/** One bucket of a by-repo / by-day usage summary (FLO-94). */
export interface UsageBucket {
  key: string // repoId (byRepo) or 'YYYY-MM-DD' (byDay)
  tokens: UsageTokens
  costUsd: number
  sessions: number // distinct sessions contributing to this bucket
}

/** Total + by-repo + by-day usage rollup across tracked sessions (FLO-94).
 *  Gives mission control a real cost signal instead of relying on the idle
 *  reaper as a proxy. `sessions` carries per-session detail for row chips. */
export interface UsageSummary {
  total: UsageTokens
  costUsd: number
  byRepo: UsageBucket[] // most expensive first
  byDay: UsageBucket[] // most recent first
  sessions: SessionUsage[] // per-session detail, most expensive first
}

export type PrMergeState = 'open' | 'merged' | 'closed' | 'unknown'
export type PrCiState = 'none' | 'pending' | 'running' | 'passed' | 'failed' | 'unknown'
export type PrReviewState = 'none' | 'approved' | 'changes_requested' | 'unknown'

/** Post-handoff PR/MR state for a session (FLO-96). Lets mission control
 *  answer "is CI green / is it approved / did it merge" independently of
 *  the agent's exit status. `error` carries a human message when the check
 *  couldn't run (no token, network, PR URL unparseable) — the UI shows the
 *  states it has rather than failing. */
export interface PrStatusDTO {
  sessionId: string
  url: string
  host: GitHost
  state: PrMergeState
  ci: PrCiState
  review: PrReviewState
  approvals: number // count of distinct approving reviewers (0 when unknown)
  checkedAt: number // epoch ms of this check
  error?: string
}

/** One entry per supported git host (TASK-7LGAO), driving the Settings →
 *  Integrations git-host cards: which extra fields to show alongside the
 *  token input. */
export interface GitProviderInfoDTO {
  id: GitHost
  displayName: string
  tokenHint: string
  /** Bitbucket Cloud: app passwords authenticate as username + app password. */
  needsUsername: boolean
  /** Self-hosted providers (Gitea/Forgejo): need the instance base URL. */
  needsBaseUrl: boolean
}

/** Per-host config as currently stored (token intentionally never round-trips
 *  in cleartext beyond what getGitHostConfig already exposed via
 *  getGitToken — same secret-at-rest handling, see configStore.ts). */
export interface GitHostConfigDTO {
  token: string | null
  username: string | null
  baseUrl: string | null
}

/* ───────── main-process service interfaces ───────── */

export interface IRepoRegistry {
  list(): Promise<RepoDTO[]>
  /** Validates absPath is a git work tree with commits; throws on failure. Idempotent.
   *  Stamps the repo with `ownerId` (defaults to 'local' for the single-user tier). */
  register(absPath: string, ownerId?: string): Promise<RepoDTO>
  /** Clone a repo from its git remote URL into the managed location
   *  (`~/.repositories/<id>`) and register it. Idempotent: reuses an
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

/** Result of a merged-into-base probe for a session's branch
 *  (IWorktreeManager.isMerged, surfaced via IPC.sessionMerged). */
export interface BranchMergedDTO {
  merged: boolean
  /** What proved it: a merge commit naming the branch, a squash-equivalent
   *  patch on base, or a recorded PR whose branch has no commits left off base. */
  via?: 'merge-commit' | 'squash' | 'pr'
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
  /** Merged-into-base probe (refreshes base from origin first; offline-safe).
   *  `merged` is only true on positive evidence: a merge commit naming the
   *  branch since the fork point, or a squash-equivalent patch on base — a
   *  fresh branch with no commits is NOT merged. `ahead` is the branch's
   *  commit count not on base (-1 when undeterminable) so callers can combine
   *  `ahead === 0` with their own evidence (e.g. a recorded PR). */
  isMerged(
    repo: RepoDTO,
    branch: string,
  ): Promise<{ merged: boolean; via?: 'merge-commit' | 'squash'; ahead: number }>
  status(repo: RepoDTO, branch: string): Promise<WorktreeInfo>
  /**
   * Bring the worktree's branch up to date with repo.base: refresh base from
   * origin (offline-safe), then rebase (default) or merge with --autostash.
   * On conflict the operation is aborted and the worktree restored — it is
   * never left mid-rebase/mid-merge.
   */
  updateFromBase(
    repo: RepoDTO,
    branch: string,
    opts: { mode: WorktreeUpdateMode },
  ): Promise<WorktreeUpdateResultDTO>
  /** Structured diff of the worktree vs merge-base(repo.base, HEAD) — includes
   *  uncommitted and untracked changes. Returns an `error` DTO rather than
   *  throwing when the worktree/merge-base is unavailable. */
  diff(repo: RepoDTO, branch: string): Promise<WorktreeDiffDTO>
  list(repo: RepoDTO): Promise<WorktreeInfo[]>
}

export interface SessionEvents {
  data: (sessionId: string, chunk: string, seq: number) => void
  /** `meta` is present only when the change came from the status.json
   *  sentinel and it carried a reason/message (slipstream CLI, FLO-104). */
  status: (sessionId: string, status: SessionStatus, meta?: StatusMeta) => void
  exit: (sessionId: string, code: number) => void
  pr: (sessionId: string, prUrl: string) => void
  outcome: (sessionId: string, outcome: SessionOutcomeDTO) => void
  /** Structured checkpoint/artifact/approval event from events.ndjson (FLO-104). */
  agentEvent: (sessionId: string, event: SessionAgentEventDTO) => void
  /** User keystrokes were written to the session's PTY (write() is only
   *  reachable via the writeSession RPC, i.e. a human typing in a terminal). */
  input: (sessionId: string) => void
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
  sessionId?: string
}

export interface ResumeSessionInput {
  session: SessionDTO
  cwd: string
  env?: Record<string, string>
  opencodePort?: number
}

/** Input for continuing an existing run with a DIFFERENT agent (FLO-102).
 *  The new backend is spawned in the same worktree under the same session id;
 *  `handoffPrompt` is the user-level takeover prompt composed by rpc.ts
 *  (buildHandoffPrompt) — the original `session.prompt` stays persisted. */
export interface HandoffSessionInput extends ResumeSessionInput {
  agentKind: BackendKind
  handoffPrompt: string
}

export interface ISessionStore {
  list(): SessionDTO[]
  get(id: string): SessionDTO | undefined
  upsert(s: SessionDTO): void
  delete(id: string): void
}

/** Per-repo reusable prompt templates (FLO-98). Synchronous, DB-backed. */
export interface IPromptTemplateStore {
  list(repoId: string): PromptTemplateDTO[]
  get(id: string): PromptTemplateDTO | undefined
  upsert(t: PromptTemplateDTO): void
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
  getBuffer(sessionId: string): Promise<{ data: string; seq: number }>
  attachRemoteControl(input: ResumeSessionInput): SessionDTO
  /** Continue the session with a different agent (FLO-102): kills the previous
   *  agent's PTY if still live, then spawns `agentKind` in the same worktree
   *  with the takeover prompt. */
  handoff(input: HandoffSessionInput): SessionDTO
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
  listTickets(opts?: {
    page?: number
    pageSize?: number
    query?: string
  }): Promise<PaginatedTickets>
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
  /**
   * Post a comment on the ticket — richer write-back than status transitions
   * (e.g. the PR link once a session opens a merge request). Returns true when
   * a comment was posted, false when this provider is unconfigured or doesn't
   * support comments. Throws on an actual API failure. `src` routes to the
   * right sub-provider (composite); concrete providers ignore it.
   */
  postComment(tid: string, body: string, src?: TicketSource): Promise<boolean>
}

export interface PaginatedTickets {
  tickets: TicketDTO[]
  totalCount: number
  page: number
  pageSize: number
  hasMore: boolean
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
  listTickets(opts?: {
    page?: number
    pageSize?: number
    query?: string
  }): Promise<PaginatedTickets>
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

  /** Creates the worktree, claims a port, spawns claude. Returns the session.
   *  When the scheduler's concurrency cap (SchedulerPolicy.maxConcurrent) is
   *  reached, may instead return a 'queued' session that launches later as
   *  slots free up (FLO-95). */
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
  /** Upload a clipboard image (PNG bytes, base64-encoded) for this session before
   *  sending Ctrl+V (\x16) to the PTY — the daemon persists it so PATH-shimmed
   *  clipboard tools can serve it to the agent process. Rejects for an unknown/
   *  unowned session, invalid base64, or a payload over 10 MiB. */
  syncClipboardImage(id: string, dataBase64: string): Promise<void>
  resizeSession(id: string, cols: number, rows: number): void
  killSession(id: string): Promise<void>
  cleanupSession(
    id: string,
    opts?: { force?: boolean },
  ): Promise<{ removed: boolean; reason?: string }>
  /** Is this session's branch merged into its repo's base? Combines the git
   *  probe (merge commit / squash patch) with the session's recorded PR as
   *  evidence for rebase/fast-forward merges. */
  sessionMerged(id: string): Promise<BranchMergedDTO>
  listSessions(): Promise<SessionDTO[]>
  resumeSession(id: string): Promise<SessionDTO>
  attachRemoteControl(id: string): Promise<SessionDTO>
  /** Continue an existing run with a different agent in the same worktree
   *  (FLO-102) — e.g. when the current agent hit its usage limits. Kills the
   *  old agent process if still live. Rejects for a queued session or when
   *  `agentKind` equals the session's current agent. */
  handoffSession(id: string, agentKind: BackendKind): Promise<SessionDTO>
  worktreeStatus(repoId: string, branch: string): Promise<WorktreeInfo>
  worktreeDiff(repoId: string, branch: string): Promise<WorktreeDiffDTO>
  worktreeUpdateFromBase(
    repoId: string,
    branch: string,
    mode: WorktreeUpdateMode,
  ): Promise<WorktreeUpdateResultDTO>

  /** Returns an unsubscribe fn. */
  onSessionData(cb: (id: string, data: string, seq: number) => void): () => void
  onSessionStatus(cb: (id: string, status: SessionStatus) => void): () => void
  /** Fires when a session's agent process exits on its own (not on kill/reap/
   *  remote-control takeover) — lets the view offer a restart (FLO-101). */
  onSessionExit(cb: (id: string, code: number) => void): () => void
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
  /** Register (or refresh) a native FCM device token for push delivery
   *  (TASK-I9S44) — used when the Capacitor bridge is present. Dedupes by
   *  token; owner-scoped like every other per-caller write. */
  saveFcmToken(token: FcmTokenDTO): Promise<void>
  deleteFcmToken(token: string): Promise<void>
  getGitToken(host: GitHost): Promise<string | null>
  setGitToken(host: GitHost, token: string): Promise<void>
  /** All registered git providers (TASK-7LGAO) — drives the Settings →
   *  Integrations git-host cards, including the Phase-1 Bitbucket/Gitea
   *  stubs (listed, but their action methods reject until Phase 2). */
  listGitProviders(): Promise<GitProviderInfoDTO[]>
  /** Full per-host config (token/username/baseUrl). Superset of getGitToken —
   *  kept alongside it since getGitToken/setGitToken remain the CLI/slipstream
   *  worktree's read path. */
  getGitHostConfig(host: GitHost): Promise<GitHostConfigDTO>
  setGitHostConfig(
    host: GitHost,
    cfg: { token?: string; username?: string; baseUrl?: string },
  ): Promise<void>
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

  getSchedulerPolicy(): Promise<SchedulerPolicy>
  setSchedulerPolicy(policy: SchedulerPolicy): Promise<void>

  /** Out-of-band self-test of the agent-facing `slipstream` CLI: spawns it
   *  directly (`slipstream help`) outside of any agent session, so it never
   *  adds anything to an agent's context. */
  getCliStatus(): Promise<CliStatusDTO>

  /** Everything a Settings → Diagnostics tab needs: daemon identity, runtime
   *  versions, and per-repo path/remote health. Extends (does not duplicate)
   *  getCliStatus — call that separately for the CLI self-test section. */
  getDiagnostics(): Promise<DiagnosticsDTO>

  /** Preflight check for the New Agent dialog: is `kind`'s CLI binary on PATH
   *  on the daemon/server machine? Lets the UI warn before Start rather than
   *  failing only at spawn time with a red bubble. */
  checkAgentCli(kind: BackendKind): Promise<AgentCliCheck>

  /** Aggregate token/cost usage for a session, parsed from its Claude Code
   *  transcript JSONL. `exists` is false until the transcript file appears.
   *  Cost is an estimate (see SessionUsage). */
  getSessionUsage(sessionId: string): Promise<SessionUsage>
  /** Total + by-repo + by-day usage rollup across the caller's tracked
   *  sessions, parsed from their transcripts. The real cost signal for
   *  mission control (FLO-94). */
  getUsageSummary(): Promise<UsageSummary>

  /** Reusable per-repo prompt templates for the New Agent dialog (FLO-98). */
  listPromptTemplates(repoId: string): Promise<PromptTemplateDTO[]>
  savePromptTemplate(input: {
    id?: string
    repoId: string
    name: string
    body: string
  }): Promise<PromptTemplateDTO>
  deletePromptTemplate(id: string): Promise<void>
  /** Structured final summary reported by the agent via the app MCP's
   *  report_outcome tool, or null if none reported yet (FLO-97). */
  getSessionOutcome(sessionId: string): Promise<SessionOutcomeDTO | null>
  /** Owner-scoped history of all persisted sessions joined with outcomes +
   *  usage, most recent first; powers the History view (browse by repo,
   *  compare prompts/outcomes) (FLO-97). */
  listSessionHistory(): Promise<SessionHistoryEntry[]>

  /** Post-handoff PR/MR merge/CI/review state for a session (FLO-96). null
   *  when the session has no prUrl yet. Never rejects for a provider-side
   *  failure — see PrStatusDTO.error. */
  getPrStatus(sessionId: string): Promise<PrStatusDTO | null>

  /** Persisted checkpoint/artifact/approval events reported by the slipstream
   *  CLI for an owned session, oldest first (FLO-104). */
  listSessionAgentEvents(sessionId: string): Promise<SessionAgentEventDTO[]>
  /** Live agent-event push for sessions this client can see. Returns unsubscribe fn. */
  onSessionAgentEvent(cb: (event: SessionAgentEventDTO) => void): () => void

  /** Subscribe to transport connection state (true = connected). Fires on every
   *  transition; used by the UI to resync terminals after a reconnect. */
  onConnectionChange(cb: (connected: boolean) => void): () => void
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
  syncClipboardImage: 'session:clipboard-image',
  resizeSession: 'session:resize',
  killSession: 'session:kill',
  cleanupSession: 'session:cleanup',
  sessionMerged: 'session:merged',
  listSessions: 'session:list',
  resumeSession: 'session:resume',
  attachRemoteControl: 'session:attachRemoteControl',
  handoffSession: 'session:handoff',
  sessionData: 'session:data', // main → renderer
  sessionStatus: 'session:status', // main → renderer
  sessionExit: 'session:exit', // main → renderer push
  getSessionBuffer: 'session:buffer',
  worktreeStatus: 'worktree:status',
  worktreeDiff: 'worktree:diff',
  worktreeUpdateFromBase: 'worktree:updateFromBase',
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
  saveFcmToken: 'push:saveFcmToken',
  deleteFcmToken: 'push:deleteFcmToken',
  getGitToken: 'config:getGitToken',
  setGitToken: 'config:setGitToken',
  listGitProviders: 'config:listGitProviders',
  getGitHostConfig: 'config:getGitHostConfig',
  setGitHostConfig: 'config:setGitHostConfig',
  sessionPr: 'session:pr', // main → renderer push
  attachSession: 'session:attach',
  detachSession: 'session:detach',
  takeWrite: 'session:takeWrite',
  sessionWriteLock: 'session:writeLock', // main → renderer push
  getGcPolicy: 'gc:getPolicy',
  setGcPolicy: 'gc:setPolicy',
  getSchedulerPolicy: 'scheduler:getPolicy',
  setSchedulerPolicy: 'scheduler:setPolicy',
  getCliStatus: 'cli:status',
  getDiagnostics: 'diag:get',
  checkAgentCli: 'agent:checkCli',
  sessionUsage: 'session:usage',
  usageSummary: 'usage:summary',
  listPromptTemplates: 'templates:list',
  savePromptTemplate: 'templates:save',
  deletePromptTemplate: 'templates:delete',
  getSessionOutcome: 'session:outcome',
  listSessionHistory: 'history:list',
  sessionPrStatus: 'session:prStatus',
  listSessionAgentEvents: 'session:agentEvents',
  sessionAgentEvent: 'session:agentEvent', // main → renderer push
} as const

declare global {
  interface Window {
    slipstream: SlipstreamApi
    __slipstreamWeb?: boolean
    __slipstreamDaemon?: { url: string; token: string; reused?: boolean } | null
    __slipstreamNative?: { pickFolder(): Promise<string | null> }
  }
}

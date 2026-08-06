/**
 * agentSpawnService — daemon-side half of the agent-spawn request channel
 * (TASK-CIOEQ). The `slipstream` CLI runs inside an agent's PTY with no
 * daemon auth token, and (once bwrap sandboxing is on, agentSandbox.ts) the
 * only path it can write to at all is its own
 * `<dataDir>/sessions/<id>/` sentinel dir — so a token-free agent that wants
 * the daemon to do something privileged (resolve a repo it doesn't have raw
 * DB/filesystem access to, launch a brand-new sibling agent through the same
 * worktree/port/PTY launch path the UI uses, or list the agents it already
 * spawned) has no RPC to call. Instead it appends a line to that session's
 * requests.ndjson; sessionManager's sentinelWatcher tails the file and emits
 * `agentRequest`; this service is the sole subscriber and answers by
 * appending a line to the same session's responses.ndjson.
 *
 * Shape mirrors sessionPersistence.ts / ticketWriteback.ts: a factory that
 * subscribes to the sessions emitter and returns `{ dispose }`, taking only
 * interface-only deps passed in (no cross-service imports) — wired in
 * core/services.ts alongside the scheduler/reaper. `sessionLauncher.ts` is
 * the one exception: it's a shared procedure (already used by
 * rpcHandlers/sessions.ts and core/services.ts itself), not a peer service,
 * so calling `launchSession`/`scheduler.submit` directly here mirrors exactly
 * how the UI's own startSession RPC launches an agent.
 *
 * Every request kind is owner-scoped (identity seam, IDENTITY-SEAM.md): a
 * `new-agent` repo lookup and an `agents` listing are both restricted to rows
 * owned by the REQUESTING session's owner, never leaked across owners. Never
 * throws back into the emitter — every failure mode (unknown repo, blank
 * title, unknown agent kind, a launch exception) is answered `ok:false` with
 * a readable message instead of crashing the watcher/service.
 *
 * Idempotency across a daemon restart is THIS module's job, not
 * sentinelWatcher's: after a restart, the watcher's ts-cursor resets to 0 and
 * replays every line in every session's requests.ndjson, but spawning a new
 * agent is NOT idempotent — reprocessing an already-answered request would
 * double-spawn. `createAgentSpawnService` seeds a set of already-answered
 * request ids (by reading every known session's responses.ndjson once, up
 * front, before subscribing to the emitter) and `onAgentRequest` skips any
 * request whose id is already in it — a per-request-id check, not a
 * ts-cursor, because a restart replaying a whole file needs an exact "was
 * this one already answered", not "is this newer than the last one I saw".
 *
 * Phase 1 spawn safety: `new-agent` had no limit on recursion depth or
 * fan-out — an agent could spawn agents that spawn agents, unbounded, each
 * one a real live PTY + worktree + port. `readSpawnPolicy`/`writeSpawnPolicy`
 * below mirror sessionScheduler.ts's policy read/coerce/write shape exactly
 * (same config-store-backed, `0 = unlimited` pattern as SchedulerPolicy). The
 * two caps are enforced in `handleNewAgent`, after the repo resolves but
 * before a launch is attempted: `maxDepth` walks the `parentId` chain up from
 * the requesting session (cycle-safe, bounded by `MAX_DEPTH_WALK`, so corrupt
 * data can't hang the daemon); `maxChildrenPerSession` counts existing
 * sessions whose `parentId` is the requesting session. Both reject via the
 * normal `respond(err(...))` path — never throw — same as every other
 * failure mode this service handles.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

import type {
  AgentRequest,
  BackendKind,
  IOutcomeStore,
  IRepoRegistry,
  ISessionManager,
  ISessionStore,
  RepoDTO,
  SessionDTO,
  SpawnPolicy,
} from '../shared/contract.js'
import { BACKEND_KINDS, DEFAULT_SPAWN_POLICY } from '../shared/contract.js'
import { branchFor } from '../shared/branch.js'
import { buildSystemPrompt } from '../shared/promptComposer.js'
import {
  AGENT_RESPONSES_FILE,
  parseAgentResponses,
  type AgentResponse,
} from './agentRequestSentinel.js'
// Type-only import: configStore.ts is a leaf dependency (no state, no
// service-to-service wiring), same as sessionScheduler.ts's own `config:
// IConfigStore` dep — this does not violate the "services never import each
// other" convention, since IConfigStore isn't a peer service.
import type { IConfigStore } from './configStore.js'
import { launchSession, type LaunchDeps, type LaunchRequest } from './sessionLauncher.js'

const SPAWN_POLICY_KEY = 'spawn.policy'

/** Bounds the parentId-chain walk in `depthOf` below. A real spawn tree will
 *  never get remotely this deep (the default maxDepth is 3) — this exists
 *  purely so a corrupted/cyclic parentId chain in the session store can't
 *  hang the daemon in an infinite loop. */
const MAX_DEPTH_WALK = 64

function coerce(partial: unknown): SpawnPolicy {
  const p = (partial ?? {}) as Partial<SpawnPolicy>
  const depthRaw = p.maxDepth
  const childrenRaw = p.maxChildrenPerSession
  const maxDepth =
    typeof depthRaw === 'number' && Number.isFinite(depthRaw)
      ? Math.floor(depthRaw)
      : DEFAULT_SPAWN_POLICY.maxDepth
  const maxChildrenPerSession =
    typeof childrenRaw === 'number' && Number.isFinite(childrenRaw)
      ? Math.floor(childrenRaw)
      : DEFAULT_SPAWN_POLICY.maxChildrenPerSession
  return {
    maxDepth: Math.max(0, maxDepth),
    maxChildrenPerSession: Math.max(0, maxChildrenPerSession),
  }
}

/** Read the spawn policy from the config store, falling back to defaults. */
export function readSpawnPolicy(config: IConfigStore): SpawnPolicy {
  const raw = config.get(SPAWN_POLICY_KEY)
  if (!raw) return { ...DEFAULT_SPAWN_POLICY }
  try {
    return coerce(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_SPAWN_POLICY }
  }
}

/** Normalize and persist a spawn policy. */
export function writeSpawnPolicy(config: IConfigStore, policy: SpawnPolicy): void {
  config.set(SPAWN_POLICY_KEY, JSON.stringify(coerce(policy)))
}

export interface AgentSpawnService {
  /** Remove the daemon-level agentRequest listener. */
  dispose(): void
}

/** Minimal structural slice of ISessionScheduler this service needs — kept
 *  local instead of importing sessionScheduler.ts so this module's only
 *  non-contract dependency is the sessionLauncher.ts procedure it shares with
 *  rpcHandlers/sessions.ts. */
export interface AgentSpawnScheduler {
  submit(req: LaunchRequest): Promise<SessionDTO>
}

export interface AgentSpawnDeps {
  sessions: Pick<ISessionManager, 'on' | 'off'>
  sessionStore: ISessionStore
  repos: Pick<IRepoRegistry, 'list'>
  outcomeStore: Pick<IOutcomeStore, 'get'>
  /** Backs the spawn depth/fan-out caps (see class doc + readSpawnPolicy).
   *  A leaf dependency, not a peer service — see the type-only import above. */
  config: IConfigStore
  /** Full launch procedure deps (repos/worktrees/sessions/ports/store/
   *  tickets/agentCli) — the same bag core/services.ts assembles for
   *  launchSession/the scheduler. Used only when `scheduler` is absent. */
  launchDeps: LaunchDeps
  /** Present in production (core/services.ts wires the real scheduler);
   *  absent in tests that want the immediate-launch branch exercised. */
  scheduler?: AgentSpawnScheduler
  /** The Slipstream data root — responses.ndjson is written under
   *  `<dataDir>/sessions/<parentSessionId>/`, same convention as
   *  sessionManager's sentinel watcher and the CLI's own sentinel writes.
   *  Unused when `writeResponse` is supplied. */
  dataDir: string
  /** Injectable response writer — defaults to appending a JSON line to
   *  `<dataDir>/sessions/<parentSessionId>/responses.ndjson` (real fs, mkdir
   *  -p'd first). Tests inject a fake so responses can be asserted on
   *  without touching the real filesystem. */
  writeResponse?: (parentSessionId: string, response: AgentResponse) => void
  /** Injectable response reader — defaults to reading and parsing the
   *  CURRENT `<dataDir>/sessions/<parentSessionId>/responses.ndjson` (real
   *  fs, best-effort: a missing file reads as no responses). Read once per
   *  known session at startup to seed the idempotency guard (see class doc);
   *  tests inject a fake so restart-replay can be simulated without the
   *  filesystem. */
  readResponses?: (parentSessionId: string) => AgentResponse[]
  now?: () => number
}

/** Real-fs default for `writeResponse`: append-only, mkdir -p'd first, and
 *  swallows write failures (best-effort — see the class doc). */
function defaultWriteResponse(
  dataDir: string,
): (parentSessionId: string, response: AgentResponse) => void {
  return (parentSessionId, response) => {
    const dir = path.join(dataDir, 'sessions', parentSessionId)
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.appendFileSync(path.join(dir, AGENT_RESPONSES_FILE), JSON.stringify(response) + '\n')
    } catch {
      // Best-effort: the session dir may already be gone (cleaned up
      // mid-flight) or the disk is full. The CLI-side caller just never sees
      // an answer for this id and times out — never crash the daemon over it.
    }
  }
}

/** Real-fs default for `readResponses`: best-effort, reads as empty when the
 *  file doesn't exist yet (a session with no requests ever sent) or can't be
 *  parsed. */
function defaultReadResponses(dataDir: string): (parentSessionId: string) => AgentResponse[] {
  return (parentSessionId) => {
    try {
      const raw = fs.readFileSync(
        path.join(dataDir, 'sessions', parentSessionId, AGENT_RESPONSES_FILE),
        'utf8',
      )
      return parseAgentResponses(raw)
    } catch {
      return []
    }
  }
}

/** repos/agents listing item shapes (documented here since they're not
 *  contract DTOs — this channel's response payloads are this phase's own
 *  concern, not the renderer's). */
interface RepoListItem {
  id: string
  org: string
  name: string
  base: string
}

interface AgentListItem {
  sessionId: string
  tid: string
  title: string
  status: SessionDTO['status']
  branch: string
  repo: string
  prUrl?: string
  outcome?: { result: string; summary: string }
}

function isOwnedBy(row: { ownerId?: string }, ownerId: string): boolean {
  return (row.ownerId ?? 'local') === ownerId
}

/** Accept either a bare repo id (slug) or "org/name" — scoped to repos owned
 *  by the requesting session's owner (identity seam: never resolve a repo
 *  belonging to a different owner). */
function resolveOwnedRepo(repos: RepoDTO[], ref: string, ownerId: string): RepoDTO | undefined {
  const owned = repos.filter((r) => isOwnedBy(r, ownerId))
  return owned.find((r) => r.id === ref || `${r.org}/${r.name}` === ref)
}

/** Mirrors the tid a "blank chat" draft session mints client-side
 *  (src/lib/stores.ts) — same `TASK-<5 uppercase base36 chars>` shape, so a
 *  daemon-minted tid is indistinguishable from one the UI would have minted
 *  for the same kind of ad-hoc (non-ticket) session. */
function mintTid(): string {
  return `TASK-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
}

/** Depth of `sessionId` within its spawn tree: a session with no `parentId`
 *  is depth 0, and each spawn adds 1. Cycle-safe — bounded by
 *  `MAX_DEPTH_WALK` so a corrupted/cyclic parentId chain can't hang the
 *  daemon; a walk that hits the bound without reaching a root is treated as
 *  "at least MAX_DEPTH_WALK deep", which is always over any sane policy cap. */
function depthOf(sessionStore: ISessionStore, sessionId: string): number {
  let depth = 0
  let current = sessionStore.get(sessionId)
  while (current?.parentId && depth < MAX_DEPTH_WALK) {
    current = sessionStore.get(current.parentId)
    depth += 1
  }
  return depth
}

export function createAgentSpawnService(deps: AgentSpawnDeps): AgentSpawnService {
  const { sessions, sessionStore, repos, outcomeStore, launchDeps, scheduler, config } = deps
  const now = deps.now ?? Date.now
  const rawWriteResponse = deps.writeResponse ?? defaultWriteResponse(deps.dataDir)
  const readResponses = deps.readResponses ?? defaultReadResponses(deps.dataDir)

  // Idempotency guard (see class doc): seed already-answered request ids from
  // every currently-known session BEFORE the emitter subscription below can
  // deliver a single event. Synchronous and cheap (small per-session files,
  // read once at daemon startup) — a daemon restart replays the whole of
  // every session's requests.ndjson, and this is what stops that replay from
  // re-launching agents that were already spawned last run.
  const answered = new Set<string>()
  for (const session of sessionStore.list()) {
    for (const response of readResponses(session.id)) {
      answered.add(response.id)
    }
  }

  function respond(parentSessionId: string, response: AgentResponse): void {
    answered.add(response.id)
    rawWriteResponse(parentSessionId, response)
  }

  const ok = (id: string, data?: unknown): AgentResponse => ({ id, ok: true, ts: now(), data })
  const err = (id: string, error: string): AgentResponse => ({ id, ok: false, ts: now(), error })

  async function handleRepos(
    parentSessionId: string,
    req: AgentRequest,
    ownerId: string,
  ): Promise<void> {
    const all = await repos.list()
    const data: RepoListItem[] = all
      .filter((r) => isOwnedBy(r, ownerId))
      .map((r) => ({ id: r.id, org: r.org, name: r.name, base: r.base }))
    respond(parentSessionId, ok(req.id, data))
  }

  async function handleAgents(parentSessionId: string, req: AgentRequest): Promise<void> {
    const children = sessionStore.list().filter((s) => s.parentId === parentSessionId)
    const allRepos = await repos.list()
    const repoLabel = (repoId: string): string => {
      const r = allRepos.find((r) => r.id === repoId)
      return r ? `${r.org}/${r.name}` : repoId
    }
    const data: AgentListItem[] = children.map((s) => {
      const outcome = outcomeStore.get(s.id)
      return {
        sessionId: s.id,
        tid: s.tid,
        title: s.title,
        status: s.status,
        branch: s.branch,
        repo: repoLabel(s.repoId),
        prUrl: s.prUrl,
        outcome: outcome ? { result: outcome.result, summary: outcome.summary } : undefined,
      }
    })
    respond(parentSessionId, ok(req.id, data))
  }

  async function handleNewAgent(
    parentSessionId: string,
    req: AgentRequest,
    ownerId: string,
  ): Promise<void> {
    const { id } = req

    const repoRef = req.repo?.trim()
    if (!repoRef) {
      respond(parentSessionId, err(id, 'repo is required'))
      return
    }

    const title = req.title?.trim()
    if (!title) {
      respond(parentSessionId, err(id, 'title is required'))
      return
    }

    const agentRef = req.agent?.trim()
    if (agentRef && !BACKEND_KINDS.includes(agentRef as BackendKind)) {
      respond(parentSessionId, err(id, `Unknown agent kind: ${agentRef}`))
      return
    }

    try {
      const all = await repos.list()
      const repo = resolveOwnedRepo(all, repoRef, ownerId)
      if (!repo) {
        respond(parentSessionId, err(id, `Unknown repo: ${repoRef}`))
        return
      }

      // Spawn safety caps (see class doc): enforced here, after the repo
      // resolves but before a launch is attempted, so a rejected request
      // never claims a worktree/port/PTY.
      const policy = readSpawnPolicy(config)
      const newDepth = depthOf(sessionStore, parentSessionId) + 1
      if (policy.maxDepth > 0 && newDepth > policy.maxDepth) {
        // Report the parent's REAL depth (newDepth - 1), not policy.maxDepth
        // — they only coincide when the parent sits exactly at the cap. If
        // the policy is later lowered below an existing tree's depth, using
        // the cap here would state a false fact about the agent.
        respond(
          parentSessionId,
          err(
            id,
            `Spawn depth limit reached (${policy.maxDepth}): this agent is already ${newDepth - 1} levels deep.`,
          ),
        )
        return
      }
      const childCount = sessionStore.list().filter((s) => s.parentId === parentSessionId).length
      if (policy.maxChildrenPerSession > 0 && childCount >= policy.maxChildrenPerSession) {
        respond(
          parentSessionId,
          err(
            id,
            `Spawn limit reached: this session already spawned ${childCount} agents (max ${policy.maxChildrenPerSession}).`,
          ),
        )
        return
      }

      const tid = mintTid()
      const branch = branchFor(tid, title)
      const systemPrompt = buildSystemPrompt({ tid, title })

      const launchReq: LaunchRequest = {
        sessionId: randomUUID(),
        tid,
        title,
        prompt: req.prompt ?? '',
        repoId: repo.id,
        branch,
        systemPrompt,
        agentKind: agentRef as BackendKind | undefined,
        ownerId,
        parentId: parentSessionId,
      }

      // Same branch/shape as rpcHandlers/sessions.ts's own startSession path.
      const session = scheduler
        ? await scheduler.submit(launchReq)
        : await launchSession(launchDeps, launchReq)

      respond(
        parentSessionId,
        ok(id, {
          sessionId: session.id,
          tid: session.tid,
          title: session.title,
          branch: session.branch,
          repo: `${repo.org}/${repo.name}`,
          status: session.status,
        }),
      )
    } catch (e) {
      respond(parentSessionId, err(id, e instanceof Error ? e.message : String(e)))
    }
  }

  function onAgentRequest(parentSessionId: string, req: AgentRequest): void {
    // Already answered — either earlier this run, or before a daemon restart
    // replayed requests.ndjson from the top. Never reprocess (see class doc):
    // a 'new-agent' request is not idempotent to re-run.
    if (answered.has(req.id)) return
    const parent = sessionStore.get(parentSessionId)
    if (!parent) {
      respond(parentSessionId, err(req.id, 'Requesting session not found'))
      return
    }
    const ownerId = parent.ownerId ?? 'local'

    void (async () => {
      try {
        if (req.kind === 'repos') {
          await handleRepos(parentSessionId, req, ownerId)
        } else if (req.kind === 'agents') {
          await handleAgents(parentSessionId, req)
        } else if (req.kind === 'new-agent') {
          await handleNewAgent(parentSessionId, req, ownerId)
        } else {
          respond(parentSessionId, err(req.id, `Unknown request kind: ${String(req.kind)}`))
        }
      } catch (e) {
        // Last-resort safety net — every handler above already has its own
        // try/catch, but this must never throw back into the emitter.
        respond(parentSessionId, err(req.id, e instanceof Error ? e.message : String(e)))
      }
    })()
  }

  sessions.on('agentRequest', onAgentRequest)

  return {
    dispose(): void {
      sessions.off('agentRequest', onAgentRequest)
    },
  }
}

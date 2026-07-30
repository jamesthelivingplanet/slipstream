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
} from '../shared/contract.js'
import { BACKEND_KINDS } from '../shared/contract.js'
import { branchFor } from '../shared/branch.js'
import { buildSystemPrompt } from '../shared/promptComposer.js'
import {
  AGENT_RESPONSES_FILE,
  parseAgentResponses,
  type AgentResponse,
} from './agentRequestSentinel.js'
import { launchSession, type LaunchDeps, type LaunchRequest } from './sessionLauncher.js'

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

export function createAgentSpawnService(deps: AgentSpawnDeps): AgentSpawnService {
  const { sessions, sessionStore, repos, outcomeStore, launchDeps, scheduler } = deps
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

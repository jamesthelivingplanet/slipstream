import fs from 'node:fs'
import path from 'node:path'
import type { IpcDeps } from '../ipc.js'
import type {
  Identity,
  RepoDTO,
  SessionDTO,
  SessionOutcomeDTO,
  WriteLockState,
} from '../shared/contract.js'
import { isSafeSlug } from '../shared/branch.js'
import { parseOutcomeSentinel, OUTCOME_SENTINEL_FILE } from '../services/outcomeSentinel.js'
import type { IWriteCoordinator } from '../services/writeCoordinator.js'

/**
 * Per-connection shared state/helpers used by every RPC handler domain.
 * Extracted from createRpc's closure (FLO-118) so handler modules can share
 * ownership/lock/outcome logic without importing rpc.ts.
 */
export interface RpcContext {
  identity: Identity
  clientId: string
  coord?: IWriteCoordinator
  ownedByCaller(row: { ownerId?: string }): boolean
  ownedSession(id: string): SessionDTO | undefined
  requireOwnedRepo(repoId: string): Promise<RepoDTO>
  requireSafeBranch(branch: string): string
  lockState(id: string): WriteLockState
  resolveOutcome(sessionId: string): Promise<SessionOutcomeDTO | null>
}

export function createRpcContext(deps: IpcDeps, identity: Identity, clientId: string): RpcContext {
  const coord = deps.writeCoordinator

  function lockState(id: string): WriteLockState {
    if (!coord) return { sessionId: id, canWrite: true, viewers: 1 }
    return { sessionId: id, canWrite: coord.canWrite(id, clientId), viewers: coord.viewers(id) }
  }
  // Owner filter — a no-op in the single-user tier (every row is 'local').
  // The seam scopes all reads so a future multi-user tier isolates owners.
  const ownedByCaller = (row: { ownerId?: string }): boolean =>
    (row.ownerId ?? 'local') === identity.id

  // Treat a persisted session as owned-or-absent: callers may only act on
  // sessions they own. Returns undefined for missing OR other-owner rows so
  // handlers surface an identical "not found" to both — no existence leak.
  function ownedSession(id: string): SessionDTO | undefined {
    const s = deps.sessionStore.get(id)
    return s && ownedByCaller(s) ? s : undefined
  }

  // Resolve a repo the caller owns, or throw the same "Unknown repo" error
  // used for a missing repo (no existence leak across owners).
  async function requireOwnedRepo(repoId: string): Promise<RepoDTO> {
    const repo = await deps.repos.get(repoId)
    if (!repo || !ownedByCaller(repo)) throw new Error(`Unknown repo: ${repoId}`)
    return repo
  }

  // `branch` reaches `join()`-based worktree paths and shell cwds (worktree
  // status/diff/update, openInEditor, runApp) — reject anything that isn't a
  // plain slug so a `..`/absolute-path payload can't escape `.worktrees/`
  // (FLO-129).
  function requireSafeBranch(branch: string): string {
    if (!isSafeSlug(branch)) throw new Error(`Invalid branch: ${branch}`)
    return branch
  }

  // Negative-cache disk-fallback misses for a bounded window. Scoped inside
  // createRpc's closure (per-connection), NOT module scope: module scope
  // would leak across the per-connection createRpc() instances the test
  // suite creates fresh in every beforeEach, and in production it should
  // track state for this daemon connection, not survive the whole process.
  // A History-panel open loops resolveOutcome over every owned session, so
  // without this a session that never got an outcome (still running, or
  // finished with no sentinel file) re-reads disk on every open, forever.
  // The TTL keeps the restart-race fallback self-healing within a bounded
  // window rather than negative-caching a miss forever.
  const OUTCOME_MISS_TTL_MS = 30_000
  const outcomeMissCache = new Map<string, number>() // sessionId -> cache-until epoch ms

  // Resolve a session's structured outcome: prefer the durable store, but
  // fall back to reading the outcome.json sentinel straight off disk. A
  // daemon restart can race the sessionManager's fs.watch — the watcher only
  // starts once a session is live again — so a session that finished and
  // wrote its sentinel while the daemon was down (or between restart and
  // resume) would otherwise appear to have no outcome even though the agent
  // reported one. On a successful disk read, backfill the store so future
  // reads don't need the fallback.
  //
  // The store lookup always runs first, unconditionally — this lets an
  // outcome written out-of-band by the live sentinelWatcher/sessionPersistence
  // listener (while this connection stays open) surface immediately even if
  // an earlier call negative-cached a miss. Only the disk-read fallback is
  // skipped while a miss is cached.
  async function resolveOutcome(sessionId: string): Promise<SessionOutcomeDTO | null> {
    const stored = deps.outcomeStore.get(sessionId)
    if (stored) return stored
    if (!deps.agentCli) return null

    const missUntil = outcomeMissCache.get(sessionId)
    if (missUntil !== undefined && missUntil > Date.now()) return null

    try {
      const filePath = path.join(
        deps.agentCli.dataDir,
        'sessions',
        sessionId,
        OUTCOME_SENTINEL_FILE,
      )
      const content = await fs.promises.readFile(filePath, 'utf8')
      const parsed = parseOutcomeSentinel(content)
      if (!parsed) {
        outcomeMissCache.set(sessionId, Date.now() + OUTCOME_MISS_TTL_MS)
        return null
      }
      const outcome: SessionOutcomeDTO = {
        sessionId,
        result: parsed.result,
        summary: parsed.summary,
        details: parsed.details,
        reportedAt: parsed.ts,
      }
      deps.outcomeStore.upsert(outcome)
      return outcome
    } catch {
      outcomeMissCache.set(sessionId, Date.now() + OUTCOME_MISS_TTL_MS)
      return null
    }
  }

  return {
    identity,
    clientId,
    coord,
    ownedByCaller,
    ownedSession,
    requireOwnedRepo,
    requireSafeBranch,
    lockState,
    resolveOutcome,
  }
}

/**
 * SessionScheduler — FLO-95 session-start concurrency limits + queueing.
 *
 * Mirrors sessionReaper.ts's shape (policy read/write/coerce + a service
 * factory taking interface-only deps, so it's pure/node-runnable and tested
 * with fakes). The reaper and the scheduler are the two ends of the same
 * lifecycle: the reaper frees a slot by killing an idle/abandoned/finished
 * PTY, the scheduler notices the freed slot and launches the next queued
 * start.
 *
 * IMPORTANT — status-pipeline gotcha (see CLAUDE.md "Session status flaps by
 * design"): the `status` event fires on every PTY chunk, not on change, and
 * an idle TUI's heuristic ping-pongs 'needs'↔'running' every few seconds. The
 * scheduler must NOT treat every status event as a slot-freeing trigger, or
 * drain() would be invoked continuously. Only 'reaped' (from the GC reaper)
 * and the `exit` event are terminal, one-shot signals that a slot actually
 * freed up, so those are the only two triggers wired here. drain() is also
 * capacity-checked and idempotent (guarded by `draining`), so even if a
 * trigger fires spuriously it's a cheap no-op rather than a bug.
 */

import type {
  ISessionManager,
  ISessionStore,
  SchedulerPolicy,
  SessionDTO,
  SessionStatus,
} from '../shared/contract.js'
import { DEFAULT_SCHEDULER_POLICY } from '../shared/contract.js'
import type { IConfigStore } from './configStore.js'
import type { RunLogger } from './runLogger.js'
import type { LaunchRequest } from './sessionLauncher.js'

const SCHEDULER_POLICY_KEY = 'scheduler.policy'

export interface SchedulerDeps {
  sessions: Pick<ISessionManager, 'liveSessions' | 'on' | 'off'>
  store: ISessionStore
  config: IConfigStore
  launch: (req: LaunchRequest) => Promise<SessionDTO>
  logger?: RunLogger
  now?: () => number
}

export interface ISessionScheduler {
  /** Start immediately when under the cap, otherwise persist a 'queued' session row and enqueue. */
  submit(req: LaunchRequest): Promise<SessionDTO>
  /** Remove a queued entry (kill/cleanup of a not-yet-started session). False if not queued. */
  cancel(sessionId: string): boolean
  /** Launch queued entries while capacity allows. Idempotent; safe to call from any trigger. */
  drain(): Promise<void>
  /** Wire slot-freed listeners + restore persisted queued rows (oldest first) and drain. */
  start(): void
  stop(): void
  /** Snapshot of queued session ids in queue order (for tests/UI). */
  queuedIds(): string[]
}

function coerce(partial: unknown): SchedulerPolicy {
  const p = (partial ?? {}) as Partial<SchedulerPolicy>
  const raw = p.maxConcurrent
  const n =
    typeof raw === 'number' && Number.isFinite(raw)
      ? Math.floor(raw)
      : DEFAULT_SCHEDULER_POLICY.maxConcurrent
  return { maxConcurrent: Math.max(0, n) }
}

/** Read the scheduler policy from the config store, falling back to defaults. */
export function readSchedulerPolicy(config: IConfigStore): SchedulerPolicy {
  const raw = config.get(SCHEDULER_POLICY_KEY)
  if (!raw) return { ...DEFAULT_SCHEDULER_POLICY }
  try {
    return coerce(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_SCHEDULER_POLICY }
  }
}

/** Normalize and persist a scheduler policy. */
export function writeSchedulerPolicy(config: IConfigStore, policy: SchedulerPolicy): void {
  config.set(SCHEDULER_POLICY_KEY, JSON.stringify(coerce(policy)))
}

function requestFromRow(row: SessionDTO): LaunchRequest {
  return {
    sessionId: row.id,
    tid: row.tid,
    title: row.title,
    prompt: row.prompt,
    repoId: row.repoId,
    branch: row.branch,
    systemPrompt: row.systemPrompt ?? '',
    agentKind: row.agentKind,
    src: row.src,
    ownerId: row.ownerId ?? 'local',
  }
}

export function createSessionScheduler(deps: SchedulerDeps): ISessionScheduler {
  const now = deps.now ?? Date.now
  const queue: LaunchRequest[] = []
  // Launches that have begun but whose PTY may not yet be visible in
  // liveSessions() — worktree creation takes seconds, so without this two
  // quick submits would both pass the capacity check.
  let inFlight = 0
  let draining = false
  let drainAgain = false

  function capacity(policy: SchedulerPolicy): number {
    if (policy.maxConcurrent === 0) return Infinity
    return policy.maxConcurrent - deps.sessions.liveSessions().length - inFlight
  }

  async function submit(req: LaunchRequest): Promise<SessionDTO> {
    const policy = readSchedulerPolicy(deps.config)
    if (capacity(policy) > 0) {
      inFlight++
      try {
        return await deps.launch(req)
      } finally {
        inFlight--
      }
    }

    const dto: SessionDTO = {
      id: req.sessionId,
      tid: req.tid,
      title: req.title,
      prompt: req.prompt,
      repoId: req.repoId,
      branch: req.branch,
      status: 'queued',
      systemPrompt: req.systemPrompt,
      agentKind: req.agentKind ?? 'claude-code',
      createdAt: now(),
      ownerId: req.ownerId,
      src: req.src,
    }
    deps.store.upsert(dto)
    queue.push(req)
    deps.logger?.server('info', 'session queued', {
      sessionId: req.sessionId,
      tid: req.tid,
      queueLength: queue.length,
    })
    return dto
  }

  function cancel(sessionId: string): boolean {
    const idx = queue.findIndex((r) => r.sessionId === sessionId)
    if (idx === -1) return false
    queue.splice(idx, 1)
    return true
  }

  async function drain(): Promise<void> {
    if (draining) {
      // A trigger arrived while we were already draining — re-run once more
      // after the current pass finishes instead of racing a second loop.
      drainAgain = true
      return
    }
    draining = true
    try {
      for (;;) {
        const policy = readSchedulerPolicy(deps.config)
        if (capacity(policy) <= 0) break
        const req = queue.shift()
        if (!req) break

        // Stale entry: the row was deleted (cleanup) or moved off 'queued'
        // (cancel + interrupted) since it was enqueued. Skip without launching.
        const row = deps.store.get(req.sessionId)
        if (!row || row.status !== 'queued') continue

        inFlight++
        try {
          await deps.launch(req)
        } catch (err) {
          const cur = deps.store.get(req.sessionId)
          if (cur) deps.store.upsert({ ...cur, status: 'errored' })
          deps.logger?.server('error', 'queued session launch failed', {
            sessionId: req.sessionId,
            error: err instanceof Error ? err.message : String(err),
          })
        } finally {
          inFlight--
        }
      }
    } finally {
      draining = false
      if (drainAgain) {
        drainAgain = false
        void drain()
      }
    }
  }

  // TIMING: sessionManager emits 'exit' / status 'reaped' BEFORE it deletes
  // the dying session from its internal map (onExit: emit('status') →
  // emit('exit') → sessions.delete; reap(): emit('status','reaped') →
  // pty.kill → sessions.delete). drain()'s first capacity check runs
  // synchronously (no await precedes it), so calling drain() directly from
  // inside the emit would still count the dead session in liveSessions() and
  // wrongly conclude there's no capacity — with maxConcurrent=1 and one
  // queued entry the queue would stall until some other trigger fired
  // (possibly forever). queueMicrotask defers the drain until after the
  // emitting function — including its sessions.delete — has returned.
  function onSlotFreedByExit(): void {
    queueMicrotask(() => void drain())
  }

  function onStatus(_sessionId: string, status: SessionStatus): void {
    // See file header: only 'reaped' is a terminal, one-shot slot-freeing
    // signal — ordinary status churn ('needs'/'running' flapping) must not
    // trigger a drain attempt on every PTY chunk.
    if (status !== 'reaped') return
    queueMicrotask(() => void drain())
  }

  function start(): void {
    deps.sessions.on('exit', onSlotFreedByExit)
    deps.sessions.on('status', onStatus)

    const restored = deps.store
      .list()
      .filter((s) => s.status === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt)
    for (const row of restored) {
      queue.push(requestFromRow(row))
    }

    void drain()
  }

  function stop(): void {
    deps.sessions.off('exit', onSlotFreedByExit)
    deps.sessions.off('status', onStatus)
  }

  function queuedIds(): string[] {
    return queue.map((r) => r.sessionId)
  }

  return { submit, cancel, drain, start, stop, queuedIds }
}

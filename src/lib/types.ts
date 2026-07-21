// Aliased from the contract (the seam's source of truth) instead of
// re-declared, so these can't silently drift out of sync (FLO-121).
import type {
  BackendKind,
  TicketSource as Source,
  WorkflowState,
} from '../../electron/shared/contract.js'
export type { BackendKind, Source, WorkflowState }

export type Status =
  | 'idle'
  | 'running'
  | 'needs'
  | 'done'
  | 'errored'
  | 'detached'
  | 'interrupted'
  | 'reaped'
  | 'queued'
  // Renderer-only optimistic status: set the instant a manual teardown is
  // confirmed, cleared when the session is removed. Never persisted or sent by
  // the backend — it's the "this agent is going away" loading state.
  | 'tearing-down'
export type Filter = 'all' | 'needs' | 'running' | 'done'

/** Maps a session's raw status to the sidebar filter segment / counts bucket
 *  it belongs to. Single source of truth for the "needs"/"running"/"done"
 *  grouping so the sidebar (AgentList/stores) and Mission Control never
 *  disagree about which bucket a status lands in (FLO-113): errored sessions
 *  are as urgent as 'needs', detached/queued are still 'running'. Statuses
 *  that don't map to a segment (idle, interrupted, reaped, tearing-down) are
 *  only reachable via "All". Exhaustive switch so a new Status forces a
 *  bucketing decision here. */
export function statusBucket(status: Status): 'needs' | 'running' | 'done' | null {
  switch (status) {
    case 'needs':
    case 'errored':
      return 'needs'
    case 'running':
    case 'detached':
    case 'queued':
      return 'running'
    case 'done':
      return 'done'
    case 'idle':
    case 'interrupted':
    case 'reaped':
    case 'tearing-down':
      return null
    default: {
      const _exhaustive: never = status
      return _exhaustive
    }
  }
}

export interface Repo {
  id: string
  org: string
  name: string
  base: string
}

export interface Ticket {
  tid: string
  src: Source
  title: string
  repo: string
  description?: string
  status?: WorkflowState
  done: boolean
}

export interface Session {
  id?: string // backend SessionDTO UUID; absent on mock sessions
  tid: string
  src: Source
  status: Status
  title: string
  repo: string | null
  suggestedRepo?: string
  branch: string | null
  add: number
  del: number
  behind: number
  ago: string
  prompt?: string
  // user-supplied extra CLI args appended at start (TASK-UQF55)
  extraArgs?: string
  description?: string
  port?: number
  agentKind?: BackendKind
  prUrl?: string
  // set when auto-reconcile skipped removing a dirty/unmerged worktree
  reconcileWarning?: string
  // epoch ms timestamp when this session entered 'needs' status; cleared when it exits
  needsSince?: number
  activity: { text: string; q?: boolean }
}

export const STATUS_LABEL: Record<Status, string> = {
  idle: 'Not started',
  needs: 'Needs you',
  running: 'Running',
  queued: 'Queued',
  done: 'Done',
  errored: 'Errored',
  detached: 'Detached',
  interrupted: 'Interrupted',
  reaped: 'Reaped',
  'tearing-down': 'Tearing down',
}

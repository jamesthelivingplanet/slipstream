export type Status = 'idle' | 'running' | 'needs' | 'done' | 'errored' | 'detached'
export type Source = 'jira' | 'linear'
export type Filter = 'all' | 'needs' | 'running' | 'done'

export interface Repo {
  id: string
  org: string
  name: string
  base: string
}

export interface WorkflowState { id: string; name: string; type?: string }

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
  id?: string           // backend SessionDTO UUID; absent on mock sessions
  tid: string
  src: Source
  status: Status
  title: string
  repo: string | null
  suggestedRepo?: string
  branch: string | null
  add: number
  del: number
  ago: string
  prompt?: string
  description?: string
  port?: number
  activity: { text: string; q?: boolean }
}

export const STATUS_LABEL: Record<Status, string> = {
  idle: 'Not started',
  needs: 'Needs you',
  running: 'Running',
  done: 'Done',
  errored: 'Errored',
  detached: 'Detached',
}

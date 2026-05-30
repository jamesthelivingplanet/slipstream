export type Status = 'idle' | 'running' | 'needs' | 'done' | 'errored'
export type Source = 'jira' | 'linear'
export type Filter = 'all' | 'needs' | 'running' | 'done'

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
}

export interface Session {
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
  activity: { text: string; q?: boolean }
}

export const STATUS_LABEL: Record<Status, string> = {
  idle: 'Not started',
  needs: 'Needs you',
  running: 'Running',
  done: 'Done',
  errored: 'Errored',
}

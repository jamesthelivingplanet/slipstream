import type { Session } from './types'

/** Sessions whose ticket is now Done (present in the pulled set with done=true). */
export function sessionsToReconcile(
  sessions: Session[],
  dtos: { tid: string; done: boolean }[],
): Session[] {
  const doneTids = new Set(dtos.filter((d) => d.done).map((d) => d.tid))
  return sessions.filter((s) => doneTids.has(s.tid))
}

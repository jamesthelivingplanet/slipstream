import { EventEmitter } from 'node:events'

/**
 * Shared per-session write-lock coordinator. Lives in IpcDeps so all
 * per-connection rpc instances (one per WebSocket client) share the same
 * state — only one client may write to a given session's PTY at a time;
 * everyone else is view-only until they "take over".
 *
 * Pure, node-runnable — no native deps, only node:events — so it's usable
 * in vitest without pulling in better-sqlite3/node-pty.
 */
export interface IWriteCoordinator {
  /** Register clientId as viewing sessionId. Grants the write lock if free. */
  attach(sessionId: string, clientId: string): void
  /** Stop viewing sessionId. Reassigns the write lock if clientId held it. */
  detach(sessionId: string, clientId: string): void
  /** Claim the write lock for clientId, demoting the current holder. */
  take(sessionId: string, clientId: string): void
  /** A write arrived from clientId. Auto-claims a free lock (first writer
   *  wins); returns whether clientId is (now) the holder. */
  noteWrite(sessionId: string, clientId: string): boolean
  /** Does clientId currently hold the write lock for sessionId? */
  canWrite(sessionId: string, clientId: string): boolean
  /** Number of clients currently attached to sessionId. */
  viewers(sessionId: string): number
  /** Is clientId attached to sessionId? */
  isViewer(sessionId: string, clientId: string): boolean
  /** Detach clientId from every session it's viewing (e.g. on disconnect). */
  dropClient(clientId: string): void
  on(event: 'change', listener: (sessionId: string) => void): void
  off(event: 'change', listener: (sessionId: string) => void): void
}

interface SessionLock {
  viewers: Set<string>
  holder: string | null
}

export function createWriteCoordinator(): IWriteCoordinator {
  const sessions = new Map<string, SessionLock>()
  const emitter = new EventEmitter()

  function getOrCreate(sessionId: string): SessionLock {
    let lock = sessions.get(sessionId)
    if (!lock) {
      lock = { viewers: new Set(), holder: null }
      sessions.set(sessionId, lock)
    }
    return lock
  }

  function attach(sessionId: string, clientId: string): void {
    const lock = getOrCreate(sessionId)
    lock.viewers.add(clientId)
    if (lock.holder === null) lock.holder = clientId
    emitter.emit('change', sessionId)
  }

  function detach(sessionId: string, clientId: string): void {
    const lock = sessions.get(sessionId)
    if (!lock) return
    lock.viewers.delete(clientId)
    if (lock.holder === clientId) {
      lock.holder = lock.viewers.size > 0 ? lock.viewers.values().next().value! : null
    }
    if (lock.viewers.size === 0) sessions.delete(sessionId)
    emitter.emit('change', sessionId)
  }

  function take(sessionId: string, clientId: string): void {
    const lock = getOrCreate(sessionId)
    lock.viewers.add(clientId)
    lock.holder = clientId
    emitter.emit('change', sessionId)
  }

  function noteWrite(sessionId: string, clientId: string): boolean {
    const lock = sessions.get(sessionId)
    if (!lock || lock.holder === null) {
      const l = getOrCreate(sessionId)
      l.viewers.add(clientId)
      l.holder = clientId
      emitter.emit('change', sessionId)
      return true
    }
    return lock.holder === clientId
  }

  function canWrite(sessionId: string, clientId: string): boolean {
    return sessions.get(sessionId)?.holder === clientId
  }

  function viewers(sessionId: string): number {
    return sessions.get(sessionId)?.viewers.size ?? 0
  }

  function isViewer(sessionId: string, clientId: string): boolean {
    return sessions.get(sessionId)?.viewers.has(clientId) ?? false
  }

  function dropClient(clientId: string): void {
    for (const sessionId of Array.from(sessions.keys())) {
      if (sessions.get(sessionId)?.viewers.has(clientId)) {
        detach(sessionId, clientId)
      }
    }
  }

  return {
    attach,
    detach,
    take,
    noteWrite,
    canWrite,
    viewers,
    isViewer,
    dropClient,
    on(event, listener) {
      emitter.on(event, listener)
    },
    off(event, listener) {
      emitter.off(event, listener)
    },
  }
}

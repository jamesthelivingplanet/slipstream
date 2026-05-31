/**
 * SessionManager — owns all node-pty processes for active Claude Code agents.
 *
 * Each session gets its own StatusDetector. PTY events are forwarded to
 * consumers via a typed EventEmitter (satisfies ISessionManager.on).
 */

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import * as pty from 'node-pty'

import type {
  ISessionManager,
  SessionDTO,
  SessionEvents,
  SessionStatus,
  StartSessionInput,
} from '../shared/contract.js'
import { StatusDetector } from './statusDetector.js'
import { trustDirectory } from './claudeTrust.js'

// ─── Internal session record ──────────────────────────────────────────────────

interface SessionRecord {
  pty: pty.IPty
  detector: StatusDetector
  dto: SessionDTO
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createSessionManager(): ISessionManager {
  const emitter = new EventEmitter()
  const sessions = new Map<string, SessionRecord>()

  /** Typed emit helper — keeps call sites concise and avoids casting. */
  function emit<E extends keyof SessionEvents>(
    event: E,
    ...args: Parameters<SessionEvents[E]>
  ): void {
    emitter.emit(event, ...args)
  }

  // ── ISessionManager implementation ─────────────────────────────────────────

  function start(input: StartSessionInput): SessionDTO {
    const id = randomUUID()

    const detector = new StatusDetector()

    trustDirectory(input.cwd)
    const proc = pty.spawn(
      'claude',
      ['--dangerously-skip-permissions', input.prompt],
      {
        name: 'xterm-color',
        cols: 80,
        rows: 30,
        cwd: input.cwd,
        env: { ...process.env, ...input.env } as Record<string, string>,
      }
    )

    const dto: SessionDTO = {
      id,
      tid: input.tid,
      title: input.title,
      prompt: input.prompt,
      repoId: input.repo.id,
      branch: input.branch,
      status: 'running',
      createdAt: Date.now(),
    }

    sessions.set(id, { pty: proc, detector, dto })

    // Wire PTY data → detector + consumers
    proc.onData((chunk: string) => {
      detector.push(chunk)
      emit('data', id, chunk)
      const s = detector.status()
      dto.status = s
      emit('status', id, s)
    })

    // Wire PTY exit
    proc.onExit(({ exitCode }: { exitCode: number }) => {
      detector.markExit(exitCode)
      const s = detector.status()
      dto.status = s
      emit('status', id, s)
      emit('exit', id, exitCode)
      sessions.delete(id)
    })

    // Emit initial running status so consumers get the first state immediately
    emit('status', id, 'running')

    return { ...dto }
  }

  function write(sessionId: string, data: string): void {
    const rec = sessions.get(sessionId)
    if (!rec) return
    rec.pty.write(data)
  }

  function resize(sessionId: string, cols: number, rows: number): void {
    const rec = sessions.get(sessionId)
    if (!rec) return
    rec.pty.resize(cols, rows)
  }

  function kill(sessionId: string): void {
    const rec = sessions.get(sessionId)
    if (!rec) return
    rec.pty.kill()
    sessions.delete(sessionId)
  }

  function on<E extends keyof SessionEvents>(
    event: E,
    listener: SessionEvents[E]
  ): void {
    emitter.on(event, listener as (...args: unknown[]) => void)
  }

  return { start, write, resize, kill, on }
}

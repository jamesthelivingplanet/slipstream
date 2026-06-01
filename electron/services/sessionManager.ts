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
import { OutputBuffer } from './outputBuffer.js'
import { trustDirectory } from './claudeTrust.js'

// ─── Internal session record ──────────────────────────────────────────────────

interface SessionRecord {
  pty: pty.IPty
  detector: StatusDetector
  buffer: OutputBuffer
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
    const buffer = new OutputBuffer()

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

    sessions.set(id, { pty: proc, detector, buffer, dto })

    // Wire PTY data → buffer + detector + consumers
    proc.onData((chunk: string) => {
      const seq = buffer.push(chunk)
      detector.push(chunk)
      emit('data', id, chunk, seq)
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

  function getBuffer(sessionId: string): { data: string; seq: number } {
    const rec = sessions.get(sessionId)
    if (!rec) return { data: '', seq: 0 }
    return rec.buffer.snapshot()
  }

  return { start, write, resize, kill, on, getBuffer }
}

/**
 * SessionManager — owns all node-pty processes for active Claude Code agents.
 *
 * Each session gets its own StatusDetector. PTY events are forwarded to
 * consumers via a typed EventEmitter (satisfies ISessionManager.on).
 */

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import * as pty from 'node-pty'
import { existsSync } from 'node:fs'
import * as path from 'node:path'

import type {
  ISessionManager,
  ResumeSessionInput,
  SessionDTO,
  SessionEvents,
  SessionStatus,
  StartSessionInput,
} from '../shared/contract.js'
import { StatusDetector } from './statusDetector.js'
import { OutputBuffer } from './outputBuffer.js'
import { trustDirectory } from './claudeTrust.js'
import { hasTranscript } from './transcripts.js'
import { deliverPrompt, buildAgentsMdContent } from '../shared/promptComposer.js'
import { writeAgentsMd } from './promptWriter.js'
import { fetchOpencodeMessages, opencodeStatusFromMessages } from './opencodeSessions.js'

function spawnAgent(cmd: string, args: string[], cwd: string, env?: Record<string, string>): pty.IPty {
  return pty.spawn(cmd, args, {
    name: 'xterm-color',
    cols: 80,
    rows: 30,
    cwd,
    env: { ...process.env, ...(env ?? {}) } as Record<string, string>,
  })
}

const OPENCODE_BIN = (() => {
  const local = path.join(process.cwd(), 'node_modules', '.bin', 'opencode')
  return existsSync(local) ? local : 'opencode'
})()

function spawnOpencode(args: string[], prompt: string | null, cwd: string, env?: Record<string, string>): pty.IPty {
  const proc = spawnAgent(OPENCODE_BIN, args, cwd, env)
  if (prompt !== null) {
    setTimeout(() => {
      try { proc.write(prompt + '\r') } catch { /* process may have exited */ }
    }, 1000)
  }
  return proc
}

// ─── Internal session record ──────────────────────────────────────────────────

interface SessionRecord {
  pty: pty.IPty
  detector: StatusDetector
  buffer: OutputBuffer
  dto: SessionDTO
  disposed?: boolean
  // opencode-only: embedded server port + session id used for status polling
  opencodePort?: number
  opencodeSid?: string
  pollTimer?: ReturnType<typeof setInterval>
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

  // ── Shared wiring helper ───────────────────────────────────────────────────

  function wire(id: string, rec: SessionRecord) {
    const { pty: proc, detector, buffer, dto } = rec
    // OpenCode is a full-screen TUI: its redraws make PTY-scraped markers
    // unreliable, so its status is driven by polling the embedded server
    // (see setOpencodeSid / startPolling) instead of the StatusDetector.
    const ptyDrivenStatus = dto.agentKind !== 'opencode'
    proc.onData((chunk: string) => {
      const seq = buffer.push(chunk)
      detector.push(chunk)
      emit('data', id, chunk, seq)
      if (ptyDrivenStatus) {
        const s = detector.status()
        dto.status = s
        emit('status', id, s)
      }
    })
    proc.onExit(({ exitCode }: { exitCode: number }) => {
      if (rec.disposed) return
      stopPolling(rec)
      rec.disposed = true
      detector.markExit(exitCode)
      const s = detector.status()
      dto.status = s
      emit('status', id, s)
      emit('exit', id, exitCode)
      if (sessions.get(id) === rec) sessions.delete(id)
    })
  }

  // ── opencode status polling ────────────────────────────────────────────────

  function stopPolling(rec: SessionRecord) {
    if (rec.pollTimer) {
      clearInterval(rec.pollTimer)
      rec.pollTimer = undefined
    }
  }

  function startPolling(id: string, rec: SessionRecord) {
    if (rec.pollTimer || !rec.opencodePort || !rec.opencodeSid) return
    const port = rec.opencodePort
    const sid = rec.opencodeSid
    const tick = async () => {
      if (rec.disposed) return
      const messages = await fetchOpencodeMessages(port, sid)
      if (rec.disposed) return
      const s = opencodeStatusFromMessages(messages)
      if (rec.dto.status !== s) {
        rec.dto.status = s
        emit('status', id, s)
      }
    }
    void tick()
    rec.pollTimer = setInterval(() => void tick(), 2000)
  }

  // ── ISessionManager implementation ─────────────────────────────────────────

  function start(input: StartSessionInput): SessionDTO {
    const id = randomUUID()

    const detector = new StatusDetector()
    const buffer = new OutputBuffer()

    trustDirectory(input.cwd)

    // Write AGENTS.md for opencode sessions (system prompt via file, not CLI arg)
    if (input.agentKind === 'opencode' && input.systemPrompt) {
      writeAgentsMd(input.cwd, buildAgentsMdContent(input.systemPrompt))
    }

    const agentKind = input.agentKind ?? 'claude-code'
    let proc: pty.IPty
    if (agentKind === 'opencode') {
      const { userPrompt } = deliverPrompt('opencode', { system: input.systemPrompt ?? '', user: input.prompt })
      const portArgs = input.opencodePort ? ['--port', String(input.opencodePort)] : []
      proc = spawnOpencode(portArgs, userPrompt, input.cwd, input.env)
    } else {
      const { systemArgs, userPrompt } = deliverPrompt('claude-code', { system: input.systemPrompt ?? '', user: input.prompt })
      proc = spawnAgent('claude', ['--dangerously-skip-permissions', ...systemArgs, '--session-id', id, userPrompt], input.cwd, input.env)
    }

    const dto: SessionDTO = {
      id,
      tid: input.tid,
      title: input.title,
      prompt: input.prompt,
      repoId: input.repo.id,
      branch: input.branch,
      status: 'running',
      systemPrompt: input.systemPrompt,
      agentKind: input.agentKind,
      createdAt: Date.now(),
    }

    const rec: SessionRecord = { pty: proc, detector, buffer, dto, opencodePort: input.opencodePort }
    sessions.set(id, rec)
    wire(id, rec)

    // Emit initial running status so consumers get the first state immediately
    emit('status', id, 'running')

    return { ...dto }
  }

  function resume(input: ResumeSessionInput): SessionDTO {
    // If already live, return existing dto
    const existing = sessions.get(input.session.id)
    if (existing) return { ...existing.dto }

    const id = input.session.id
    const detector = new StatusDetector()
    const buffer = new OutputBuffer()

    trustDirectory(input.cwd)
    const agentKind = input.session.agentKind ?? 'claude-code'
    const { userPrompt: resumeUserPrompt, systemArgs: resumeSystemArgs } = deliverPrompt(agentKind, { system: input.session.systemPrompt ?? '', user: input.session.prompt })

    let proc: pty.IPty
    if (agentKind === 'opencode') {
      if (input.session.systemPrompt) {
        writeAgentsMd(input.cwd, buildAgentsMdContent(input.session.systemPrompt))
      }
      const ocSid = input.session.opencodeSid
      const portArgs = input.opencodePort ? ['--port', String(input.opencodePort)] : []
      const resumeArgs = ocSid ? ['--session', ocSid] : ['--continue']
      proc = spawnOpencode([...portArgs, ...resumeArgs], null, input.cwd, input.env)
    } else {
      let args: string[]
      if (hasTranscript(id)) {
        args = ['--dangerously-skip-permissions', '--resume', id]
      } else {
        args = ['--dangerously-skip-permissions', ...resumeSystemArgs, '--session-id', id, resumeUserPrompt]
      }
      proc = spawnAgent('claude', args, input.cwd, input.env)
    }

    const dto: SessionDTO = { ...input.session, status: 'running' }
    const rec: SessionRecord = { pty: proc, detector, buffer, dto, opencodePort: input.opencodePort, opencodeSid: input.session.opencodeSid }
    sessions.set(id, rec)
    wire(id, rec)
    emit('status', id, 'running')
    // opencodeSid is already known on resume — begin status polling right away.
    if (agentKind === 'opencode') startPolling(id, rec)
    return { ...dto }
  }

  function attachRemoteControl(input: ResumeSessionInput): SessionDTO {
    const id = input.session.id

    if (sessions.has(id)) {
      const old = sessions.get(id)!
      old.disposed = true
      old.pty.kill()
      sessions.delete(id)
    }

    const detector = new StatusDetector()
    const buffer = new OutputBuffer()

    trustDirectory(input.cwd)
    const agentKind = input.session.agentKind ?? 'claude-code'
    const { userPrompt: rcUserPrompt, systemArgs: rcSystemArgs } = deliverPrompt(agentKind, { system: input.session.systemPrompt ?? '', user: input.session.prompt })

    let proc: pty.IPty
    if (agentKind === 'opencode') {
      if (input.session.systemPrompt) {
        writeAgentsMd(input.cwd, buildAgentsMdContent(input.session.systemPrompt))
      }
      const ocSid = input.session.opencodeSid
      const portArgs = input.opencodePort ? ['--port', String(input.opencodePort)] : []
      const resumeArgs = ocSid ? ['--session', ocSid] : ['--continue']
      proc = spawnOpencode([...portArgs, ...resumeArgs], null, input.cwd, input.env)
    } else {
      let args: string[]
      if (hasTranscript(id)) {
        args = ['--dangerously-skip-permissions', '--remote-control', '--resume', id]
      } else {
        args = ['--dangerously-skip-permissions', '--remote-control', ...rcSystemArgs, '--session-id', id, rcUserPrompt]
      }
      proc = spawnAgent('claude', args, input.cwd, input.env)
    }

    const dto: SessionDTO = { ...input.session, status: 'running' }
    const rec: SessionRecord = { pty: proc, detector, buffer, dto, opencodePort: input.opencodePort, opencodeSid: input.session.opencodeSid }
    sessions.set(id, rec)
    wire(id, rec)
    emit('status', id, 'running')
    if (agentKind === 'opencode') startPolling(id, rec)
    return { ...dto }
  }

  function has(sessionId: string): boolean {
    return sessions.has(sessionId)
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
    stopPolling(rec)
    rec.disposed = true
    rec.pty.kill()
    sessions.delete(sessionId)
  }

  function on<E extends keyof SessionEvents>(
    event: E,
    listener: SessionEvents[E]
  ): void {
    emitter.on(event, listener as (...args: unknown[]) => void)
  }

  function off<E extends keyof SessionEvents>(
    event: E,
    listener: SessionEvents[E]
  ): void {
    emitter.removeListener(event, listener as (...args: unknown[]) => void)
  }

  function getBuffer(sessionId: string): { data: string; seq: number } {
    const rec = sessions.get(sessionId)
    if (!rec) return { data: '', seq: 0 }
    return rec.buffer.snapshot()
  }

  function killAll(): void {
    for (const rec of sessions.values()) {
      stopPolling(rec)
      rec.disposed = true
      try { rec.pty.kill() } catch { /* already gone */ }
    }
    sessions.clear()
  }

  function setOpencodeSid(sessionId: string, sid: string): void {
    const rec = sessions.get(sessionId)
    if (!rec || !rec.opencodePort) return
    rec.opencodeSid = sid
    startPolling(sessionId, rec)
  }

  return { start, resume, attachRemoteControl, has, write, resize, kill, killAll, on, off, getBuffer, setOpencodeSid }
}

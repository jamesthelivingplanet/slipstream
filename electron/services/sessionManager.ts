/**
 * SessionManager — owns all node-pty processes for active agents.
 *
 * Each session gets its own StatusDetector. PTY events are forwarded to
 * consumers via a typed EventEmitter (satisfies ISessionManager.on). All
 * agent-specific launch/resume/status logic lives behind an AgentBackend
 * (see agentBackend.ts) — this file has no agentKind branching.
 */

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as pty from 'node-pty'

import type {
  HandoffSessionInput,
  ISessionManager,
  LiveSessionInfo,
  ResumeSessionInput,
  SessionDTO,
  SessionEvents,
  StartSessionInput,
} from '../shared/contract.js'
import { buildAgentEnv } from './agentEnv.js'
import { StatusDetector } from './statusDetector.js'
import { OutputBuffer } from './outputBuffer.js'
import { ScrollbackStore } from './scrollbackStore.js'
import { trustDirectory } from './claudeTrust.js'
import { hasTranscript } from './transcripts.js'
import {
  selectBackend,
  type AgentBackend,
  type SpawnSpec,
  type StatusHandle,
} from './agentBackend.js'
import type { RunLogger } from './runLogger.js'
import { parseStatusSentinel, STATUS_SENTINEL_FILE } from './statusSentinel.js'
import { parseOutcomeSentinel, OUTCOME_SENTINEL_FILE } from './outcomeSentinel.js'

function spawnAgent(
  cmd: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): pty.IPty {
  return pty.spawn(cmd, args, {
    name: 'xterm-color',
    cols: 80,
    rows: 30,
    cwd,
    // Scrubbed: agents run arbitrary repo code and must not inherit the
    // daemon's internal env (SLIPSTREAM_TOKEN above all) — see agentEnv.ts.
    env: buildAgentEnv(process.env, env),
  })
}

// ─── Internal session record ──────────────────────────────────────────────────

interface SessionRecord {
  pty: pty.IPty
  detector: StatusDetector
  buffer: OutputBuffer
  scrollback: ScrollbackStore | null
  dto: SessionDTO
  backend: AgentBackend
  disposed?: boolean
  lastActivityAt: number
  // opencode-only: embedded server port + session id used for status polling
  opencodePort?: number
  opencodeSid?: string
  pollTimer?: ReturnType<typeof setInterval>
  watcher?: ReturnType<typeof fs.watch>
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createSessionManager(logger?: RunLogger, root?: string): ISessionManager {
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
    const { pty: proc, detector, buffer, scrollback } = rec
    // Poll-driven backends (opencode's embedded server, pi's session file) are
    // full-screen TUIs whose redraws make PTY-scraped markers unreliable, so
    // their status comes from beginStatusTracking instead of the StatusDetector.
    const ptyDrivenStatus = rec.backend.statusSource === 'pty'
    proc.onData((chunk: string) => {
      rec.lastActivityAt = Date.now()
      const seq = buffer.push(chunk)
      if (scrollback) scrollback.append(id, chunk)
      detector.push(chunk)
      emit('data', id, chunk, seq)
      if (ptyDrivenStatus) {
        const s = detector.status()
        rec.dto.status = s
        emit('status', id, s)
      }
    })
    proc.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      if (rec.disposed) return
      stopPolling(rec)
      rec.watcher?.close()
      rec.watcher = undefined
      rec.disposed = true
      detector.markExit(exitCode)
      const s = detector.status()
      rec.dto.status = s
      // Forensic log: capture exit code + tail of recent PTY output so the
      // reason for a non-zero exit is not lost with the red bubble.
      logger?.exit(id, {
        exitCode,
        signal: signal !== undefined && signal !== 0 ? String(signal) : undefined,
        status: s,
        tail: buffer.snapshot().data,
      })
      emit('status', id, s)
      emit('exit', id, exitCode)
      if (sessions.get(id) === rec) sessions.delete(id)
    })
  }

  // ── status polling plumbing ──────────────────────────────────────────────────

  function stopPolling(rec: SessionRecord) {
    if (rec.pollTimer) {
      clearInterval(rec.pollTimer)
      rec.pollTimer = undefined
    }
  }

  /** Handle a polling backend uses to report status + register its timer. */
  function makeStatusHandle(id: string, rec: SessionRecord): StatusHandle {
    return {
      get disposed() {
        return rec.disposed === true
      },
      get polling() {
        return rec.pollTimer !== undefined
      },
      setStatus(s) {
        if (rec.dto.status !== s) {
          rec.dto.status = s
          emit('status', id, s)
        }
      },
      setPollTimer(timer) {
        rec.pollTimer = timer
      },
    }
  }

  // ── Shared launch helper ───────────────────────────────────────────────────

  function launch(params: {
    id: string
    cwd: string
    env?: Record<string, string>
    system: string
    dto: SessionDTO
    backend: AgentBackend
    spec: SpawnSpec
    opencodePort?: number
    opencodeSid?: string
    isInitialStart: boolean
  }): SessionDTO {
    const { id, cwd, env, system, dto, backend, spec } = params

    const detector = new StatusDetector()
    const buffer = new OutputBuffer()
    const scrollback = root ? new ScrollbackStore(root) : null

    trustDirectory(cwd)
    backend.prepareWorktree?.(cwd, system)

    // Replay persisted scrollback on resume (not initial start)
    if (!params.isInitialStart && scrollback) {
      const replay = scrollback.read(id)
      if (replay.length > 0) {
        const seq = buffer.push(replay)
        // Emit replayed data so clients can render it before live stream resumes
        emit('data', id, replay, seq)
      }
    }

    const proc = spawnAgent(spec.cmd, spec.args, cwd, env)

    // Forensic log of the spawn (before the process might fail)
    logger?.spawn(id, {
      agentKind: backend.kind,
      cmd: spec.cmd,
      args: spec.args,
      cwd,
      tid: dto.tid,
      title: dto.title,
      prompt: dto.prompt,
    })

    const rec: SessionRecord = {
      pty: proc,
      detector,
      buffer,
      scrollback,
      dto,
      backend,
      opencodePort: params.opencodePort,
      opencodeSid: params.opencodeSid,
      lastActivityAt: Date.now(),
    }
    sessions.set(id, rec)

    // Set up fs.watch for pr.json sentinel if root is provided
    if (root) {
      const sentinelDir = path.join(root, 'sessions', id)
      void fs.promises
        .mkdir(sentinelDir, { recursive: true })
        .then(() => {
          const emittedPrUrl = new Set<string>()
          let lastStatusTs = 0
          let lastOutcomeTs = 0
          try {
            const watcher = fs.watch(sentinelDir, { persistent: false }, (_event, filename) => {
              if (
                filename !== 'pr.json' &&
                filename !== STATUS_SENTINEL_FILE &&
                filename !== OUTCOME_SENTINEL_FILE
              )
                return

              if (filename === 'pr.json') {
                const filePath = path.join(sentinelDir, 'pr.json')
                try {
                  const content = fs.readFileSync(filePath, 'utf8')
                  const parsed = JSON.parse(content) as { url?: string }
                  if (parsed.url && !emittedPrUrl.has(parsed.url)) {
                    emittedPrUrl.add(parsed.url)
                    emit('pr', id, parsed.url)
                  }
                } catch {
                  // Ignore read/parse errors (file may be partially written)
                }
                return
              }

              if (filename === OUTCOME_SENTINEL_FILE) {
                const filePath = path.join(sentinelDir, OUTCOME_SENTINEL_FILE)
                try {
                  const content = fs.readFileSync(filePath, 'utf8')
                  const parsed = parseOutcomeSentinel(content)
                  if (parsed && parsed.ts > lastOutcomeTs) {
                    lastOutcomeTs = parsed.ts
                    emit('outcome', id, {
                      sessionId: id,
                      result: parsed.result,
                      summary: parsed.summary,
                      details: parsed.details,
                      reportedAt: parsed.ts,
                    })
                  }
                } catch {
                  // Ignore read/parse errors (file may be partially written)
                }
                return
              }

              // filename === STATUS_SENTINEL_FILE
              const filePath = path.join(sentinelDir, STATUS_SENTINEL_FILE)
              try {
                const content = fs.readFileSync(filePath, 'utf8')
                const parsed = parseStatusSentinel(content)
                if (parsed && parsed.ts > lastStatusTs) {
                  lastStatusTs = parsed.ts
                  const ptyDriven = rec.backend.statusSource === 'pty'
                  if (ptyDriven) {
                    detector.applySignal(parsed.state)
                    const s = detector.status()
                    rec.dto.status = s
                    emit('status', id, s)
                  } else {
                    rec.dto.status = parsed.state
                    emit('status', id, parsed.state)
                  }
                }
              } catch {
                // Ignore read/parse errors (file may be partially written)
              }
            })
            watcher.on('error', () => {
              /* ignore */
            })
            rec.watcher = watcher
          } catch {
            // Ignore watch errors
          }
        })
        .catch(() => {
          /* ignore mkdir errors */
        })
    }

    wire(id, rec)
    emit('status', id, 'running')
    backend.beginStatusTracking?.({
      cwd,
      opencodePort: rec.opencodePort,
      opencodeSid: rec.opencodeSid,
      isInitialStart: params.isInitialStart,
      handle: makeStatusHandle(id, rec),
    })
    return { ...dto }
  }

  // ── ISessionManager implementation ─────────────────────────────────────────

  function start(input: StartSessionInput): SessionDTO {
    const id = input.sessionId ?? randomUUID()
    const backend = selectBackend(input.agentKind)
    const system = input.systemPrompt ?? ''
    const spec = backend.buildStartArgs({
      sessionId: id,
      system,
      user: input.prompt,
      opencodePort: input.opencodePort,
      mcpConfigPath: input.mcpConfigPath,
    })

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
      src: input.src,
    }

    return launch({
      id,
      cwd: input.cwd,
      env: input.env,
      system,
      dto,
      backend,
      spec,
      opencodePort: input.opencodePort,
      isInitialStart: true,
    })
  }

  function resume(input: ResumeSessionInput): SessionDTO {
    // If already live, return existing dto
    const existing = sessions.get(input.session.id)
    if (existing) return { ...existing.dto }

    const id = input.session.id
    const backend = selectBackend(input.session.agentKind)
    const system = input.session.systemPrompt ?? ''
    const spec = backend.buildResumeArgs({
      sessionId: id,
      system,
      user: input.session.prompt,
      opencodeSid: input.session.opencodeSid,
      opencodePort: input.opencodePort,
      hasTranscript: hasTranscript(id),
      mcpConfigPath: input.mcpConfigPath,
    })

    const dto: SessionDTO = { ...input.session, status: 'running' }
    return launch({
      id,
      cwd: input.cwd,
      env: input.env,
      system,
      dto,
      backend,
      spec,
      opencodePort: input.opencodePort,
      opencodeSid: input.session.opencodeSid,
      isInitialStart: false,
    })
  }

  function attachRemoteControl(input: ResumeSessionInput): SessionDTO {
    const id = input.session.id

    if (sessions.has(id)) {
      const old = sessions.get(id)!
      old.disposed = true
      old.pty.kill()
      sessions.delete(id)
    }

    const backend = selectBackend(input.session.agentKind)
    const system = input.session.systemPrompt ?? ''
    const spec = backend.buildRemoteControlArgs({
      sessionId: id,
      system,
      user: input.session.prompt,
      opencodeSid: input.session.opencodeSid,
      opencodePort: input.opencodePort,
      hasTranscript: hasTranscript(id),
      mcpConfigPath: input.mcpConfigPath,
    })

    const dto: SessionDTO = { ...input.session, status: 'running' }
    return launch({
      id,
      cwd: input.cwd,
      env: input.env,
      system,
      dto,
      backend,
      spec,
      opencodePort: input.opencodePort,
      opencodeSid: input.session.opencodeSid,
      isInitialStart: false,
    })
  }

  function handoff(input: HandoffSessionInput): SessionDTO {
    const id = input.session.id
    // The old agent may still be live (an agent stuck at its limit doesn't
    // necessarily exit) — kill it silently before the new backend takes over.
    const old = sessions.get(id)
    if (old) {
      stopPolling(old)
      old.watcher?.close()
      old.watcher = undefined
      old.disposed = true
      old.pty.kill()
      sessions.delete(id)
    }

    const backend = selectBackend(input.agentKind)
    const system = input.session.systemPrompt ?? ''
    const spec = backend.buildHandoffArgs({
      sessionId: id,
      system,
      user: input.handoffPrompt,
      opencodePort: input.opencodePort,
      hasTranscript: hasTranscript(id),
      mcpConfigPath: input.mcpConfigPath,
    })

    // The DTO switches to the new backend; opencodeSid is deliberately cleared —
    // it referred to the previous backend's session (a fresh sid is captured by
    // rpc.ts when the new kind is opencode).
    const dto: SessionDTO = {
      ...input.session,
      agentKind: input.agentKind,
      opencodeSid: undefined,
      status: 'running',
    }
    return launch({
      id,
      cwd: input.cwd,
      env: input.env,
      system,
      dto,
      backend,
      spec,
      opencodePort: input.opencodePort,
      isInitialStart: false,
    })
  }

  function has(sessionId: string): boolean {
    return sessions.has(sessionId)
  }

  function write(sessionId: string, data: string): void {
    const rec = sessions.get(sessionId)
    if (!rec) return
    rec.pty.write(data)
    emit('input', sessionId)
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
    rec.watcher?.close()
    rec.watcher = undefined
    rec.disposed = true
    rec.pty.kill()
    sessions.delete(sessionId)
  }

  function on<E extends keyof SessionEvents>(event: E, listener: SessionEvents[E]): void {
    emitter.on(event, listener as (...args: unknown[]) => void)
  }

  function off<E extends keyof SessionEvents>(event: E, listener: SessionEvents[E]): void {
    emitter.removeListener(event, listener as (...args: unknown[]) => void)
  }

  function getBuffer(sessionId: string): { data: string; seq: number } {
    const rec = sessions.get(sessionId)
    if (rec) return rec.buffer.snapshot()

    // Session not live — try to read persisted scrollback
    if (root) {
      const store = new ScrollbackStore(root)
      const data = store.read(sessionId)
      return { data, seq: data.length }
    }
    return { data: '', seq: 0 }
  }

  function killAll(): void {
    for (const rec of sessions.values()) {
      stopPolling(rec)
      rec.watcher?.close()
      rec.watcher = undefined
      rec.disposed = true
      try {
        rec.pty.kill()
      } catch {
        /* already gone */
      }
    }
    sessions.clear()
  }

  function liveSessions(): LiveSessionInfo[] {
    const out: LiveSessionInfo[] = []
    for (const [id, rec] of sessions) {
      out.push({
        id,
        status: rec.dto.status,
        createdAt: rec.dto.createdAt,
        lastActivityAt: rec.lastActivityAt,
      })
    }
    return out
  }

  function reap(sessionId: string): void {
    const rec = sessions.get(sessionId)
    if (!rec) return
    stopPolling(rec)
    rec.watcher?.close()
    rec.watcher = undefined
    rec.disposed = true // suppress the onExit status/exit emission
    rec.dto.status = 'reaped'
    emit('status', sessionId, 'reaped')
    try {
      rec.pty.kill()
    } catch {
      /* already gone */
    }
    sessions.delete(sessionId)
  }

  function setOpencodeSid(sessionId: string, sid: string): void {
    const rec = sessions.get(sessionId)
    if (!rec || !rec.opencodePort) return
    rec.opencodeSid = sid
    // Now that the sid is known, ask the backend to begin polling. cwd is unused
    // by opencode tracking (the only backend with an opencodePort), so '' is safe.
    rec.backend.beginStatusTracking?.({
      cwd: '',
      opencodePort: rec.opencodePort,
      opencodeSid: sid,
      isInitialStart: false,
      handle: makeStatusHandle(sessionId, rec),
    })
  }

  return {
    start,
    resume,
    attachRemoteControl,
    handoff,
    has,
    write,
    resize,
    kill,
    killAll,
    on,
    off,
    getBuffer,
    setOpencodeSid,
    liveSessions,
    reap,
  }
}

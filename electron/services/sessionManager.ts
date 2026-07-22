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
import * as path from 'node:path'
import * as pty from 'node-pty'

import type {
  HandoffSessionInput,
  ISessionManager,
  LiveSessionInfo,
  ResumeSessionInput,
  SessionChatMessageDTO,
  SessionDTO,
  SessionEvents,
  StartSessionInput,
} from '../shared/contract.js'
import { parseAgentArgs } from '../shared/agentCli.js'
import { buildAgentEnv } from './agentEnv.js'
import { sandboxSpawnSpec } from './agentSandbox.js'
import { StatusDetector } from './statusDetector.js'
import { OutputBuffer } from './outputBuffer.js'
import { ScrollbackStore } from './scrollbackStore.js'
import { ScreenState, serializeScrollback } from './screenState.js'
import { trustDirectory } from './claudeTrust.js'
import {
  selectBackend,
  type AgentBackend,
  type SpawnSpec,
  type StatusHandle,
} from './agentBackend.js'
import type { RunLogger } from './runLogger.js'
import { createSentinelWatcher, type SentinelWatcher } from './sentinelWatcher.js'
import { writeSlipstreamSkill } from './promptWriter.js'
import { transcriptPathFor } from './transcripts.js'
import { parseTranscriptMessages } from './transcriptMessages.js'
import { startChatTail, type ChatTailHandle } from './chatTail.js'
import { parsePiChatMessages } from './piChatMessages.js'
import { findNewestPiSessionFileSync, piSessionDirFor } from './piSessions.js'
import { fetchOpencodeMessages, opencodeMessagesToChat } from './opencodeSessions.js'

// Chat tail (TASK-FPH60, claude-code + pi): how often to retry resolving the
// transcript/session-file path before it exists (a modest poll — the
// PTY-data hook below covers the common case near-instantly) and how long to
// keep retrying before giving up on a session that may never produce one.
const CHAT_RETRY_INTERVAL_MS = 2000
const CHAT_RETRY_TIMEOUT_MS = 5 * 60_000

// Opencode chat poll (TASK-FPH60): opencode has no file to fs.watch, so live
// chat updates are an independent poll of its embedded server — deliberately
// separate from the status pipeline's own OPENCODE_STATUS_POLL_MS poll.
// Runs only while >=1 chat subscriber is registered (see subscribeChat).
const OPENCODE_CHAT_POLL_MS = 3000

/** Factory for the node-pty process backing a session. Extracted as an
 *  injectable seam (FLO-132) so the entire SessionManager state machine —
 *  launch/kill/handoff/attach event ordering, disposed suppression, watcher
 *  teardown — can be exercised against a stub PTY in plain Node (vitest),
 *  with no dependency on the Electron native ABI. Production callers omit it
 *  and get defaultSpawnAgent (real pty.spawn); tests pass a stub. */
export type SpawnAgent = (
  cmd: string,
  args: string[],
  cwd: string,
  cols: number,
  rows: number,
  env?: Record<string, string>,
) => pty.IPty

function defaultSpawnAgent(
  cmd: string,
  args: string[],
  cwd: string,
  cols: number,
  rows: number,
  env?: Record<string, string>,
): pty.IPty {
  // Hygiene only — NOT a boundary. The scrub strips the daemon-internal env
  // (SLIPSTREAM_TOKEN above all) so a process can't grab it with `printenv`,
  // but the agent PTY runs as the SAME uid as the daemon and can read
  // daemon.json / slipstream.db directly — see agentEnv.ts + SECURITY.md §7.
  const finalEnv = buildAgentEnv(process.env, env)
  // FLO-146: opt-in bwrap containment. When SLIPSTREAM_SANDBOX=bwrap and
  // bwrap is available, this wraps cmd/args so the agent runs in a mount
  // namespace with the data dir overmounted (daemon.json/slipstream.db/
  // secrets hidden); off by default → spec is cmd/args unchanged. See
  // agentSandbox.ts + docs/SECURITY.md §7.
  const spec = sandboxSpawnSpec({ cmd, args, env: finalEnv })
  return pty.spawn(spec.cmd, spec.args, {
    name: 'xterm-color',
    cols,
    rows,
    cwd,
    env: finalEnv,
  })
}

// ─── Internal session record ──────────────────────────────────────────────────

interface SessionRecord {
  pty: pty.IPty
  detector: StatusDetector
  buffer: OutputBuffer
  scrollback: ScrollbackStore | null
  screen: ScreenState
  dto: SessionDTO
  backend: AgentBackend
  disposed?: boolean
  lastActivityAt: number
  // embedded-server backends only (opencode, kilo): server port + session id
  // used for status polling
  opencodePort?: number
  opencodeSid?: string
  pollTimer?: ReturnType<typeof setInterval>
  watcher?: SentinelWatcher
  // Chat tail (TASK-FPH60, claude-code + pi): fs.watch-backed tail on the
  // resolved transcript/session file. Undefined for backends with no file
  // tail (opencode uses the poller below; antigravity/grok/kilo have none).
  chatTail?: ChatTailHandle
  // Opencode chat poll (TASK-FPH60): independent ~3s poll of the embedded
  // server, gated on chatSubscribers being non-empty (see subscribeChat).
  opencodeChatPollTimer?: ReturnType<typeof setInterval>
  opencodeChatSeen?: Set<string>
  chatSubscribers?: Set<string>
  // Episode-scoped "what is the agent asking" message from the most recent
  // status.json sentinel report that carried one (`slipstream request-input`/
  // `approval-request`) — TASK-FPH60 chat question card. Set only alongside a
  // transition INTO 'needs' with a message; cleared on any transition away
  // from 'needs', same convention as pushService's needsSince. See
  // getSessionActivity below.
  activityMessage?: string
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createSessionManager(
  logger?: RunLogger,
  root?: string,
  /** Injectable PTY factory (FLO-132). Defaults to the real pty.spawn; tests
   *  pass a stub so the state machine runs in plain Node without node-pty's
   *  Electron native ABI. */
  spawnAgent: SpawnAgent = defaultSpawnAgent,
): ISessionManager {
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
    const { pty: proc, detector, buffer, scrollback, screen } = rec
    // Poll-driven backends (opencode/kilo's embedded server, pi's session file) are
    // full-screen TUIs whose redraws make PTY-scraped markers unreliable, so
    // their status comes from beginStatusTracking instead of the StatusDetector.
    const ptyDrivenStatus = rec.backend.statusSource === 'pty'
    proc.onData((chunk: string) => {
      rec.lastActivityAt = Date.now()
      const seq = buffer.push(chunk)
      screen.write(chunk, seq)
      if (scrollback) scrollback.append(id, chunk)
      detector.push(chunk)
      emit('data', id, chunk, seq)
      if (ptyDrivenStatus) {
        const s = detector.status()
        rec.dto.status = s
        // Heuristic (non-sentinel) status changes never carry a message —
        // clear any stale one from a prior 'needs' episode so a fresh,
        // report-less 'needs' doesn't surface old text (episode-scoped).
        if (s !== 'needs') rec.activityMessage = undefined
        emit('status', id, s)
      }
    })
    proc.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      if (rec.disposed) return
      teardown(id, rec, { killPty: false })
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
    })
  }

  // ── status polling plumbing ──────────────────────────────────────────────────

  function stopPolling(rec: SessionRecord) {
    if (rec.pollTimer) {
      clearInterval(rec.pollTimer)
      rec.pollTimer = undefined
    }
  }

  /** Single teardown path for a session record: stop polling, close the
   *  sentinel watcher, dispose chat tail/poll, mark disposed, kill the pty
   *  (unless already exited), dispose the screen, and drop it from the map
   *  (only if the map still points at this exact record — a stale onExit for
   *  an id that handoff/attachRemoteControl already replaced must not delete
   *  the new record). */
  function teardown(id: string, rec: SessionRecord, opts: { killPty?: boolean } = {}): void {
    stopPolling(rec)
    rec.watcher?.close()
    rec.watcher = undefined
    disposeChatTail(rec)
    disposeOpencodeChatPoll(rec)
    rec.disposed = true
    if (opts.killPty !== false) {
      try {
        rec.pty.kill()
      } catch {
        /* already gone */
      }
    }
    rec.screen.dispose()
    if (sessions.get(id) === rec) sessions.delete(id)
  }

  // ── Chat tail / poll plumbing (TASK-FPH60, extended to pi + opencode) ─────

  function disposeChatTail(rec: SessionRecord): void {
    rec.chatTail?.dispose()
    rec.chatTail = undefined
  }

  function disposeOpencodeChatPoll(rec: SessionRecord): void {
    if (rec.opencodeChatPollTimer) {
      clearInterval(rec.opencodeChatPollTimer)
      rec.opencodeChatPollTimer = undefined
    }
  }

  /**
   * Tail the Claude Code transcript / pi session file for chat (TASK-FPH60).
   * Both are lazily-resolved, byte-offset-tailed files — the shared mechanism
   * lives in chatTail.ts; only file resolution + line parsing differ here.
   * opencode has no file to tail (see startOpencodeChatPollIfNeeded instead);
   * antigravity/grok/kilo have no chat reader at all.
   */
  function setupChatTail(id: string, rec: SessionRecord, proc: pty.IPty, cwd: string): void {
    if (rec.backend.kind === 'claude-code') {
      rec.chatTail = startChatTail<SessionChatMessageDTO>({
        resolveFile: () => transcriptPathFor(id),
        parse: parseTranscriptMessages,
        onMessage: (msg) => emit('chatMessage', id, msg),
        retryIntervalMs: CHAT_RETRY_INTERVAL_MS,
        retryTimeoutMs: CHAT_RETRY_TIMEOUT_MS,
      })
      proc.onData(() => rec.chatTail?.poke())
      return
    }
    if (rec.backend.kind === 'pi') {
      const sessionDir = piSessionDirFor(cwd)
      rec.chatTail = startChatTail<SessionChatMessageDTO>({
        resolveFile: () => findNewestPiSessionFileSync(sessionDir),
        parse: parsePiChatMessages,
        onMessage: (msg) => emit('chatMessage', id, msg),
        retryIntervalMs: CHAT_RETRY_INTERVAL_MS,
        retryTimeoutMs: CHAT_RETRY_TIMEOUT_MS,
      })
      proc.onData(() => rec.chatTail?.poke())
    }
  }

  /**
   * Independent opencode chat poller (TASK-FPH60): opencode's embedded server
   * has no file to fs.watch, so live chat updates are polled directly, gated
   * on both a captured sid/port AND at least one chat subscriber (subscribers
   * ref-count via subscribeChat/unsubscribeChat below) — a session nobody has
   * a chat view open for doesn't get polled. Deliberately does not touch
   * detector/status state; a fetch failure is swallowed and just retried next
   * tick.
   */
  function startOpencodeChatPollIfNeeded(id: string, rec: SessionRecord): void {
    // Covers opencode AND kilo (an opencode fork with the same embedded
    // server) — both reuse the opencodePort/opencodeSid fields below.
    if (!rec.backend.embeddedServer) return
    if (rec.opencodeChatPollTimer) return // already running
    if (!rec.chatSubscribers || rec.chatSubscribers.size === 0) return
    if (!rec.opencodePort || !rec.opencodeSid) return // sid not captured yet — setOpencodeSid retries this

    const port = rec.opencodePort
    const sid = rec.opencodeSid
    rec.opencodeChatSeen ??= new Set<string>()
    const seen = rec.opencodeChatSeen

    rec.opencodeChatPollTimer = setInterval(() => {
      if (rec.disposed) {
        disposeOpencodeChatPoll(rec)
        return
      }
      void fetchOpencodeMessages(port, sid)
        .then((messages) => {
          if (rec.disposed) return
          for (const msg of opencodeMessagesToChat(messages)) {
            if (seen.has(msg.uuid)) continue
            seen.add(msg.uuid)
            emit('chatMessage', id, msg)
          }
        })
        .catch(() => {
          /* transient — retried next tick */
        })
    }, OPENCODE_CHAT_POLL_MS)
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
    // Resume a resumed agent at the geometry the client last used (persisted
    // by resize()), not an arbitrary default — otherwise the agent's first
    // repaint targets the wrong size and the initial snapshot looks wrong.
    const { cols, rows } = scrollback?.getSize(id) ?? { cols: 80, rows: 30 }
    const screen = new ScreenState(cols, rows)

    trustDirectory(cwd)
    // FLO-104: backend-independent — every agent gets the slipstream CLI skill
    // (canonical .agents/skills + Claude-compat symlink). Best-effort inside.
    writeSlipstreamSkill(cwd)
    backend.prepareWorktree?.(cwd, system)

    // Replay persisted scrollback on resume (not initial start)
    if (!params.isInitialStart && scrollback) {
      const replay = scrollback.read(id)
      if (replay.length > 0) {
        const seq = buffer.push(replay)
        screen.write(replay, seq)
        // Emit replayed data so clients can render it before live stream resumes
        emit('data', id, replay, seq)
      }
    }

    const proc = spawnAgent(spec.cmd, spec.args, cwd, cols, rows, env)

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
      screen,
      dto,
      backend,
      opencodePort: params.opencodePort,
      opencodeSid: params.opencodeSid,
      lastActivityAt: Date.now(),
    }
    sessions.set(id, rec)

    // Watch pr.json/status.json/outcome.json/events.ndjson under this
    // session's sentinel dir (see sentinelWatcher.ts for the fs.watch
    // multiplexer, dedupe cursors, and the pty-vs-poll status merge).
    if (root) {
      const sentinelDir = path.join(root, 'sessions', id)
      const ptyDriven = backend.statusSource === 'pty'
      rec.watcher = createSentinelWatcher(sentinelDir, detector, ptyDriven, {
        onPr: (url) => emit('pr', id, url),
        onOutcome: (outcome) =>
          emit('outcome', id, {
            sessionId: id,
            result: outcome.result,
            summary: outcome.summary,
            details: outcome.details,
            reportedAt: outcome.ts,
          }),
        onAgentEvent: (event) => emit('agentEvent', id, { sessionId: id, ...event }),
        onStatus: (status, meta, activityMessage) => {
          rec.dto.status = status
          rec.activityMessage = activityMessage
          emit('status', id, status, meta)
        },
      })
    }

    wire(id, rec)
    setupChatTail(id, rec, proc, cwd)
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
    })

    // TASK-UQF55: user-supplied extra CLI args are prepended so they land
    // before each backend's trailing positional prompt argument. Parsing
    // throws on an unterminated quote → surfaces as an errored agent run.
    const extra = parseAgentArgs(input.extraArgs)
    const finalSpec = extra.length ? { ...spec, args: [...extra, ...spec.args] } : spec

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
      spec: finalSpec,
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
      hasPriorSession:
        backend.hasPriorSession?.({
          sessionId: id,
          cwd: input.cwd,
          opencodeSid: input.session.opencodeSid,
        }) ?? false,
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
      teardown(id, old)
    }

    const backend = selectBackend(input.session.agentKind)
    const system = input.session.systemPrompt ?? ''
    const spec = backend.buildRemoteControlArgs({
      sessionId: id,
      system,
      user: input.session.prompt,
      opencodeSid: input.session.opencodeSid,
      opencodePort: input.opencodePort,
      hasPriorSession:
        backend.hasPriorSession?.({
          sessionId: id,
          cwd: input.cwd,
          opencodeSid: input.session.opencodeSid,
        }) ?? false,
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
      teardown(id, old)
    }

    const backend = selectBackend(input.agentKind)
    const system = input.session.systemPrompt ?? ''
    const spec = backend.buildHandoffArgs({
      sessionId: id,
      system,
      user: input.handoffPrompt,
      opencodePort: input.opencodePort,
      hasPriorSession:
        backend.hasPriorSession?.({
          sessionId: id,
          cwd: input.cwd,
          opencodeSid: input.session.opencodeSid,
        }) ?? false,
    })

    // The DTO switches to the new backend; opencodeSid is deliberately cleared —
    // it referred to the previous backend's session (a fresh sid is captured by
    // rpc.ts when the new kind is an embedded-server backend — opencode or kilo).
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
    rec.screen.resize(cols, rows)
    rec.scrollback?.setSize(sessionId, cols, rows)
  }

  function kill(sessionId: string): void {
    const rec = sessions.get(sessionId)
    if (!rec) return
    teardown(sessionId, rec)
  }

  function on<E extends keyof SessionEvents>(event: E, listener: SessionEvents[E]): void {
    emitter.on(event, listener as (...args: unknown[]) => void)
  }

  function off<E extends keyof SessionEvents>(event: E, listener: SessionEvents[E]): void {
    emitter.removeListener(event, listener as (...args: unknown[]) => void)
  }

  async function getBuffer(sessionId: string): Promise<{ data: string; seq: number }> {
    const rec = sessions.get(sessionId)
    if (rec) return rec.screen.snapshot()

    // Session not live — try to read persisted scrollback. seq must stay the
    // RAW length (matching the seq domain OutputBuffer seeds on resume-replay)
    // so the client's duplicate-chunk filtering still lines up; a serialized
    // length would be a different, incompatible number.
    if (root) {
      const store = new ScrollbackStore(root)
      const raw = store.read(sessionId)
      if (raw.length === 0) return { data: '', seq: 0 }
      const size = store.getSize(sessionId) ?? { cols: 80, rows: 30 }
      const data = await serializeScrollback(raw, size.cols, size.rows)
      return { data, seq: raw.length }
    }
    return { data: '', seq: 0 }
  }

  function killAll(): void {
    for (const [id, rec] of [...sessions]) {
      teardown(id, rec)
    }
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
    rec.disposed = true // suppress the onExit status/exit emission
    rec.dto.status = 'reaped'
    emit('status', sessionId, 'reaped')
    teardown(sessionId, rec)
  }

  function setOpencodeSid(sessionId: string, sid: string): void {
    const rec = sessions.get(sessionId)
    if (!rec || !rec.opencodePort) return
    rec.opencodeSid = sid
    // Now that the sid is known, ask the backend to begin polling. cwd is only
    // used for lazy sid *recovery* (embeddedServerStatusTracking's `if (!sid)`
    // branch), which never runs here since sid is already known — so '' is safe
    // for both embedded-server backends (opencode, kilo).
    rec.backend.beginStatusTracking?.({
      cwd: '',
      opencodePort: rec.opencodePort,
      opencodeSid: sid,
      isInitialStart: false,
      handle: makeStatusHandle(sessionId, rec),
    })
    // TASK-FPH60: the sid is also what the chat poller needs — start it now if
    // a subscriber was already registered before the sid arrived.
    startOpencodeChatPollIfNeeded(sessionId, rec)
  }

  // ── Chat subscriber ref-counting (TASK-FPH60) ─────────────────────────────

  function getOpencodeState(sessionId: string): { port?: number; sid?: string } | undefined {
    const rec = sessions.get(sessionId)
    if (!rec) return undefined
    return { port: rec.opencodePort, sid: rec.opencodeSid }
  }

  // TASK-FPH60 chat question card: the freshest 'needs'-episode message
  // reported via the status.json sentinel, if any. See SessionRecord.activityMessage.
  function getSessionActivity(sessionId: string): string | undefined {
    return sessions.get(sessionId)?.activityMessage
  }

  function subscribeChat(sessionId: string, clientId: string): void {
    const rec = sessions.get(sessionId)
    if (!rec) return
    rec.chatSubscribers ??= new Set()
    rec.chatSubscribers.add(clientId)
    startOpencodeChatPollIfNeeded(sessionId, rec)
  }

  function unsubscribeChat(sessionId: string, clientId: string): void {
    const rec = sessions.get(sessionId)
    if (!rec?.chatSubscribers) return
    rec.chatSubscribers.delete(clientId)
    if (rec.chatSubscribers.size === 0) disposeOpencodeChatPoll(rec)
  }

  function dropChatClient(clientId: string): void {
    for (const rec of sessions.values()) {
      if (!rec.chatSubscribers?.delete(clientId)) continue
      if (rec.chatSubscribers.size === 0) disposeOpencodeChatPoll(rec)
    }
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
    getOpencodeState,
    subscribeChat,
    unsubscribeChat,
    dropChatClient,
    getSessionActivity,
  }
}

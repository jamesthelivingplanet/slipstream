/**
 * AgentBackend — per-agent adapter that owns how a session is launched.
 *
 * sessionManager no longer branches on agentKind: it selects a backend and
 * delegates argument construction (start / resume / remote-control), the status
 * source (PTY-scraped vs polled), and post-launch status tracking to it. Adding
 * a new backend is a new implementation here + a registry entry — no edits to
 * sessionManager.
 *
 * Pure (no node-pty): unit-testable without Electron's native ABI.
 */
import { existsSync } from 'node:fs'
import * as path from 'node:path'

import type { BackendKind, SessionStatus } from '../shared/contract.js'
import { deliverPrompt, buildAgentsMdContent } from '../shared/promptComposer.js'
import { writeAgentsMd } from './promptWriter.js'
import {
  withOpencodePromptArg,
  fetchOpencodeMessages,
  opencodeStatusFromMessages,
} from './opencodeSessions.js'
import {
  capturePiSessionFile,
  piSessionDirFor,
  readPiSessionFile,
  piStatusFromFileContent,
} from './piSessions.js'
import {
  CLAUDE_BIN,
  OPENCODE_BIN_NAME,
  CLAUDE_FLAGS,
  OPENCODE_FLAGS,
  OPENCODE_STATUS_POLL_MS,
} from '../shared/agentCli.js'

export interface SpawnSpec {
  cmd: string
  args: string[]
}

/** PTY-scraped status (StatusDetector) vs polled (opencode server / pi file). */
export type StatusSource = 'pty' | 'poll'

export interface StartArgsCtx {
  sessionId: string
  system: string
  user: string
  opencodePort?: number
}

export interface ResumeArgsCtx {
  sessionId: string
  system: string
  user: string
  opencodeSid?: string
  opencodePort?: number
  /** Whether a Claude Code transcript already exists for this session id. */
  hasTranscript: boolean
}

/**
 * Manager-provided handle a polling backend uses to report status and register
 * its interval timer — without importing node-pty or touching SessionManager
 * internals. The manager owns dedupe/emit (setStatus) and timer cleanup.
 */
export interface StatusHandle {
  readonly disposed: boolean
  readonly polling: boolean
  setStatus(status: SessionStatus): void
  setPollTimer(timer: ReturnType<typeof setInterval>): void
}

export interface StatusTrackingCtx {
  cwd: string
  opencodePort?: number
  opencodeSid?: string
  /** true on initial start (session id / file may not exist yet); false on
   *  resume / remote-control and on the explicit setOpencodeSid path. */
  isInitialStart: boolean
  handle: StatusHandle
}

export interface AgentBackend {
  readonly kind: BackendKind
  readonly statusSource: StatusSource
  /** Optional pre-spawn worktree setup (e.g. write AGENTS.md). */
  prepareWorktree?(cwd: string, system: string): void
  buildStartArgs(ctx: StartArgsCtx): SpawnSpec
  buildResumeArgs(ctx: ResumeArgsCtx): SpawnSpec
  buildRemoteControlArgs(ctx: ResumeArgsCtx): SpawnSpec
  /** Args for taking over a session started by a DIFFERENT backend (FLO-102).
   *  `user` in the ctx is the composed handoff prompt. */
  buildHandoffArgs(ctx: ResumeArgsCtx): SpawnSpec
  /** Begin polling status after launch (poll backends only; PTY backends omit). */
  beginStatusTracking?(ctx: StatusTrackingCtx): void
}

const OPENCODE_BIN = (() => {
  const local = path.join(process.cwd(), 'node_modules', '.bin', 'opencode')
  return existsSync(local) ? local : OPENCODE_BIN_NAME
})()

const PI_BIN = (() => {
  const local = path.join(process.cwd(), 'node_modules', '.bin', 'pi')
  return existsSync(local) ? local : 'pi'
})()

const PI_STATUS_POLL_MS = 2000
const PI_APPROVE_FLAG = '--approve'
const PI_CONTINUE_FLAG = '--continue'

/** Generic poll loop driven by a status `source`; manager owns timer + emit. */
function runPoll(
  handle: StatusHandle,
  intervalMs: number,
  source: () => Promise<SessionStatus>,
): void {
  if (handle.polling) return
  const tick = async () => {
    if (handle.disposed) return
    const s = await source()
    if (handle.disposed) return
    handle.setStatus(s)
  }
  void tick()
  handle.setPollTimer(setInterval(() => void tick(), intervalMs))
}

function withClaudePromptArg(args: string[], prompt: string | null | undefined): string[] {
  return prompt ? [...args, prompt] : args
}

export const claudeCodeBackend: AgentBackend = {
  kind: 'claude-code',
  statusSource: 'pty',
  buildStartArgs({ sessionId, system, user }) {
    const { systemArgs, userPrompt } = deliverPrompt('claude-code', { system, user })
    const args = withClaudePromptArg(
      [CLAUDE_FLAGS.skipPermissions, ...systemArgs, CLAUDE_FLAGS.sessionId, sessionId],
      userPrompt,
    )
    return { cmd: CLAUDE_BIN, args }
  },
  buildResumeArgs({ sessionId, system, user, hasTranscript }) {
    const { systemArgs, userPrompt } = deliverPrompt('claude-code', { system, user })
    const args = hasTranscript
      ? [CLAUDE_FLAGS.skipPermissions, CLAUDE_FLAGS.resume, sessionId]
      : [CLAUDE_FLAGS.skipPermissions, ...systemArgs, CLAUDE_FLAGS.sessionId, sessionId, userPrompt]
    return { cmd: CLAUDE_BIN, args }
  },
  buildRemoteControlArgs({ sessionId, system, user, hasTranscript }) {
    const { systemArgs, userPrompt } = deliverPrompt('claude-code', { system, user })
    const args = hasTranscript
      ? [CLAUDE_FLAGS.skipPermissions, CLAUDE_FLAGS.remoteControl, CLAUDE_FLAGS.resume, sessionId]
      : [
          CLAUDE_FLAGS.skipPermissions,
          CLAUDE_FLAGS.remoteControl,
          ...systemArgs,
          CLAUDE_FLAGS.sessionId,
          sessionId,
          userPrompt,
        ]
    return { cmd: CLAUDE_BIN, args }
  },
  buildHandoffArgs({ sessionId, system, user, hasTranscript }) {
    const { systemArgs, userPrompt } = deliverPrompt('claude-code', { system, user })
    const args = hasTranscript
      ? [CLAUDE_FLAGS.skipPermissions, CLAUDE_FLAGS.resume, sessionId, userPrompt]
      : [CLAUDE_FLAGS.skipPermissions, ...systemArgs, CLAUDE_FLAGS.sessionId, sessionId, userPrompt]
    return { cmd: CLAUDE_BIN, args }
  },
}

function opencodePortArgs(port?: number): string[] {
  return port ? [OPENCODE_FLAGS.port, String(port)] : []
}

function buildOpencodeResume({ opencodeSid, opencodePort }: ResumeArgsCtx): SpawnSpec {
  const resumeArgs = opencodeSid ? [OPENCODE_FLAGS.session, opencodeSid] : [OPENCODE_FLAGS.continue]
  return {
    cmd: OPENCODE_BIN,
    args: withOpencodePromptArg([...opencodePortArgs(opencodePort), ...resumeArgs], null),
  }
}

export const opencodeBackend: AgentBackend = {
  kind: 'opencode',
  statusSource: 'poll',
  prepareWorktree(cwd, system) {
    // OpenCode reads the system prompt from AGENTS.md (not a CLI arg).
    if (system) writeAgentsMd(cwd, buildAgentsMdContent(system))
  },
  buildStartArgs({ system, user, opencodePort }) {
    const { userPrompt } = deliverPrompt('opencode', { system, user })
    return {
      cmd: OPENCODE_BIN,
      args: withOpencodePromptArg(opencodePortArgs(opencodePort), userPrompt),
    }
  },
  buildResumeArgs(ctx) {
    return buildOpencodeResume(ctx)
  },
  buildRemoteControlArgs(ctx) {
    return buildOpencodeResume(ctx)
  },
  buildHandoffArgs({ system, user, opencodePort }) {
    const { userPrompt } = deliverPrompt('opencode', { system, user })
    return {
      cmd: OPENCODE_BIN,
      args: withOpencodePromptArg(opencodePortArgs(opencodePort), userPrompt),
    }
  },
  beginStatusTracking({ opencodePort, opencodeSid, isInitialStart, handle }) {
    // On initial start the opencode session id is captured asynchronously by the
    // caller (rpc -> setOpencodeSid), which re-invokes tracking with the sid. We
    // only poll once port + sid are both known (resume/remote, or setOpencodeSid).
    if (isInitialStart) return
    if (!opencodePort || !opencodeSid) return
    const port = opencodePort
    const sid = opencodeSid
    runPoll(handle, OPENCODE_STATUS_POLL_MS, async () =>
      opencodeStatusFromMessages(await fetchOpencodeMessages(port, sid)),
    )
  },
}

function withPiPromptArg(args: string[], prompt: string | null | undefined): string[] {
  return prompt ? [...args, prompt] : args
}

export const piBackend: AgentBackend = {
  kind: 'pi',
  statusSource: 'poll',
  buildStartArgs({ system, user }) {
    const { systemArgs, userPrompt } = deliverPrompt('pi', { system, user })
    return { cmd: PI_BIN, args: withPiPromptArg([PI_APPROVE_FLAG, ...systemArgs], userPrompt) }
  },
  buildResumeArgs() {
    return { cmd: PI_BIN, args: [PI_APPROVE_FLAG, PI_CONTINUE_FLAG] }
  },
  buildRemoteControlArgs() {
    return { cmd: PI_BIN, args: [PI_APPROVE_FLAG, PI_CONTINUE_FLAG] }
  },
  buildHandoffArgs({ system, user }) {
    const { systemArgs, userPrompt } = deliverPrompt('pi', { system, user })
    return { cmd: PI_BIN, args: withPiPromptArg([PI_APPROVE_FLAG, ...systemArgs], userPrompt) }
  },
  beginStatusTracking({ cwd, handle }) {
    // Pi writes its session as a JSONL file under ~/.pi/...; the file may not
    // exist for a few hundred ms after spawn, so discover it (async) then poll.
    void capturePiSessionFile(piSessionDirFor(cwd)).then((file) => {
      if (handle.disposed || !file) return
      runPoll(handle, PI_STATUS_POLL_MS, async () =>
        piStatusFromFileContent(await readPiSessionFile(file)),
      )
    })
  },
}

const BACKENDS: Record<BackendKind, AgentBackend> = {
  'claude-code': claudeCodeBackend,
  opencode: opencodeBackend,
  pi: piBackend,
}

/** Select the backend for a session's agentKind; defaults to claude-code. */
export function selectBackend(kind?: BackendKind): AgentBackend {
  return BACKENDS[kind ?? 'claude-code'] ?? claudeCodeBackend
}

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
import { writeAgentsMd, writeOpencodeConfig } from './promptWriter.js'
import { hasTranscript } from './transcripts.js'
import {
  withOpencodePromptArg,
  fetchOpencodeMessages,
  opencodeStatusFromMessages,
  queryOpencodeSessionIdFromCli,
} from './opencodeSessions.js'
import {
  findNewestPiSessionFile,
  hasPiSessionFileSync,
  piSessionDirFor,
  readPiSessionFile,
  piStatusFromFileContent,
} from './piSessions.js'
import {
  CLAUDE_BIN,
  OPENCODE_BIN_NAME,
  ANTIGRAVITY_BIN,
  GROK_BIN_NAME,
  CLAUDE_FLAGS,
  OPENCODE_FLAGS,
  ANTIGRAVITY_FLAGS,
  GROK_FLAGS,
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
  /** Whether the backend has prior resumable state for this session — Claude
   *  transcript / captured opencode sid / pi session file. */
  hasPriorSession: boolean
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
  /** Whether this backend has prior resumable state for a session (used by
   *  sessionManager to decide resume/remote-control fallback to a fresh
   *  start). Sync — implementations do cheap fs checks only. */
  hasPriorSession?(ctx: { sessionId: string; cwd: string; opencodeSid?: string }): boolean
}

const OPENCODE_BIN = (() => {
  const local = path.join(process.cwd(), 'node_modules', '.bin', 'opencode')
  return existsSync(local) ? local : OPENCODE_BIN_NAME
})()

const PI_BIN = (() => {
  const local = path.join(process.cwd(), 'node_modules', '.bin', 'pi')
  return existsSync(local) ? local : 'pi'
})()

const GROK_BIN = (() => {
  const local = path.join(process.cwd(), 'node_modules', '.bin', 'grok')
  return existsSync(local) ? local : GROK_BIN_NAME
})()

const PI_STATUS_POLL_MS = 2000
const PI_APPROVE_FLAG = '--approve'
const PI_CONTINUE_FLAG = '--continue'

/**
 * Generic poll loop driven by a status `source`; manager owns timer + emit.
 * `source` returning null means "no signal this tick" (e.g. the underlying
 * session file / id hasn't been discovered yet) — skipped rather than
 * reported, so status never flips based on absence of data.
 */
function runPoll(
  handle: StatusHandle,
  intervalMs: number,
  source: () => Promise<SessionStatus | null>,
): void {
  if (handle.polling) return
  const tick = async () => {
    if (handle.disposed) return
    const s = await source()
    if (handle.disposed || s === null) return
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
  buildResumeArgs({ sessionId, system, user, hasPriorSession }) {
    const { systemArgs, userPrompt } = deliverPrompt('claude-code', { system, user })
    const args = hasPriorSession
      ? [CLAUDE_FLAGS.skipPermissions, CLAUDE_FLAGS.resume, sessionId]
      : [CLAUDE_FLAGS.skipPermissions, ...systemArgs, CLAUDE_FLAGS.sessionId, sessionId, userPrompt]
    return { cmd: CLAUDE_BIN, args }
  },
  buildRemoteControlArgs({ sessionId, system, user, hasPriorSession }) {
    const { systemArgs, userPrompt } = deliverPrompt('claude-code', { system, user })
    const args = hasPriorSession
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
  buildHandoffArgs({ sessionId, system, user, hasPriorSession }) {
    const { systemArgs, userPrompt } = deliverPrompt('claude-code', { system, user })
    const args = hasPriorSession
      ? [CLAUDE_FLAGS.skipPermissions, CLAUDE_FLAGS.resume, sessionId, userPrompt]
      : [CLAUDE_FLAGS.skipPermissions, ...systemArgs, CLAUDE_FLAGS.sessionId, sessionId, userPrompt]
    return { cmd: CLAUDE_BIN, args }
  },
  hasPriorSession(ctx) {
    return hasTranscript(ctx.sessionId)
  },
}

function opencodePortArgs(port?: number): string[] {
  return port ? [OPENCODE_FLAGS.port, String(port)] : []
}

/** Fresh-start-style opencode args (system prompt via AGENTS.md, prompt sent
 *  via `--prompt`). Used both by buildStartArgs and by the resume/remote
 *  fallback when there's no captured opencode sid to continue. */
function buildOpencodeFreshStart({
  system,
  user,
  opencodePort,
}: {
  system: string
  user: string
  opencodePort?: number
}): SpawnSpec {
  const { userPrompt } = deliverPrompt('opencode', { system, user })
  return {
    cmd: OPENCODE_BIN,
    args: withOpencodePromptArg(opencodePortArgs(opencodePort), userPrompt),
  }
}

function buildOpencodeResume(ctx: ResumeArgsCtx): SpawnSpec {
  const { opencodeSid, opencodePort, hasPriorSession, system, user } = ctx
  // No captured sid to continue (capture failed / crashed pre-first-message)
  // — degrade to a fresh start instead of blindly passing --continue, which
  // would misbehave with nothing to continue.
  if (!hasPriorSession) return buildOpencodeFreshStart({ system, user, opencodePort })
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
    // OpenCode has no CLI permission-bypass flag; config is the only
    // supported mechanism (see writeOpencodeConfig). Written even when
    // `system` is empty — runs should never stall on permission prompts.
    writeOpencodeConfig(cwd)
  },
  buildStartArgs({ system, user, opencodePort }) {
    return buildOpencodeFreshStart({ system, user, opencodePort })
  },
  buildResumeArgs(ctx) {
    return buildOpencodeResume(ctx)
  },
  buildRemoteControlArgs(ctx) {
    return buildOpencodeResume(ctx)
  },
  buildHandoffArgs({ system, user, opencodePort }) {
    return buildOpencodeFreshStart({ system, user, opencodePort })
  },
  hasPriorSession(ctx) {
    return !!ctx.opencodeSid
  },
  beginStatusTracking({ cwd, opencodePort, opencodeSid, isInitialStart, handle }) {
    // On initial start the opencode session id is captured asynchronously by the
    // caller (rpc -> setOpencodeSid), which re-invokes tracking with the sid. We
    // only poll once the port is known (resume/remote, or setOpencodeSid).
    if (isInitialStart) return
    if (!opencodePort) return
    const port = opencodePort
    // Lazy sid discovery: if resume/remote-control launched without a
    // captured sid (e.g. a prior capture raced/failed), keep trying once per
    // tick instead of never polling at all.
    let sid = opencodeSid
    runPoll(handle, OPENCODE_STATUS_POLL_MS, async () => {
      if (!sid) {
        const discovered = await queryOpencodeSessionIdFromCli(cwd)
        if (!discovered) return null
        sid = discovered
      }
      return opencodeStatusFromMessages(await fetchOpencodeMessages(port, sid))
    })
  },
}

function withPiPromptArg(args: string[], prompt: string | null | undefined): string[] {
  return prompt ? [...args, prompt] : args
}

/** Fresh-start-style pi args (re-delivers system + user prompt). Used both by
 *  buildStartArgs and by the resume/remote fallback when there's no prior
 *  session file to continue. */
function buildPiFreshStart({ system, user }: { system: string; user: string }): SpawnSpec {
  const { systemArgs, userPrompt } = deliverPrompt('pi', { system, user })
  return { cmd: PI_BIN, args: withPiPromptArg([PI_APPROVE_FLAG, ...systemArgs], userPrompt) }
}

export const piBackend: AgentBackend = {
  kind: 'pi',
  statusSource: 'poll',
  buildStartArgs(ctx) {
    return buildPiFreshStart(ctx)
  },
  buildResumeArgs(ctx) {
    // No captured session file to continue (capture failed / crashed before
    // the first message) — degrade to a fresh start instead of blindly
    // passing --continue, which would misbehave with nothing to continue.
    if (!ctx.hasPriorSession) return buildPiFreshStart(ctx)
    return { cmd: PI_BIN, args: [PI_APPROVE_FLAG, PI_CONTINUE_FLAG] }
  },
  buildRemoteControlArgs(ctx) {
    if (!ctx.hasPriorSession) return buildPiFreshStart(ctx)
    return { cmd: PI_BIN, args: [PI_APPROVE_FLAG, PI_CONTINUE_FLAG] }
  },
  buildHandoffArgs(ctx) {
    return buildPiFreshStart(ctx)
  },
  hasPriorSession(ctx) {
    return hasPiSessionFileSync(ctx.cwd)
  },
  beginStatusTracking({ cwd, handle }) {
    // Pi writes its session as a JSONL file under ~/.pi/...; the file may not
    // exist for a few hundred ms after spawn (or capture may simply never
    // have found it), so poll immediately with a lazy, per-tick one-shot
    // discovery instead of a one-time bounded retry that can miss forever.
    let file: string | null = null
    runPoll(handle, PI_STATUS_POLL_MS, async () => {
      if (!file) {
        const discovered = await findNewestPiSessionFile(piSessionDirFor(cwd))
        if (!discovered) return null
        file = discovered
      }
      return piStatusFromFileContent(await readPiSessionFile(file))
    })
  },
}

function withAntigravityPromptArg(args: string[], prompt: string | null | undefined): string[] {
  // agy's -i/--prompt-interactive takes the prompt as its argument; omit the
  // pair entirely rather than pass an empty prompt.
  return prompt ? [...args, ANTIGRAVITY_FLAGS.promptInteractive, prompt] : args
}

/** Fresh-start-style antigravity args. System prompt is delivered via
 *  AGENTS.md (prepareWorktree), so this only ever carries the skip-permissions
 *  flag plus, when present, the -i/prompt pair. Used both by buildStartArgs
 *  and by the resume/remote fallback when there's no prior session to continue. */
function buildAntigravityFreshStart({ system, user }: { system: string; user: string }): SpawnSpec {
  const { userPrompt } = deliverPrompt('antigravity', { system, user })
  return {
    cmd: ANTIGRAVITY_BIN,
    args: withAntigravityPromptArg([ANTIGRAVITY_FLAGS.skipPermissions], userPrompt),
  }
}

export const antigravityBackend: AgentBackend = {
  kind: 'antigravity',
  statusSource: 'pty', // a Gemini-CLI-derived scrolling terminal, like Claude Code — not an alternate-screen TUI.
  prepareWorktree(cwd, system) {
    // agy auto-discovers AGENTS.md (and GEMINI.md) in the worktree as context;
    // there is no CLI flag to deliver a system prompt.
    if (system) writeAgentsMd(cwd, buildAgentsMdContent(system))
  },
  buildStartArgs(ctx) {
    return buildAntigravityFreshStart(ctx)
  },
  buildResumeArgs(ctx) {
    // Remote control is a Claude-only concept (the UI hides the Remote
    // Control button for non-claude kinds) — this is a plain resume.
    if (!ctx.hasPriorSession) return buildAntigravityFreshStart(ctx)
    return {
      cmd: ANTIGRAVITY_BIN,
      args: [ANTIGRAVITY_FLAGS.skipPermissions, ANTIGRAVITY_FLAGS.continue],
    }
  },
  buildRemoteControlArgs(ctx) {
    if (!ctx.hasPriorSession) return buildAntigravityFreshStart(ctx)
    return {
      cmd: ANTIGRAVITY_BIN,
      args: [ANTIGRAVITY_FLAGS.skipPermissions, ANTIGRAVITY_FLAGS.continue],
    }
  },
  buildHandoffArgs(ctx) {
    return buildAntigravityFreshStart(ctx)
  },
  hasPriorSession() {
    // agy conversations are cwd-scoped and its on-disk store is undocumented,
    // so there is no cheap disk check available. --continue on an empty
    // worktree degrades to opening the TUI fresh, which is benign (unlike
    // claude's --resume, which errors outright on a missing transcript).
    return true
  },
}

/** Fresh-start-style grok args: the user prompt is a bare positional arg in
 *  interactive mode; the system prompt is delivered via AGENTS.md
 *  (prepareWorktree), and grok has no permission-bypass flag to pass. Used
 *  both by buildStartArgs and by the resume/remote fallback when there's no
 *  prior session to continue. */
function buildGrokFreshStart({ system, user }: { system: string; user: string }): SpawnSpec {
  const { userPrompt } = deliverPrompt('grok', { system, user })
  return { cmd: GROK_BIN, args: userPrompt ? [userPrompt] : [] }
}

export const grokBackend: AgentBackend = {
  kind: 'grok',
  statusSource: 'poll', // a full-screen OpenTUI app — PTY scraping is unreliable.
  prepareWorktree(cwd, system) {
    // grok merges AGENTS.md from the git root into its system prompt; there
    // is no permission config (grok has no bypass flag or documented
    // permission file — tool execution is trust-based).
    if (system) writeAgentsMd(cwd, buildAgentsMdContent(system))
  },
  buildStartArgs(ctx) {
    return buildGrokFreshStart(ctx)
  },
  buildResumeArgs(ctx) {
    if (!ctx.hasPriorSession) return buildGrokFreshStart(ctx)
    return { cmd: GROK_BIN, args: [GROK_FLAGS.session, 'latest'] }
  },
  buildRemoteControlArgs(ctx) {
    if (!ctx.hasPriorSession) return buildGrokFreshStart(ctx)
    return { cmd: GROK_BIN, args: [GROK_FLAGS.session, 'latest'] }
  },
  buildHandoffArgs(ctx) {
    return buildGrokFreshStart(ctx)
  },
  hasPriorSession() {
    // Same rationale as antigravity: grok's session-store format is
    // undocumented, so there's no cheap disk check. 'latest' scoping is per
    // grok's own store, so a degrade-to-fresh-start on an empty worktree is
    // benign.
    return true
  },
  // No beginStatusTracking: grok's session-store format is undocumented, so
  // there is no data source to poll. Status is driven exclusively by the
  // slipstream CLI status.json sentinel, which sessionManager already applies
  // directly for poll backends that report no signal of their own.
}

const BACKENDS: Record<BackendKind, AgentBackend> = {
  'claude-code': claudeCodeBackend,
  opencode: opencodeBackend,
  pi: piBackend,
  antigravity: antigravityBackend,
  grok: grokBackend,
}

/** Select the backend for a session's agentKind; defaults to claude-code. */
export function selectBackend(kind?: BackendKind): AgentBackend {
  return BACKENDS[kind ?? 'claude-code'] ?? claudeCodeBackend
}

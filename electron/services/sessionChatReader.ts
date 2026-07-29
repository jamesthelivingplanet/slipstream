/**
 * sessionChatReader.ts — best-effort per-backend reader for a session's chat
 * messages.
 *
 * The Chat panel (rpcHandlers/chat.ts) reads a session's conversation so it
 * can render it alongside the terminal. The handoff path (rpcHandlers/
 * sessions.ts → buildHandoffPrompt) needs the SAME per-backend dispatch so it
 * can hand the new agent the prior agent's conversation as context. This
 * module is the shared, single source of truth for that dispatch so the two
 * callers can't drift (same lesson as FLO-118's resume-procedure extraction).
 *
 * Never throws: a missing/transient source (no transcript yet, embedded
 * server unreachable, repo path unresolvable) resolves to `{ available, [] }`
 * rather than failing the caller — a handoff must never abort just because the
 * prior agent's chat couldn't be recovered.
 *
 * claude-code additionally merges in each subagent's (Task/Agent-tool) own
 * transcript file — see `readSubagentMessages` below — so the chat view can
 * show delegated work instead of a black box between "Delegated: ..." and
 * the result.
 *
 * opencode-family backends have two sources, tried in order: the embedded
 * TUI server's live in-memory state (freshest, but gone once the process
 * exits or the daemon restarts), then opencode's own durable SQLite store
 * (opencodeStore.ts) keyed by the persisted `session.opencodeSid`. Without
 * the fallback, an opencode session's ENTIRE chat history would vanish the
 * moment its process wasn't live to ask — unlike claude-code (JSONL
 * transcript) and pi (session file), which were always durable.
 *
 * grok also has a durable reader (grokStore.ts), but only the one source: no
 * embedded server to prefer, and no persisted `session.grokSid` to key off
 * of, so it selects the newest session for the worktree instead — cwd-scoped
 * like pi's reader, just backed by grok's own SQLite store instead of a
 * session file. antigravity remains the only backend with no reader at all.
 */
import fs from 'node:fs'

import type {
  BackendKind,
  IRepoRegistry,
  ISessionManager,
  IWorktreeManager,
  RepoDTO,
  SessionChatMessageDTO,
  SessionDTO,
} from '../shared/contract.js'
import { usesEmbeddedServer } from './agentBackend.js'
import { transcriptPathFor, subagentTranscriptFiles } from './transcripts.js'
import { parseTranscriptMessages } from './transcriptMessages.js'
import { parsePiChatMessages } from './piChatMessages.js'
import { findNewestPiSessionFile, piSessionDirFor, readPiSessionFile } from './piSessions.js'
import { fetchOpencodeMessages, opencodeMessagesToChat } from './opencodeSessions.js'
import { opencodeDbPath, readOpencodeMessagesFromStore } from './opencodeStore.js'
import { grokDbPath, readGrokMessagesFromStore } from './grokStore.js'

export interface ChatReaderDeps {
  /** Resolve a repo to read its worktree cwd (pi's reader is cwd-scoped). */
  repos: Pick<IRepoRegistry, 'resolvePath'>
  /** Map a repo+branch to its worktree path (pi's reader is cwd-scoped). */
  worktrees: Pick<IWorktreeManager, 'pathFor'>
  /** Live embedded-server port/sid for an opencode-family session. */
  sessions: Pick<ISessionManager, 'getOpencodeState'>
  /** Override for opencode's durable SQLite store path (opencodeDbPath() by
   *  default) — tests point this at a temp fixture instead of the real
   *  per-machine store. Not part of any live-process dep, so it's a plain
   *  optional field rather than threaded through an interface. */
  opencodeDbPath?: string
  /** Override for grok's durable SQLite store path (grokDbPath() by
   *  default) — tests point this at a temp fixture instead of the real
   *  per-machine store. Not part of any live-process dep, so it's a plain
   *  optional field rather than threaded through an interface. */
  grokDbPath?: string
}

export interface ChatReadResult {
  /** false when this backend has no chat reader at all (antigravity) OR
   *  the reader's source can't be found right now; true once messages are
   *  recoverable. Callers that distinguish "no reader" from "empty" (the Chat
   *  panel's `available` flag) read this; callers that only want the messages
   *  (the handoff prompt) can ignore it. */
  available: boolean
  messages: SessionChatMessageDTO[]
}

/** Read a session's full (unpaged) chat history, oldest first, for whatever
 *  backend ran it (per `session.agentKind`). Best-effort — never throws. */
export async function readSessionChat(
  deps: ChatReaderDeps,
  session: SessionDTO,
): Promise<ChatReadResult> {
  const kind: BackendKind = session.agentKind ?? 'claude-code'

  if (kind === 'claude-code') {
    const file = transcriptPathFor(session.id)
    if (!file) return { available: false, messages: [] }
    let messages: SessionChatMessageDTO[]
    try {
      const raw = await fs.promises.readFile(file, 'utf8')
      messages = parseTranscriptMessages(raw)
    } catch {
      return { available: false, messages: [] }
    }
    const subagentMessages = await readSubagentMessages(session.id)
    if (subagentMessages.length > 0) {
      messages = [...messages, ...subagentMessages].sort((a, b) => a.ts - b.ts)
    }
    return { available: true, messages }
  }

  if (kind === 'pi') {
    let repo: RepoDTO
    try {
      repo = await deps.repos.resolvePath(session.repoId)
    } catch {
      return { available: false, messages: [] }
    }
    const cwd = deps.worktrees.pathFor(repo, session.branch)
    const file = await findNewestPiSessionFile(piSessionDirFor(cwd))
    if (!file) return { available: false, messages: [] }
    const raw = await readPiSessionFile(file)
    return { available: true, messages: parsePiChatMessages(raw) }
  }

  if (usesEmbeddedServer(kind)) {
    // Prefer the live embedded server — freshest, and the only source for a
    // brand-new session that hasn't been persisted to opencode's durable
    // store yet. An empty result here is a legitimate "no messages sent yet"
    // outcome, not a failure, so it still reports available:true.
    const state = deps.sessions.getOpencodeState?.(session.id)
    if (state?.port && state.sid) {
      const raw = await fetchOpencodeMessages(state.port, state.sid)
      return { available: true, messages: opencodeMessagesToChat(raw) }
    }
    // No live port/sid — the opencode process exited, or the daemon
    // restarted and wiped in-memory session state. Fall back to opencode's
    // own durable SQLite store keyed by the sid Slipstream persisted
    // alongside the session row (session.opencodeSid), so history recovered
    // this way survives exactly the restarts the live path can't.
    if (!session.opencodeSid) return { available: false, messages: [] }
    const raw = readOpencodeMessagesFromStore(
      session.opencodeSid,
      deps.opencodeDbPath ?? opencodeDbPath(),
    )
    const messages = opencodeMessagesToChat(raw)
    if (messages.length === 0) return { available: false, messages: [] }
    return { available: true, messages }
  }

  if (kind === 'grok') {
    let repo: RepoDTO
    try {
      repo = await deps.repos.resolvePath(session.repoId)
    } catch {
      return { available: false, messages: [] }
    }
    const cwd = deps.worktrees.pathFor(repo, session.branch)
    const messages = readGrokMessagesFromStore(cwd, deps.grokDbPath ?? grokDbPath())
    if (messages.length === 0) return { available: false, messages: [] }
    return { available: true, messages }
  }

  // antigravity: no chat reader — terminal-only backend.
  return { available: false, messages: [] }
}

/**
 * Read and merge a claude-code session's subagent (Task/Agent-tool)
 * transcripts — each lives in its own `<sessionId>/subagents/agent-
 * <agentId>.jsonl` file, sibling to the main transcript (`transcripts.ts`'s
 * `subagentTranscriptFiles`), never inline in the main transcript itself.
 * Best-effort like the rest of this module: no subagents dir, or any one
 * subagent file failing to read/parse, just means fewer/no extra messages —
 * never throws, and never affects whether the main transcript is returned.
 *
 * Grouping: EVERY message parsed from one subagent file gets `sidechainId`
 * stamped to that file's `agentId` (the filename's `agent-<agentId>.jsonl`
 * segment) — this is the reliable grouping key a consumer (rpcHandlers/
 * chat.ts's `groupSidechainsByMainThreadAnchor`) should use to treat a whole
 * subagent run as one unit, because `parentUuid` chain-walking can't: a
 * dropped unrenderable line (transcriptMessages.ts's `parseLine` returns
 * null for one) breaks the chain at that point in EVERY real transcript file
 * measured on this machine (2-3 fragments per file), fragmenting one
 * subagent into multiple disconnected chains. `sidechainId` doesn't have
 * that failure mode since it's stamped per-message from the filename, not
 * derived from the chain.
 *
 * Threading: each subagent file's sibling `.meta.json` (best-effort, may be
 * absent) carries `toolUseId` — the id of the `Agent` tool_use that spawned
 * it — verified against real transcripts on this machine (242/243
 * directly-spawned subagents resolve cleanly to a same-session `Agent`
 * tool_use id; the one miss is a session whose main transcript no longer
 * contains that turn) — plus `description`/`agentType`. `promptId` and
 * `agentId` were also checked and rejected as the threading key: `promptId`
 * is shared by every subagent spawned from the same user turn (not 1:1 with
 * a specific Agent call), and `agentId` never appears in the main transcript
 * at all. When present, `toolUseId`/`description`/`agentType` are stamped as
 * `sidechainToolUseId`/`sidechainDescription`/`sidechainAgentType` on EVERY
 * message of the file (same per-message spread as `sidechainId`) so a
 * consumer doesn't have to special-case the root line to find them.
 * `toolUseId` is ADDITIONALLY stamped onto the subagent's ROOT message's
 * `parentUuid` (left unset by the parser for a chain's first line, since its
 * raw `parentUuid` is `null`) — kept for back-compat with other code that
 * still reads `parentUuid` directly. A subagent spawned by ANOTHER subagent
 * (nested Task spawn, `spawnDepth` > 1 in the meta file) has no match in the
 * main transcript — it still merges in `ts` order and carries `isSidechain:
 * true`, just without a `parentUuid` link (its `sidechainToolUseId`, if any,
 * instead points at a tool_use inside the ANCESTOR subagent's transcript).
 */
async function readSubagentMessages(sessionId: string): Promise<SessionChatMessageDTO[]> {
  const files = subagentTranscriptFiles(sessionId)
  const all: SessionChatMessageDTO[] = []
  for (const file of files) {
    let raw: string
    try {
      raw = await fs.promises.readFile(file.jsonlPath, 'utf8')
    } catch {
      continue
    }
    let messages = parseTranscriptMessages(raw)
    if (messages.length === 0) continue
    const meta = file.metaPath ? await readSubagentMeta(file.metaPath) : null
    if (meta?.toolUseId && messages[0].parentUuid === undefined) {
      messages[0] = { ...messages[0], parentUuid: meta.toolUseId }
    }
    // Stamp the grouping id (and, best-effort, the meta fields) on EVERY
    // message of this file — not just the root — so a consumer can group by
    // sidechainId alone without also having to chain-walk to find them.
    messages = messages.map((m) => ({
      ...m,
      sidechainId: file.agentId,
      ...(meta?.toolUseId ? { sidechainToolUseId: meta.toolUseId } : {}),
      ...(meta?.description ? { sidechainDescription: meta.description } : {}),
      ...(meta?.agentType ? { sidechainAgentType: meta.agentType } : {}),
    }))
    all.push(...messages)
  }
  return all
}

/** Best-effort per-field parse of a subagent's `.meta.json` — `toolUseId`
 *  (the id of the `Agent` tool_use that spawned it), `description`, and
 *  `agentType`. Each field is independently optional; returns nulls (never
 *  throws) on any read/parse failure or when a field is missing/not a
 *  string. */
async function readSubagentMeta(
  metaPath: string,
): Promise<{ toolUseId: string | null; description: string | null; agentType: string | null }> {
  const empty = { toolUseId: null, description: null, agentType: null }
  try {
    const raw = await fs.promises.readFile(metaPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return empty
    const obj = parsed as Record<string, unknown>
    const str = (key: string): string | null => {
      const v = obj[key]
      return typeof v === 'string' && v ? v : null
    }
    return {
      toolUseId: str('toolUseId'),
      description: str('description'),
      agentType: str('agentType'),
    }
  } catch {
    return empty
  }
}

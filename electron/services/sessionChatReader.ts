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
import { transcriptPathFor } from './transcripts.js'
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
    try {
      const raw = await fs.promises.readFile(file, 'utf8')
      return { available: true, messages: parseTranscriptMessages(raw) }
    } catch {
      return { available: false, messages: [] }
    }
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

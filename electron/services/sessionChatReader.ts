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

export interface ChatReaderDeps {
  /** Resolve a repo to read its worktree cwd (pi's reader is cwd-scoped). */
  repos: Pick<IRepoRegistry, 'resolvePath'>
  /** Map a repo+branch to its worktree path (pi's reader is cwd-scoped). */
  worktrees: Pick<IWorktreeManager, 'pathFor'>
  /** Live embedded-server port/sid for an opencode-family session. */
  sessions: Pick<ISessionManager, 'getOpencodeState'>
}

export interface ChatReadResult {
  /** false when this backend has no chat reader at all (antigravity/grok) OR
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
    const state = deps.sessions.getOpencodeState?.(session.id)
    if (!state?.port || !state.sid) return { available: false, messages: [] }
    const raw = await fetchOpencodeMessages(state.port, state.sid)
    return { available: true, messages: opencodeMessagesToChat(raw) }
  }

  // antigravity/grok: no chat reader — terminal-only backends.
  return { available: false, messages: [] }
}

import type { IpcDeps } from '../../ipc.js'
import { IPC } from '../../shared/contract.js'
import type { SessionChatMessageDTO } from '../../shared/contract.js'
import { readSessionChat } from '../../services/sessionChatReader.js'
import { listAgentSkillsFor } from '../../services/agentSkills.js'
import { extractScreenQuestion } from '../../services/chatQuestion.js'
import type { RpcContext } from '../rpcContext.js'
import { makeCwdForSession } from './cwdForSession.js'
import type { ChannelHandlerMap } from './types.js'

/** Shared paging for getChatMessages across every backend (TASK-FPH60):
 *  `beforeTs` filters to strictly-older messages (pagination cursor), `limit`
 *  (default 50) caps to the most recent page after that filter. */
function pageChatMessages(
  messages: SessionChatMessageDTO[],
  opts: { beforeTs?: number; limit?: number },
): SessionChatMessageDTO[] {
  let out = messages
  if (opts.beforeTs !== undefined) {
    out = out.filter((m) => m.ts < opts.beforeTs!)
  }
  const limit = opts.limit ?? 50
  if (out.length > limit) out = out.slice(-limit)
  return out
}

export function createChatHandlers(deps: IpcDeps, ctx: RpcContext): ChannelHandlerMap {
  const { clientId, ownedSession, resolveOutcome } = ctx

  return {
    [IPC.getSessionOutcome]: async (args) => {
      const id = args[0] as string
      // Owner-scoped: a missing OR other-owner session surfaces the same
      // "not found" so an outcome can't leak across owners.
      if (!ownedSession(id)) throw new Error(`Session not found: ${id}`)
      return resolveOutcome(id)
    },

    [IPC.listSessionAgentEvents]: async (args) => {
      const id = args[0] as string
      // Owner-scoped like getSessionOutcome: missing and other-owner rows
      // surface the same "not found".
      if (!ownedSession(id)) throw new Error(`Session not found: ${id}`)
      return deps.agentEventStore?.list(id) ?? []
    },

    [IPC.getChatMessages]: async (args) => {
      const id = args[0] as string
      const opts = (args[1] as { beforeTs?: number; limit?: number } | undefined) ?? {}
      // Owner-scoped like getSessionOutcome/listSessionAgentEvents: missing
      // and other-owner rows surface the same "not found".
      const session = ownedSession(id)
      if (!session) throw new Error(`Session not found: ${id}`)

      // The per-backend dispatch (claude transcript / pi session file /
      // opencode embedded server / antigravity+grok none) lives once in
      // sessionChatReader so this handler and the handoff path can't drift —
      // paging is layered on top here.
      const { available, messages } = await readSessionChat(deps, session)
      return { available, messages: pageChatMessages(messages, opts) }
    },

    [IPC.subscribeChat]: async (args) => {
      const id = args[0] as string
      if (!ownedSession(id)) return undefined
      deps.sessions.subscribeChat?.(id, clientId)
      return undefined
    },

    [IPC.unsubscribeChat]: async (args) => {
      const id = args[0] as string
      if (!ownedSession(id)) return undefined
      deps.sessions.unsubscribeChat?.(id, clientId)
      return undefined
    },

    [IPC.listAgentSkills]: async (args) => {
      const id = args[0] as string
      const session = ownedSession(id)
      if (!session) throw new Error(`Session not found: ${id}`)
      const cwdForSession = makeCwdForSession(deps)
      const cwd = await cwdForSession(session)
      if (!cwd) return []
      return listAgentSkillsFor(session.agentKind, cwd)
    },

    [IPC.getChatQuestion]: async (args) => {
      const id = args[0] as string
      // Owner-scoped like getChatMessages/listAgentSkills: missing and
      // other-owner rows surface the same "not found".
      const session = ownedSession(id)
      if (!session) throw new Error(`Session not found: ${id}`)
      if (session.status !== 'needs') return null

      // Prefer the agent's own report (status.json sentinel message) when
      // fresh — see sessionManager's getSessionActivity/activityMessage.
      const agentMsg = deps.sessions.getSessionActivity?.(id)
      if (agentMsg) return { text: agentMsg, source: 'agent' }

      // Fall back to the live headless-screen mirror — covers interactive
      // permission prompts, where the agent process is frozen and reports
      // nothing. Only for a LIVE session: getBuffer() falls back to
      // persisted scrollback for a dead one, which isn't a "screen".
      if (!deps.sessions.has(id)) return null
      const { data } = await deps.sessions.getBuffer(id)
      const excerpt = extractScreenQuestion(data)
      if (!excerpt) return null
      return { text: excerpt, source: 'screen' }
    },

    [IPC.sessionPrStatus]: async (args) => {
      const id = args[0] as string
      // Owner-scoped: a missing OR other-owner session surfaces the same
      // "not found" so PR status can't leak across owners.
      const s = ownedSession(id)
      if (!s) throw new Error(`Session not found: ${id}`)
      if (!deps.prStatus || !s.prUrl) return null
      return deps.prStatus.get(s)
    },
  }
}

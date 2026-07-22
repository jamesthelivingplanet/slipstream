import type { IpcDeps } from '../../ipc.js'
import { IPC } from '../../shared/contract.js'
import type { SessionHistoryEntry } from '../../shared/contract.js'
import { readSessionUsage, buildUsageSummary } from '../../services/usage.js'
import type { RpcContext } from '../rpcContext.js'
import { makeCwdForSession } from './cwdForSession.js'
import type { ChannelHandlerMap } from './types.js'

export function createUsageHandlers(deps: IpcDeps, ctx: RpcContext): ChannelHandlerMap {
  const { ownedByCaller, ownedSession, resolveOutcome } = ctx

  return {
    [IPC.sessionUsage]: async (args) => {
      const id = args[0] as string
      // Owner-scoped: a missing OR other-owner session surfaces the same
      // "not found" so usage can't leak across owners.
      const session = ownedSession(id)
      if (!session) throw new Error(`Session not found: ${id}`)
      const cwdForSession = makeCwdForSession(deps)
      const cwd = session.agentKind === 'pi' ? await cwdForSession(session) : null
      return await readSessionUsage(session, { cwd })
    },

    [IPC.usageSummary]: async () => {
      const list = deps.sessionStore.list().filter(ownedByCaller)
      const cwdForSession = makeCwdForSession(deps)
      const cwds = new Map<string, string | null>()
      await Promise.all(
        list
          .filter((s) => s.agentKind === 'pi')
          .map(async (s) => {
            cwds.set(s.id, await cwdForSession(s))
          }),
      )
      return await buildUsageSummary(list, { cwdFor: (s) => cwds.get(s.id) ?? null })
    },

    [IPC.listSessionHistory]: async () => {
      const sessions = deps.sessionStore.list().filter(ownedByCaller)
      sessions.sort((a, b) => b.createdAt - a.createdAt)
      const cwdForSession = makeCwdForSession(deps)
      const piCwds = new Map<string, string | null>()
      await Promise.all(
        sessions
          .filter((s) => s.agentKind === 'pi')
          .map(async (s) => {
            piCwds.set(s.id, await cwdForSession(s))
          }),
      )
      const entries: SessionHistoryEntry[] = []
      for (const session of sessions) {
        const outcome = await resolveOutcome(session.id)
        const rawUsage = await readSessionUsage(session, { cwd: piCwds.get(session.id) ?? null })
        const usage = !rawUsage.exists || rawUsage.turns === 0 ? null : rawUsage
        entries.push({ session, outcome, usage })
      }
      return entries
    },
  }
}

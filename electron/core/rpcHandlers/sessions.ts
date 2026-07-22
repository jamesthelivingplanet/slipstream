import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { IpcDeps } from '../../ipc.js'
import { IPC, BACKEND_KINDS } from '../../shared/contract.js'
import type { BackendKind, TicketSource } from '../../shared/contract.js'
import { branchFor } from '../../shared/branch.js'
import {
  buildSystemPrompt,
  buildHandoffPrompt,
  formatChatExcerpt,
  AGENT_LABELS,
} from '../../shared/promptComposer.js'
import { parseAgentArgs } from '../../shared/agentCli.js'
import { launchSession, resumeProcedure } from '../../services/sessionLauncher.js'
import type { LaunchRequest } from '../../services/sessionLauncher.js'
import { readSessionChat } from '../../services/sessionChatReader.js'
import { ScrollbackStore } from '../../services/scrollbackStore.js'
import type { RpcContext } from '../rpcContext.js'
import type { ChannelHandlerMap } from './types.js'

export function createSessionHandlers(deps: IpcDeps, ctx: RpcContext): ChannelHandlerMap {
  const { identity, clientId, coord, ownedByCaller, ownedSession, lockState, resolveOutcome } = ctx

  return {
    [IPC.startSession]: async (args) => {
      const input = args[0] as {
        tid: string
        title: string
        prompt: string
        repoId: string
        description?: string
        agentKind?: BackendKind
        sessionId?: string
        src?: TicketSource
        extraArgs?: string
      }
      const { tid, title, prompt, repoId, description } = input
      const agentKind = input.agentKind

      // TASK-CMZUG: a blank per-run extraArgs falls back to the saved per-agent
      // default (config key agentArgs.<kind>); a non-blank run value overrides it.
      const effectiveExtraArgs =
        input.extraArgs && input.extraArgs.trim()
          ? input.extraArgs
          : deps.config.get(`agentArgs.${agentKind ?? 'claude-code'}`) || undefined

      // TASK-UQF55: validate up front so a malformed arg string errors the
      // start call synchronously (incl. the queued path), not later.
      if (effectiveExtraArgs) parseAgentArgs(effectiveExtraArgs)

      const repo = await deps.repos.resolvePath(repoId)
      if (!ownedByCaller(repo)) throw new Error(`Unknown repo: ${repoId}`)

      const branch = branchFor(tid, title)
      const systemPrompt = buildSystemPrompt({ tid, title, description })

      // FLO-95: the actual worktree/port/PTY launch procedure lives in
      // sessionLauncher.ts so it can run immediately (below the concurrency
      // cap) or later from the scheduler's queue drain. The system prompt is
      // built once here (not in the launcher) and carried on the request so
      // a queued start launches with exactly what was requested.
      const req: LaunchRequest = {
        sessionId: input.sessionId ?? randomUUID(),
        tid,
        title,
        prompt,
        repoId,
        branch,
        systemPrompt,
        agentKind,
        src: input.src,
        ownerId: identity.id,
        extraArgs: effectiveExtraArgs,
      }

      const session = deps.scheduler
        ? await deps.scheduler.submit(req)
        : await launchSession(deps, req)

      return session
    },

    [IPC.writeSession]: async (args) => {
      const id = args[0] as string
      if (!ownedSession(id)) return undefined
      if (coord && !coord.noteWrite(id, clientId)) return undefined
      deps.sessions.write(id, args[1] as string)
      return undefined
    },

    [IPC.syncClipboardImage]: async (args) => {
      const id = args[0] as string
      const dataBase64 = args[1] as string
      if (!ownedSession(id)) throw new Error(`Session not found: ${id}`)
      if (coord && !coord.noteWrite(id, clientId)) return undefined
      if (!deps.clipboardStore) throw new Error('Clipboard storage is not configured')
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64) || dataBase64.length % 4 !== 0) {
        throw new Error('Invalid base64 image data')
      }
      const buf = Buffer.from(dataBase64, 'base64')
      const MAX_CLIPBOARD_BYTES = 10 * 1024 * 1024
      if (buf.length > MAX_CLIPBOARD_BYTES) {
        throw new Error('Clipboard image exceeds the 10 MiB limit')
      }
      deps.clipboardStore.save(id, buf)
      return undefined
    },

    [IPC.resizeSession]: async (args) => {
      const id = args[0] as string
      if (!ownedSession(id)) return undefined
      if (coord && !coord.canWrite(id, clientId)) return undefined
      deps.sessions.resize(id, args[1] as number, args[2] as number)
      return undefined
    },

    [IPC.attachSession]: async (args) => {
      const id = args[0] as string
      if (!ownedSession(id)) return lockState(id)
      coord?.attach(id, clientId)
      return lockState(id)
    },

    [IPC.detachSession]: async (args) => {
      const id = args[0] as string
      if (!ownedSession(id)) return undefined
      coord?.detach(id, clientId)
      return undefined
    },

    [IPC.takeWrite]: async (args) => {
      const id = args[0] as string
      if (!ownedSession(id)) return lockState(id)
      coord?.take(id, clientId)
      return lockState(id)
    },

    [IPC.killSession]: async (args) => {
      const id = args[0] as string
      if (!ownedSession(id)) return undefined
      // A queued (not-yet-spawned) session has no PTY to kill — cancel it
      // out of the scheduler's queue instead, and record it the same way a
      // kill of a live session would (interrupted: resumable/cleanable).
      if (deps.scheduler?.cancel(id)) {
        const persisted = deps.sessionStore.get(id)
        if (persisted) deps.sessionStore.upsert({ ...persisted, status: 'interrupted' })
        return undefined
      }
      deps.sessions.kill(id)
      return undefined
    },

    [IPC.cleanupSession]: async (args) => {
      const id = args[0] as string
      const opts = args[1] as { force?: boolean } | undefined
      // Cancel first: a queued entry must not be able to launch after its
      // store row is deleted below. (The drain's stale-row guard is the
      // backstop if this races anyway.)
      deps.scheduler?.cancel(id)
      const persisted = ownedSession(id)
      if (!persisted) return { removed: false, reason: 'session not found' }
      const repo = await deps.repos.get(persisted.repoId)
      if (!repo) return { removed: false, reason: 'session not found' }
      const result = await deps.worktrees.remove(repo, persisted.branch, opts)
      if (result.removed) {
        deps.sessionStore.delete(id)
        deps.clipboardStore?.delete(id)

        // FLO-133: sweep the remaining per-session artifacts that otherwise
        // accumulate forever on a long-lived daemon. All best-effort — a
        // failure here must not prevent the others from being attempted or
        // fail the cleanup call (the worktree/DB row are already gone).
        deps.outcomeStore.delete(id)
        deps.agentEventStore?.delete(id)
        new ScrollbackStore(deps.dataDir).delete(id)
        deps.logger?.deleteSessionLog(id)
        try {
          fs.rmSync(path.join(deps.dataDir, 'sessions', id), { recursive: true, force: true })
        } catch {
          // best-effort — cleanup must not fail after the worktree/DB row are already gone
        }

        // FLO-35: move the linked ticket back to "To Do" when the agent run
        // is deleted, so the next agent can pick it up. Best-effort — a
        // ticket-API failure must not break the cleanup.
        // TASK-5PVBM: but a run that reached 'done' finished its work — leave
        // the ticket where the agent left it rather than bouncing it back to
        // To Do.
        const tid = persisted.tid
        if (tid && persisted.status !== 'done') {
          try {
            await deps.tickets.resetTicket(tid, persisted.src)
          } catch {
            // ignore: ticket provider unavailable or transition not applicable
          }
        }
      }
      return result
    },

    [IPC.sessionMerged]: async (args) => {
      const id = args[0] as string
      const persisted = ownedSession(id)
      if (!persisted) return { merged: false }
      const repo = await deps.repos.get(persisted.repoId)
      if (!repo) return { merged: false }
      const probe = await deps.worktrees.isMerged(repo, persisted.branch)
      if (probe.merged) return { merged: true, via: probe.via }
      // Rebase/fast-forward merges leave no merge commit and put the branch's
      // original SHAs on base (ahead === 0) — indistinguishable from a fresh
      // branch by git alone, so require the session's recorded PR as evidence.
      if (probe.ahead === 0 && persisted.prUrl) return { merged: true, via: 'pr' }
      return { merged: false }
    },

    [IPC.listSessions]: async () => {
      return deps.sessionStore.list().filter(ownedByCaller)
    },

    [IPC.resumeSession]: async (args) => {
      const id = args[0] as string
      const owned = ownedSession(id)
      if (deps.sessions.has(id) && owned) {
        return owned
      }
      const persisted = owned
      if (!persisted) throw new Error(`Session not found: ${id}`)
      // A queued session hasn't been spawned yet — the scheduler owns when
      // it launches (spawning it here would let a viewer jump the queue).
      if (persisted.status === 'queued') return persisted
      return resumeProcedure(deps, { mode: 'resume', session: persisted })
    },

    [IPC.attachRemoteControl]: async (args) => {
      const id = args[0] as string
      const persisted = ownedSession(id)
      if (!persisted) throw new Error(`Session not found: ${id}`)
      // A queued session hasn't been spawned yet — the scheduler owns when
      // it launches (spawning it here would let a viewer jump the queue).
      if (persisted.status === 'queued') return persisted
      return resumeProcedure(deps, { mode: 'attach', session: persisted })
    },

    [IPC.handoffSession]: async (args) => {
      const id = args[0] as string
      const agentKind = args[1] as BackendKind
      if (!BACKEND_KINDS.includes(agentKind))
        throw new Error(`Unknown agent kind: ${String(agentKind)}`)
      const persisted = ownedSession(id)
      if (!persisted) throw new Error(`Session not found: ${id}`)
      // A queued session hasn't started — there is nothing to hand off yet.
      if (persisted.status === 'queued')
        throw new Error('Session is queued — it has not started yet')
      const fromKind: BackendKind = persisted.agentKind ?? 'claude-code'
      if (fromKind === agentKind)
        throw new Error(`Session is already running on ${AGENT_LABELS[agentKind]}`)
      const repo = await deps.repos.resolvePath(persisted.repoId)
      const outcome = await resolveOutcome(id)
      // Gather the prior agent's recent conversation (its reasoning, the tools
      // it ran, where it left off) so the new agent can pick up the run
      // instead of re-deriving it from git state alone. Read BEFORE
      // resumeProcedure kills the old PTY, while the prior backend's chat
      // source is still maximally fresh; best-effort — a backend with no chat
      // reader (antigravity/grok) or nothing recoverable yields an empty
      // excerpt and the prompt falls back to the git-state path.
      const priorConversation = formatChatExcerpt((await readSessionChat(deps, persisted)).messages)
      const handoffPrompt = buildHandoffPrompt({
        tid: persisted.tid,
        title: persisted.title,
        prompt: persisted.prompt,
        fromAgent: AGENT_LABELS[fromKind],
        branch: persisted.branch,
        base: repo.base,
        outcomeSummary: outcome?.summary,
        priorConversation,
      })
      return resumeProcedure(deps, {
        mode: 'handoff',
        session: persisted,
        agentKind,
        handoffPrompt,
      })
    },

    [IPC.getSessionBuffer]: async (args) => {
      const id = args[0] as string
      if (!ownedSession(id)) throw new Error(`Session not found: ${id}`)
      return deps.sessions.getBuffer(id)
    },
  }
}

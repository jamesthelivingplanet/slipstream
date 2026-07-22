/**
 * SessionLauncher — FLO-95. The actual "spin up a live agent" procedure,
 * extracted out of rpc.ts's IPC.startSession handler so it can be invoked
 * either immediately (concurrency cap not reached) or later, from the
 * scheduler's drain loop (see sessionScheduler.ts).
 *
 * The launcher does NOT rebuild the system prompt — it's composed once at
 * submit time (rpc.ts, via buildSystemPrompt) and carried on the
 * LaunchRequest (and persisted on queued SessionDTO rows), so a queued start
 * launches with exactly what was requested.
 */

import type {
  BackendKind,
  IPortBroker,
  IRepoRegistry,
  ISessionManager,
  ISessionStore,
  ITicketProvider,
  IWorktreeManager,
  SessionDTO,
  TicketSource,
} from '../shared/contract.js'
import { captureOpencodeSessionId } from './opencodeSessions.js'
import { usesEmbeddedServer, KILO_BIN } from './agentBackend.js'
import { agentSessionEnv, type AgentCliDep } from './agentCliProvision.js'

export type ResumeMode = 'resume' | 'attach' | 'handoff'

export interface ResumeProcedureDeps {
  repos: Pick<IRepoRegistry, 'resolvePath'>
  worktrees: Pick<IWorktreeManager, 'pathFor'>
  sessions: Pick<ISessionManager, 'resume' | 'attachRemoteControl' | 'handoff' | 'setOpencodeSid'>
  ports: IPortBroker
  sessionStore: ISessionStore
  agentCli?: AgentCliDep
}

export interface ResumeProcedureRequest {
  mode: ResumeMode
  session: SessionDTO
  /** Target agent kind — required for 'handoff' (the backend being switched
   *  to); ignored for 'resume'/'attach', which stay on session.agentKind. */
  agentKind?: BackendKind
  /** Required for 'handoff' — the takeover prompt, built by the caller via
   *  buildHandoffPrompt (needs the resolved outcome, which is rpc.ts's
   *  concern, not the launcher's). */
  handoffPrompt?: string
}

export interface LaunchRequest {
  sessionId: string
  tid: string
  title: string
  prompt: string
  repoId: string
  branch: string
  systemPrompt: string
  agentKind?: BackendKind
  src?: TicketSource
  ownerId: string
  /** Extra CLI args passthrough (TASK-UQF55). */
  extraArgs?: string
}

export interface LaunchDeps {
  repos: Pick<IRepoRegistry, 'resolvePath'>
  worktrees: Pick<IWorktreeManager, 'create' | 'pathFor'>
  sessions: Pick<ISessionManager, 'start' | 'setOpencodeSid'>
  ports: IPortBroker
  sessionStore: ISessionStore
  tickets: Pick<ITicketProvider, 'startTicket'>
  agentCli?: AgentCliDep
}

/** Run the full launch procedure (worktree create, port claims, CLI env,
 *  PTY spawn, persistence, ticket transition) and return the live session
 *  with its assigned port attached. */
export async function launchSession(deps: LaunchDeps, req: LaunchRequest): Promise<SessionDTO> {
  const {
    sessionId,
    tid,
    title,
    prompt,
    repoId,
    branch,
    systemPrompt,
    agentKind,
    src,
    ownerId,
    extraArgs,
  } = req

  const repo = await deps.repos.resolvePath(repoId)
  await deps.worktrees.create(repo, branch)
  const cwd = deps.worktrees.pathFor(repo, branch)

  let port: number | undefined
  try {
    port = await deps.ports.claim(cwd, 'web')
  } catch {
    port = undefined
  }

  let opencodePort: number | undefined
  if (usesEmbeddedServer(agentKind)) {
    try {
      opencodePort = await deps.ports.claim(cwd, agentKind ?? 'claude-code')
    } catch {
      opencodePort = undefined
    }
  }

  const session = deps.sessions.start({
    tid,
    title,
    prompt,
    repo,
    branch,
    cwd,
    // FLO-104: the slipstream CLI reaches every backend through the PTY env
    // (PATH + SLIPSTREAM_* identity vars) — no per-backend config files.
    env: agentSessionEnv(deps.agentCli, { sessionId, base: repo.base, branch, port }),
    systemPrompt,
    agentKind,
    opencodePort,
    sessionId,
    src,
    extraArgs,
  })

  deps.sessionStore.upsert({
    ...session,
    port,
    agentKind: agentKind ?? 'claude-code',
    ownerId,
  })

  if (usesEmbeddedServer(agentKind)) {
    void captureOpencodeSessionId({ cwd, bin: agentKind === 'kilo' ? KILO_BIN : undefined }).then(
      (sid) => {
        if (!sid) return
        deps.sessions.setOpencodeSid(session.id, sid)
        const cur = deps.sessionStore.get(session.id)
        if (cur) deps.sessionStore.upsert({ ...cur, opencodeSid: sid })
      },
    )
  }

  // FLO-26: move the linked ticket to the provider's "In Progress" state
  // when the agent starts. Best-effort — a ticket-API failure must not
  // break the agent launch. Follow-up: handle stop/complete/error
  // transitions (out of scope for FLO-26).
  try {
    await deps.tickets.startTicket(tid, src)
  } catch {
    // ignore: ticket provider unavailable or transition not applicable
  }

  return { ...session, port }
}

/** Run the shared "reconnect to an already-started session" procedure shared
 *  by resume, attach-remote-control, and handoff (FLO-118): resolve the repo
 *  → worktree cwd → claim the web port → claim the embedded-server port (if
 *  the target backend needs one) → build the CLI env → make the mode-specific
 *  sessions.* call → persist the assigned port. Callers own everything that
 *  differs per mode before calling in (owner/queued guards, the handoff
 *  prompt, the "already on this agent" check) and after (nothing — the
 *  returned DTO is ready to hand back over IPC). */
export async function resumeProcedure(
  deps: ResumeProcedureDeps,
  req: ResumeProcedureRequest,
): Promise<SessionDTO & { port?: number }> {
  const { mode, session } = req

  const repo = await deps.repos.resolvePath(session.repoId)
  const cwd = deps.worktrees.pathFor(repo, session.branch)

  let port: number | undefined
  try {
    port = await deps.ports.claim(cwd, 'web')
  } catch {
    port = undefined
  }

  const targetAgentKind = mode === 'handoff' ? req.agentKind : session.agentKind
  let opencodePort: number | undefined
  if (usesEmbeddedServer(targetAgentKind)) {
    try {
      opencodePort = await deps.ports.claim(cwd, targetAgentKind ?? 'claude-code')
    } catch {
      opencodePort = undefined
    }
  }

  const env = agentSessionEnv(deps.agentCli, {
    sessionId: session.id,
    base: repo.base,
    branch: session.branch,
    port,
  })

  let dto: SessionDTO
  if (mode === 'resume') {
    dto = deps.sessions.resume({ session, cwd, env, opencodePort })
  } else if (mode === 'attach') {
    dto = deps.sessions.attachRemoteControl({ session, cwd, env, opencodePort })
  } else {
    const agentKind = req.agentKind
    if (!agentKind || !req.handoffPrompt) {
      throw new Error('resumeProcedure: handoff requires agentKind and handoffPrompt')
    }
    dto = deps.sessions.handoff({
      session,
      cwd,
      env,
      opencodePort,
      agentKind,
      handoffPrompt: req.handoffPrompt,
    })
    // Same async sid capture as launchSession above: the embedded-server
    // session id only exists after the TUI boots; status polling starts
    // once it's known.
    if (usesEmbeddedServer(agentKind)) {
      void captureOpencodeSessionId({ cwd, bin: agentKind === 'kilo' ? KILO_BIN : undefined }).then(
        (sid) => {
          if (!sid) return
          deps.sessions.setOpencodeSid(session.id, sid)
          const cur = deps.sessionStore.get(session.id)
          if (cur) deps.sessionStore.upsert({ ...cur, opencodeSid: sid })
        },
      )
    }
  }

  deps.sessionStore.upsert({ ...dto, port })
  return { ...dto, port }
}

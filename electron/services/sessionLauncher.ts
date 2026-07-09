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

import path from 'node:path'
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
import { buildAppMcpConfig, buildOpencodeMcpConfig, writeAppMcpConfig } from './mcpConfig.js'

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
}

export interface LaunchDeps {
  repos: Pick<IRepoRegistry, 'resolvePath'>
  worktrees: Pick<IWorktreeManager, 'create' | 'pathFor'>
  sessions: Pick<ISessionManager, 'start' | 'setOpencodeSid'>
  ports: IPortBroker
  sessionStore: ISessionStore
  tickets: Pick<ITicketProvider, 'startTicket'>
  appMcp?: { configDir: string; appMcpJsPath: string; electronPath: string; dataDir: string }
}

/** Run the full launch procedure (worktree create, port claims, MCP config,
 *  PTY spawn, persistence, ticket transition) and return the live session
 *  with its assigned port attached. */
export async function launchSession(deps: LaunchDeps, req: LaunchRequest): Promise<SessionDTO> {
  const { sessionId, tid, title, prompt, repoId, branch, systemPrompt, agentKind, src, ownerId } =
    req

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
  if (agentKind === 'opencode') {
    try {
      opencodePort = await deps.ports.claim(cwd, 'opencode')
    } catch {
      opencodePort = undefined
    }
  }

  let mcpConfigPath: string | undefined
  const startEnv: Record<string, string> = {}
  if (port !== undefined) startEnv.PORT = String(port)
  if (deps.appMcp) {
    mcpConfigPath = path.join(deps.appMcp.configDir, `${sessionId}.json`)
    const config = buildAppMcpConfig({
      appMcpJsPath: deps.appMcp.appMcpJsPath,
      electronPath: deps.appMcp.electronPath,
      dataDir: deps.appMcp.dataDir,
      sessionId,
      base: repo.base,
      branch,
    })
    await writeAppMcpConfig(mcpConfigPath, config)

    if (agentKind === 'opencode') {
      startEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify(
        buildOpencodeMcpConfig({
          appMcpJsPath: deps.appMcp.appMcpJsPath,
          electronPath: deps.appMcp.electronPath,
          dataDir: deps.appMcp.dataDir,
          sessionId,
          base: repo.base,
          branch,
        }),
      )
    }
  }

  const session = deps.sessions.start({
    tid,
    title,
    prompt,
    repo,
    branch,
    cwd,
    env: Object.keys(startEnv).length > 0 ? startEnv : undefined,
    systemPrompt,
    agentKind,
    opencodePort,
    sessionId,
    mcpConfigPath,
    src,
  })

  deps.sessionStore.upsert({
    ...session,
    port,
    agentKind: agentKind ?? 'claude-code',
    ownerId,
  })

  if (agentKind === 'opencode') {
    void captureOpencodeSessionId({ cwd }).then((sid) => {
      if (!sid) return
      deps.sessions.setOpencodeSid(session.id, sid)
      const cur = deps.sessionStore.get(session.id)
      if (cur) deps.sessionStore.upsert({ ...cur, opencodeSid: sid })
    })
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

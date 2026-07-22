import { randomUUID } from 'node:crypto'
import type { IpcDeps } from '../ipc.js'
import { IPC } from '../shared/contract.js'
import type { Identity, StatusMeta } from '../shared/contract.js'
import { LOCAL_IDENTITY } from './auth.js'
import { createRpcContext } from './rpcContext.js'
import type { ChannelHandlerMap } from './rpcHandlers/types.js'
import { createRepoHandlers } from './rpcHandlers/repos.js'
import { createSessionHandlers } from './rpcHandlers/sessions.js'
import { createWorktreeHandlers } from './rpcHandlers/worktrees.js'
import { createTicketHandlers } from './rpcHandlers/tickets.js'
import { createConfigHandlers } from './rpcHandlers/config.js'
import { createDiagnosticsHandlers } from './rpcHandlers/diagnostics.js'
import { createUsageHandlers } from './rpcHandlers/usage.js'
import { createPromptTemplateHandlers } from './rpcHandlers/promptTemplates.js'
import { createChatHandlers } from './rpcHandlers/chat.js'
import { createPushHandlers } from './rpcHandlers/push.js'

export interface Rpc {
  /** Route one request by IPC channel name. Returns the result or throws. */
  handle(channel: string, args: unknown[]): Promise<unknown>
  /** Remove session event listeners. */
  dispose(): void
}

/**
 * Transport-free RPC core — no Electron imports.
 * `emit` is called when a push event (session data/status) should be sent to the client.
 */
export function createRpc(
  deps: IpcDeps,
  emit: (channel: string, ...args: unknown[]) => void,
  opts: { coalesceMs?: number; identity?: Identity; clientId?: string } = {},
): Rpc {
  const coalesceMs = opts.coalesceMs ?? 40
  const identity = opts.identity ?? LOCAL_IDENTITY
  const clientId = opts.clientId ?? randomUUID()
  const ctx = createRpcContext(deps, identity, clientId)
  const coord = ctx.coord

  // Per-session output coalescing: batch session:data bursts and flush on a
  // short timer so a chatty PTY doesn't flood the transport with one message
  // per chunk. Status events are never coalesced.
  const pendingData = new Map<string, { parts: string[]; seq: number }>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  function flushData(): void {
    flushTimer = null
    for (const [id, entry] of pendingData) {
      if (entry.parts.length > 0) {
        emit(IPC.sessionData, id, entry.parts.join(''), entry.seq)
      }
    }
    pendingData.clear()
  }

  function onData(sessionId: string, chunk: string, seq: number): void {
    const cur = pendingData.get(sessionId)
    if (cur) {
      cur.parts.push(chunk)
      cur.seq = seq
    } else {
      pendingData.set(sessionId, { parts: [chunk], seq })
    }
    if (coalesceMs <= 0) {
      flushData()
    } else if (!flushTimer) {
      flushTimer = setTimeout(flushData, coalesceMs)
    }
  }
  function onStatus(sessionId: string, status: string, meta?: StatusMeta): void {
    // Keep the common (no-meta) case at 2 args over the wire — status fires on
    // every PTY chunk, a hot path, and JSON.stringify([...,undefined]) would
    // turn a trailing undefined 4th arg into a `null` anyway.
    if (meta !== undefined) {
      emit(IPC.sessionStatus, sessionId, status, meta)
    } else {
      emit(IPC.sessionStatus, sessionId, status)
    }
  }

  function onPr(id: string, url: string): void {
    emit(IPC.sessionPr, id, url)
  }

  function onExit(id: string, code: number): void {
    emit(IPC.sessionExit, id, code)
  }

  function onAgentEvent(_id: string, event: import('../shared/contract.js').SessionAgentEventDTO) {
    emit(IPC.sessionAgentEvent, event)
  }

  function onChatMessage(id: string, msg: import('../shared/contract.js').SessionChatMessageDTO) {
    emit(IPC.sessionChatMessage, id, msg)
  }

  deps.sessions.on('data', onData)
  deps.sessions.on('status', onStatus)
  deps.sessions.on('pr', onPr)
  deps.sessions.on('exit', onExit)
  deps.sessions.on('agentEvent', onAgentEvent)
  deps.sessions.on('chatMessage', onChatMessage)

  function onLockChange(sessionId: string): void {
    if (!coord!.isViewer(sessionId, clientId)) return
    emit(IPC.sessionWriteLock, ctx.lockState(sessionId))
  }
  if (coord) coord.on('change', onLockChange)

  const handlers: ChannelHandlerMap = {
    ...createRepoHandlers(deps, ctx),
    ...createSessionHandlers(deps, ctx),
    ...createWorktreeHandlers(deps, ctx),
    ...createTicketHandlers(deps, ctx),
    ...createConfigHandlers(deps, ctx),
    ...createDiagnosticsHandlers(deps, ctx),
    ...createUsageHandlers(deps, ctx),
    ...createPromptTemplateHandlers(deps, ctx),
    ...createChatHandlers(deps, ctx),
    ...createPushHandlers(deps, ctx),
  }

  async function handle(channel: string, args: unknown[]): Promise<unknown> {
    const handler = handlers[channel]
    if (!handler) throw new Error(`Unknown channel: ${channel}`)
    return handler(args)
  }

  function dispose(): void {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    pendingData.clear()
    deps.sessions.off('data', onData)
    deps.sessions.off('status', onStatus)
    deps.sessions.off('pr', onPr)
    deps.sessions.off('exit', onExit)
    deps.sessions.off('agentEvent', onAgentEvent)
    deps.sessions.off('chatMessage', onChatMessage)
    deps.sessions.dropChatClient?.(clientId)
    if (coord) {
      coord.dropClient(clientId)
      coord.off('change', onLockChange)
    }
  }

  return { handle, dispose }
}

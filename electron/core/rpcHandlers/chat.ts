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
 *  (default 50) caps to the most recent page after that filter.
 *
 *  TASK-N6X4R: paging now selects a window of MAIN-THREAD messages
 *  (`isSidechain` falsy) rather than slicing the flat ts-merged list
 *  `readSessionChat` returns. Since sessionChatReader.ts started merging each
 *  Claude Code subagent's own transcript into that flat list (so the `Agent`
 *  tool's delegated work is recoverable instead of a black box), sidechain
 *  volume can dwarf the real conversation — measured on this machine: a
 *  22-subagent session has 841 main-transcript lines vs 2161 subagent lines
 *  (subagent content is ~72% of the total), and another session went from
 *  311 to 1304 messages (4.2x) once subagents were merged in. A flat
 *  `.slice(-limit)` over that list is therefore mostly subagent chatter,
 *  pushing the actual conversation off the page by default — a regression of
 *  the chat view's core purpose. DO NOT "simplify" this back to a flat
 *  slice — that reintroduces exactly that regression.
 *
 *  Each selected main-thread turn's associated sidechain messages are still
 *  returned (see `groupSidechainsByMainThreadAnchor`) so the renderer can
 *  nest a turn's delegated work under its `Agent` tool_use, but they ride
 *  along for free rather than competing with real conversation for `limit`.
 *  Sidechain inclusion defaults to on (one round-trip, matches what the
 *  renderer needs to show); `includeSidechains: false` is an escape hatch
 *  for a caller that only wants the main conversation, not the default. */
function pageChatMessages(
  messages: SessionChatMessageDTO[],
  opts: { beforeTs?: number; limit?: number; includeSidechains?: boolean },
): SessionChatMessageDTO[] {
  const mainMessages = messages.filter((m) => !m.isSidechain)
  let mainPage = mainMessages
  if (opts.beforeTs !== undefined) {
    mainPage = mainPage.filter((m) => m.ts < opts.beforeTs!)
  }
  const limit = opts.limit ?? 50
  if (mainPage.length > limit) mainPage = mainPage.slice(-limit)

  if (opts.includeSidechains === false) return mainPage

  const sidechain = messages.filter((m) => m.isSidechain)
  // Regression guard: a session with no subagent turns (the common case,
  // and every case before TASK-N6X4R) takes this fast path and behaves
  // exactly like the old flat-slice logic, since mainPage === the old `out`.
  if (sidechain.length === 0) return mainPage

  const anchorOf = groupSidechainsByMainThreadAnchor(messages, mainMessages)
  const selected = new Set(mainPage.map((m) => m.uuid))
  const carried = sidechain.filter((m) => {
    const anchor = anchorOf.get(m.uuid)
    return anchor !== undefined && selected.has(anchor)
  })
  if (carried.length === 0) return mainPage
  // Re-sort: a subagent run's messages can carry timestamps earlier than the
  // main-thread turn that spawned it finishes (it ran DURING that turn), so
  // appending then re-sorting keeps the page ts-ordered like before.
  return [...mainPage, ...carried].sort((a, b) => a.ts - b.ts)
}

/**
 * Map every sidechain message's uuid to the uuid of the MAIN-THREAD message
 * whose `Agent` tool_use spawned the subagent run it (transitively) belongs
 * to, so `pageChatMessages` can carry a turn's subagent detail along with it
 * without letting it consume `limit`.
 *
 * sidechainId-first strategy: sessionChatReader.ts's `readSubagentMessages`
 * stamps `sidechainId` (the subagent file's `agentId`) on EVERY message it
 * produces, so messages sharing a `sidechainId` are known — directly, without
 * any chain-walking — to belong to the same subagent transcript file. This
 * matters because the OLD strategy (walk `parentUuid` pointers to a chain's
 * root, then resolve the root's stamped `parentUuid`) breaks when a line in
 * the middle of that chain gets dropped: transcriptMessages.ts's `parseLine`
 * drops any line with no renderable content block, which fragments a chain
 * in EVERY real transcript file measured on this machine (2-3 fragments per
 * file) — each fragment's "root" (the first surviving line after a gap) has
 * no `parentUuid` at all, so the walk can't reach the real spawn tool_use and
 * the fragment falls back to a ts-nearest guess independently of the rest of
 * its own subagent run, splitting one run across multiple anchors/pages.
 *
 * So resolution is now done ONCE PER `sidechainId` group (memoized), not per
 * message: resolve the group's anchor from its `sidechainToolUseId` (meta.json's
 * `toolUseId`, stamped on every message of the group) via the `toolUseOwner`
 * map below, then map every message of the group to that single anchor. A
 * group with no `sidechainToolUseId` (no meta.json, or it didn't parse) falls
 * back to the old chain-root-`parentUuid` strategy, scoped to that group's
 * own root line — unchanged behavior for that case, just no longer able to
 * silently split a `sidechainId` group across anchors even if part of ITS
 * OWN chain-walk fails. A sidechain message with no `sidechainId` at all
 * (shouldn't happen for anything sessionChatReader produced, but keeps old
 * data/paths working) keeps the original per-message chain-walk path,
 * unchanged.
 *
 * Nested subagents (spawnDepth > 1, per sessionChatReader.ts's comment) spawn
 * from an `Agent` tool_use call made BY an ancestor subagent, not from the
 * main transcript — so the "owning message" resolved above can itself be a
 * sidechain message belonging to a DIFFERENT `sidechainId` group. Recurse
 * (memoized per group, cycle-guarded) through however many nesting levels
 * exist until a main-thread owner is found; that becomes the anchor for the
 * WHOLE nested tree, so a nested subagent's messages page in and out
 * together with the top-level turn that ultimately caused them.
 *
 * A group whose owner can't be resolved at all (dangling reference — e.g. a
 * truncated transcript trimmed the owning turn, or a meta.json toolUseId
 * that doesn't match anything in the messages we have) falls back to the
 * nearest main-thread message by `ts` — applied ONCE per group (using the
 * group's earliest message), so a dangling group still pages in as one unit
 * with SOME turn instead of being split across pages by per-message ts
 * fallbacks landing on different pages. */
function groupSidechainsByMainThreadAnchor(
  messages: SessionChatMessageDTO[],
  mainMessages: SessionChatMessageDTO[],
): Map<string, string> {
  const byUuid = new Map(messages.map((m) => [m.uuid, m]))
  const mainUuids = new Set(mainMessages.map((m) => m.uuid))
  const toolUseOwner = new Map<string, string>()
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.type === 'tool_use') toolUseOwner.set(b.id, m.uuid)
    }
  }

  // Every sidechain message that carries a sidechainId, grouped by it.
  const sidechainGroups = new Map<string, SessionChatMessageDTO[]>()
  for (const m of messages) {
    if (!m.isSidechain || !m.sidechainId) continue
    const group = sidechainGroups.get(m.sidechainId)
    if (group) group.push(m)
    else sidechainGroups.set(m.sidechainId, [m])
  }

  const resolvedLegacy = new Map<string, string | undefined>()
  const resolvedGroup = new Map<string, string | undefined>()

  // Original per-message chain walk — only reached for a sidechain message
  // with no sidechainId. Also the recursion target when an owner message
  // turns out to be a sidechain message with no sidechainId of its own.
  function resolveAnchor(uuid: string, guard: Set<string>): string | undefined {
    if (mainUuids.has(uuid)) return uuid
    const owner = byUuid.get(uuid)
    if (owner?.isSidechain && owner.sidechainId) {
      return resolveGroupAnchor(owner.sidechainId, guard)
    }
    if (resolvedLegacy.has(uuid)) return resolvedLegacy.get(uuid)
    if (guard.has(`m:${uuid}`)) return undefined // cycle guard — shouldn't happen with real data
    guard.add(`m:${uuid}`)

    // Walk up this subagent's own chain to its root line (the loop is
    // bounded by that one subagent's chain length, so this stays cheap even
    // called once per message in a long chain).
    let root = byUuid.get(uuid)
    while (root?.parentUuid && byUuid.get(root.parentUuid)?.isSidechain) {
      root = byUuid.get(root.parentUuid)
    }
    const spawnToolUseId = root?.parentUuid
    const ownerUuid = spawnToolUseId ? toolUseOwner.get(spawnToolUseId) : undefined
    const anchor = ownerUuid ? resolveAnchor(ownerUuid, guard) : undefined
    resolvedLegacy.set(uuid, anchor)
    return anchor
  }

  // sidechainId-first resolution — one lookup per subagent transcript file,
  // memoized, so every message of that file (even one whose OWN parentUuid
  // chain got fragmented by a dropped line) resolves to the same anchor.
  function resolveGroupAnchor(sidechainId: string, guard: Set<string>): string | undefined {
    if (resolvedGroup.has(sidechainId)) return resolvedGroup.get(sidechainId)
    if (guard.has(`g:${sidechainId}`)) return undefined // cycle guard
    guard.add(`g:${sidechainId}`)

    const group = sidechainGroups.get(sidechainId) ?? []
    const toolUseId = group.find((m) => m.sidechainToolUseId)?.sidechainToolUseId
    let ownerUuid = toolUseId ? toolUseOwner.get(toolUseId) : undefined

    if (!ownerUuid) {
      // No (matching) sidechainToolUseId — fall back to the chain-root
      // parentUuid strategy, same as before sidechainId existed, scoped to
      // this group's own root line (the message with no parentUuid, or —
      // defensively, if that's absent too — its earliest by ts).
      let root: SessionChatMessageDTO | undefined
      for (const m of group) {
        if (m.parentUuid === undefined) {
          root = m
          break
        }
      }
      if (!root) {
        for (const m of group) {
          if (!root || m.ts < root.ts) root = m
        }
      }
      const spawnToolUseId = root?.parentUuid
      ownerUuid = spawnToolUseId ? toolUseOwner.get(spawnToolUseId) : undefined
    }

    let anchor = ownerUuid ? resolveAnchor(ownerUuid, guard) : undefined
    if (anchor === undefined) {
      // Dangling reference — fall back to the nearest main-thread message by
      // ts, applied ONCE for the whole group (its earliest message) so the
      // group is never split across pages by per-message fallbacks.
      let earliestTs = Infinity
      for (const m of group) earliestTs = Math.min(earliestTs, m.ts)
      anchor = nearestMainUuidByTs(earliestTs, mainMessages)
    }
    resolvedGroup.set(sidechainId, anchor)
    return anchor
  }

  const anchors = new Map<string, string>()
  for (const m of messages) {
    if (!m.isSidechain) continue
    const anchor = m.sidechainId
      ? resolveGroupAnchor(m.sidechainId, new Set())
      : (resolveAnchor(m.uuid, new Set()) ?? nearestMainUuidByTs(m.ts, mainMessages))
    if (anchor) anchors.set(m.uuid, anchor)
  }
  return anchors
}

/** Fallback anchor for a sidechain message whose chain never resolves to an
 *  owning `Agent` tool_use: the nearest main-thread message at or before its
 *  `ts`, or the very first main-thread message if it somehow predates all of
 *  them (never actually vanishing is preferred over precision here — this
 *  path is an edge case, not the common one). `mainMessages` arrives
 *  ts-ascending (readSessionChat's merge sorts the whole list, and filtering
 *  preserves order), so a single forward scan finds it. */
function nearestMainUuidByTs(
  ts: number,
  mainMessages: SessionChatMessageDTO[],
): string | undefined {
  let preceding: string | undefined
  for (const m of mainMessages) {
    if (m.ts <= ts) {
      preceding = m.uuid
      continue
    }
    return preceding ?? m.uuid
  }
  return preceding
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
      // `includeSidechains` is additive-only on this handler's own opts
      // shape (not the typed `SlipstreamApi.getChatMessages` signature in
      // contract.ts, out of scope this round) — defaults to included, see
      // pageChatMessages's doc comment.
      const opts =
        (args[1] as
          { beforeTs?: number; limit?: number; includeSidechains?: boolean } | undefined) ?? {}
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

import { get } from 'svelte/store'
import type { BackendKind, Session, Status, Source, Ticket } from '../types'
import type { SessionDTO, WorktreeUpdateMode } from '../../../electron/shared/contract.js'
import { branchFor } from '../branch'
import {
  hasBackend,
  startSession,
  killSession,
  cleanupSession,
  worktreeStatus,
  worktreeUpdateFromBase,
  runApp,
} from '../ipc'
import { pushToast } from '../toast'
import { nativeStorage, DRAFTS_KEY } from '../nativeStorage'
import { cleanError } from './errors.js'
import { confirmDialog } from './confirmDialog.js'
import { appRunKey, setAppRunning, stopAppForSession } from './appRunner.js'
import { buzzNeedsYou } from '../haptics'
import { sessions } from './sessionsCore.js'
import { selectedId, select, dialogOpen, bootingId } from './ui.js'
import { repoById, openRepoSettings } from './repos.js'
import { tickets, refreshTickets } from './tickets.js'

// Re-exported under the same name so every other module (and the barrel)
// reaches the raw sessions writable through this file, without creating a
// module-init cycle — see sessionsCore.ts's doc comment.
export { sessions } from './sessionsCore.js'

/**
 * Every field on SessionDTO, mapped to `true`. This has no behavior of its
 * own — its only job is to force a compile error the moment SessionDTO
 * (electron/shared/contract.ts) gains a field, since TS requires every key of
 * SessionDTO to be present here. That is the guard: dtoToSession below is a
 * hand-maintained mapper, and a field left out of it silently vanishes with
 * no error, surfacing only after a reload/reconnect (this is exactly how
 * `mode` was originally missed — TASK-CIOEQ). When this object fails to
 * compile, decide whether the new field belongs on Session too (map it below)
 * or is legitimately server-only (list it here with a comment explaining why,
 * same as systemPrompt/opencodeSid/createdAt/ownerId already are).
 */
export const SESSION_DTO_FIELD_KEYS: Record<keyof SessionDTO, true> = {
  id: true,
  tid: true,
  title: true,
  prompt: true,
  repoId: true,
  branch: true,
  status: true,
  port: true,
  systemPrompt: true, // server-only: the launch-time prompt text, never shown in the UI
  agentKind: true,
  opencodeSid: true, // server-only: opencode/kilo embedded-server session id
  createdAt: true, // not surfaced on Session (relative "ago" is computed live elsewhere)
  ownerId: true, // server-only: identity-seam owner, irrelevant on the single-user client
  prUrl: true,
  src: true,
  parentId: true,
  mode: true,
}

/** Display label per ticket source, keyed exhaustively over `Source` (same
 *  "Record<T, true/value> forces every variant" pattern as
 *  SESSION_DTO_FIELD_KEYS above) so a new TicketSource can't silently fall
 *  through cleanupAgent's confirm-dialog copy without a label. Exported for
 *  unit testing. */
export const SRC_LABELS: Record<Source, string> = {
  jira: 'Jira',
  linear: 'Linear',
  github: 'GitHub',
  gitlab: 'GitLab',
}

/** Map a persisted SessionDTO to the renderer Session model. Exported so the
 *  src round-trip is unit-testable. Legacy rows with no persisted source
 *  default to 'jira'. */
export function dtoToSession(dto: SessionDTO): Session {
  // Used to pessimistically relabel a persisted 'running'/'needs' status as
  // 'detached', guessing that a daemon restart had orphaned the process and a
  // corrective live `status` push would arrive shortly to fix it back up. That
  // guess is now stale: restoreInterruptedSessions (electron/services/sessionStore.ts)
  // runs at daemon boot, before any RPC is served, and converts any genuinely
  // orphaned running/needs session to 'interrupted' first. So a 'running'/'needs'
  // status reported here is already known-live — trust it directly, exactly like
  // every subsequent live update already does via setSessionStatus. Guessing
  // 'detached' instead could stick indefinitely for poll-driven backends
  // (pi/opencode/kilo) that don't self-correct via the PTY-driven status flap.
  const uiStatus = dto.status as Status
  return {
    id: dto.id,
    tid: dto.tid,
    src: (dto.src ?? 'jira') as Source,
    status: uiStatus,
    title: dto.title,
    repo: dto.repoId,
    branch: dto.branch,
    add: 0,
    del: 0,
    behind: 0,
    ago: '',
    prompt: dto.prompt,
    port: dto.port,
    agentKind: dto.agentKind,
    prUrl: dto.prUrl,
    // TASK-CIOEQ: the session that spawned this one via `slipstream new-agent`.
    // dtoToSession silently drops any field left unmapped here, and the gap
    // only shows up after a reload/reconnect — see dtoToSession's own doc
    // comment above (and SESSION_DTO_FIELD_KEYS, the compile-time guard
    // against forgetting one).
    parentId: dto.parentId,
    // 'chat' selects a "blank chat" session (TASK-CIOEQ); undefined is the
    // existing ticket-backed flow. This is the field that motivated
    // SESSION_DTO_FIELD_KEYS above — it round-tripped through the backend
    // (migrations.ts/sessionStore.ts) but was originally never mapped here.
    mode: dto.mode,
    activity: {
      text:
        uiStatus === 'interrupted'
          ? 'Interrupted by restart — open to resume.'
          : uiStatus === 'reaped'
            ? 'Reaped by the cost guard.'
            : uiStatus === 'queued'
              ? 'Queued — will start when an agent slot frees.'
              : 'Detached — open to resume.',
    },
  }
}

/**
 * FLO-114: local drafts (status 'idle', created by createAgentFromTicket /
 * createBlankAgent) exist only in the renderer store — the backend never
 * persists a session row until startSession is called, and startSession
 * always returns status 'running'/'queued'. So a draft can never appear in
 * `dtos`, and re-seeding sessions from the backend must preserve any current
 * drafts rather than `sessions.set()`-ing over them, or a WS reconnect (or a
 * retried initial load) silently deletes whatever the user is typing.
 */
export function mergeSessionsPreservingDrafts(dtos: SessionDTO[]): Session[] {
  const freshIds = new Set(dtos.map((d) => d.id))
  const drafts = get(sessions).filter(
    (s) => s.status === 'idle' && (s.id === undefined || !freshIds.has(s.id)),
  )
  return [...drafts, ...dtos.map(dtoToSession)]
}

const DRAFT_PERSIST_DEBOUNCE_MS = 500
let draftPersistTimer: ReturnType<typeof setTimeout> | undefined

/**
 * FLO-114: a page reload drops the renderer store entirely, so — unlike the
 * WS-reconnect case above — there is no in-memory draft left to preserve.
 * Best-effort snapshot every current 'idle' draft to nativeStorage so
 * loadPersistedDrafts() can restore it on the next boot. Fire-and-forget:
 * losing a draft-persistence write must never surface as an error to the
 * user typing a kickoff prompt.
 */
function persistDraftsNow(): void {
  const drafts = get(sessions).filter((s) => s.status === 'idle')
  const write = drafts.length
    ? nativeStorage.set(DRAFTS_KEY, JSON.stringify(drafts))
    : nativeStorage.remove(DRAFTS_KEY)
  write.catch(() => {})
}

/** Debounced persistDraftsNow(), for high-frequency callers (prompt typing). */
function schedulePersistDrafts(): void {
  clearTimeout(draftPersistTimer)
  draftPersistTimer = setTimeout(persistDraftsNow, DRAFT_PERSIST_DEBOUNCE_MS)
}

/** Restore drafts saved by a previous session that were never started or
 *  discarded. Best-effort: any missing/malformed value yields no drafts,
 *  never a thrown error. */
export async function loadPersistedDrafts(): Promise<Session[]> {
  try {
    const raw = await nativeStorage.get(DRAFTS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (s): s is Session => !!s && typeof s === 'object' && (s as Session).status === 'idle',
    )
  } catch {
    return []
  }
}

/** Live-sync an in-progress draft's kickoff prompt into the store as the
 *  user types (FLO-114), so the debounced persistDraftsNow() snapshot holds
 *  the actual in-progress text rather than the placeholder set at draft
 *  creation. No-op once the session has left 'idle' (started/discarded). */
export function updateDraftPrompt(id: string, prompt: string): void {
  let changed = false
  sessions.update(($s) =>
    $s.map((s) => {
      if (s.id !== id || s.status !== 'idle') return s
      changed = true
      return { ...s, prompt }
    }),
  )
  if (changed) schedulePersistDrafts()
}

export function patch(id: string, fn: (s: Session) => Session) {
  sessions.update(($s) => $s.map((s) => (s.id === id ? fn(s) : s)))
}

export function createAgentFromTicket(
  ticket: Ticket,
  prompt: string,
  agentKind: BackendKind = 'claude-code',
  opts?: { select?: boolean },
): string {
  const doSelect = opts?.select ?? true
  const id = crypto.randomUUID()
  tickets.update(($t) => $t.filter((t) => t.tid !== ticket.tid))
  sessions.update(($s) => [
    {
      id,
      tid: ticket.tid,
      src: ticket.src,
      status: 'idle' as Status,
      title: ticket.title,
      repo: null,
      suggestedRepo: ticket.repo,
      branch: null,
      add: 0,
      del: 0,
      behind: 0,
      ago: 'draft',
      prompt,
      description: ticket.description,
      activity: { text: 'Not started.' },
      agentKind,
    },
    ...$s,
  ])
  persistDraftsNow()
  if (doSelect) {
    dialogOpen.set(false)
    select(id)
  }
  return id
}

export function createBlankAgent(
  title: string,
  prompt: string,
  tid: string = `TASK-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
  agentKind: BackendKind = 'claude-code',
): string {
  const id = crypto.randomUUID()
  sessions.update(($s) => [
    {
      id,
      tid,
      src: 'jira',
      status: 'idle',
      title,
      repo: null,
      branch: null,
      add: 0,
      del: 0,
      behind: 0,
      ago: 'draft',
      prompt,
      activity: { text: 'Not started.' },
      agentKind,
    },
    ...$s,
  ])
  persistDraftsNow()
  dialogOpen.set(false)
  select(id)
  return id
}

/**
 * Escape hatch for a draft session created via createAgentFromTicket/createBlankAgent:
 * only acts on an untouched 'idle' draft, drops it from the sidebar, deselects it if
 * selected, and — when the draft was seeded from a real ticket — refreshes the ticket
 * list so the backend's copy (which was never actually removed, just locally filtered
 * out) reappears in the launchpad.
 */
export function discardDraft(s: Session): void {
  if (s.status !== 'idle') return
  const cameFromTicket = s.suggestedRepo !== undefined
  sessions.update(($s) => $s.filter((x) => x.id !== s.id))
  persistDraftsNow()
  if (get(selectedId) === s.id) select(null)
  if (cameFromTicket && hasBackend) {
    refreshTickets()
  }
  pushToast('success', `Discarded draft ${s.tid}`)
}

export async function startAgent(
  id: string,
  repoId: string,
  prompt: string,
  agentKind?: BackendKind,
  extraArgs?: string,
  // TASK-CIOEQ: 'chat' tells the daemon to launch a blank, conversational
  // session (no ticket framing, no ticket-provider transition) instead of
  // the default ticket-flavoured start. Threaded straight through to
  // startSession's input below.
  mode?: 'chat',
) {
  const s = get(sessions).find((x) => x.id === id)
  if (!s) return

  if (hasBackend) {
    // Only the agent the user is actively watching start gets the Nulliel
    // booting screen — batch-launched agents (startAgentsFromTickets) are
    // never selected, so bootingId stays null for them and they don't flash a
    // global loader. (TASK-RAHTX)
    const foreground = get(selectedId) === id
    if (foreground) bootingId.set(id)
    // Optimistically update to show activity before the async call resolves.
    patch(id, (s) => ({
      ...s,
      repo: repoId,
      prompt,
      status: 'running',
      ago: 'just now',
      activity: { text: 'Creating worktree & starting claude…' },
    }))
    // No longer a draft — drop it from persisted storage now, not just once
    // the async startSession below resolves (FLO-114).
    persistDraftsNow()
    try {
      const dto = await startSession({
        tid: s.tid,
        title: s.title,
        prompt,
        repoId,
        description: s.description,
        agentKind,
        sessionId: id,
        src: s.src,
        extraArgs,
        mode,
      })
      patch(id, (s) => ({
        ...s,
        id: dto.id,
        branch: dto.branch,
        port: dto.port,
        agentKind: dto.agentKind,
        repo: repoId,
        status: dto.status,
        activity:
          dto.status === 'queued'
            ? { text: 'Queued — will start when an agent slot frees.' }
            : s.activity,
      }))
      if (dto.status === 'queued') {
        pushToast('success', `Queued ${s.tid} — starts when a slot frees`)
      }
    } catch (err) {
      patch(id, (s) => ({
        ...s,
        status: 'errored',
        activity: { text: cleanError(err) },
      }))
      pushToast('error', cleanError(err))
    } finally {
      if (foreground) bootingId.set(null)
    }
  } else {
    // Mock path — simulate immediately.
    patch(id, (s) => ({
      ...s,
      repo: repoId,
      prompt,
      branch: branchFor(s.tid, s.title),
      agentKind,
      status: 'running',
      ago: 'just now',
      activity: { text: 'Creating worktree & starting claude…' },
    }))
    persistDraftsNow()
  }
}

/** Readable "Chat" title stamped with a short local date/time, e.g.
 *  "Chat Jul 29, 3:45 PM" — TASK-CIOEQ's one-click blank-chat entry point. */
function chatSessionTitle(now: Date = new Date()): string {
  const datePart = now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const timePart = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `Chat ${datePart}, ${timePart}`
}

/**
 * TASK-CIOEQ: one-click "New chat" — mint a blank, chat-flavoured draft (tid
 * `CHAT-XXXXX`, a readable timestamped title, no ticket, no kickoff prompt)
 * and start it immediately against the chosen repo. Reuses createBlankAgent
 * (draft row + select) and startAgent (optimistic row + bootingId + error
 * handling) rather than duplicating their logic — the only new bit is
 * threading `mode: 'chat'` through so the backend launches a blank
 * conversational session instead of a ticket-framed one. The backend already
 * treats an empty prompt as "no positional arg, open interactively", so no
 * placeholder prompt is invented here.
 */
export async function startChatAgent(repoId: string): Promise<void> {
  const tid = `CHAT-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
  const title = chatSessionTitle()
  const id = createBlankAgent(title, '', tid)
  await startAgent(id, repoId, '', undefined, undefined, 'chat')
}

/** FLO-95 batch flow: launch agents for every ticket whose repo hint matches a
 *  registered repo, without stealing selection/closing dialogs per ticket. The
 *  backend scheduler queues starts beyond the concurrency cap and drains them. */
export async function startAgentsFromTickets(
  ts: Ticket[],
  agentKind: BackendKind = 'claude-code',
): Promise<number> {
  let started = 0
  for (const t of ts) {
    const repo = repoById(t.repo)
    if (!repo) continue
    const prompt = `Begin implementing ${t.tid}.`
    const id = createAgentFromTicket(t, prompt, agentKind, { select: false })
    await startAgent(id, repo.id, prompt, agentKind)
    started++
  }
  return started
}

/** Update the PR/MR URL of the session identified by its backend UUID. */
export function setSessionPrUrl(id: string, prUrl: string) {
  sessions.update(($s) => $s.map((s) => (s.id === id ? { ...s, prUrl } : s)))
}

/** Record that a session's run was handed off to a different agent (FLO-102). */
export function setSessionAgent(id: string, agentKind: BackendKind) {
  sessions.update(($s) => $s.map((s) => (s.id === id ? { ...s, agentKind } : s)))
}

// FLO-105: per-session set of desktop-notification kinds already fired this
// episode. The status detector's heuristics flap on idle TUIs (screen repaint →
// running, quiet prompt → needs, repeat), so a per-transition check re-notifies
// forever. Each kind fires at most once per episode; an episode ends on real
// user input (markSessionInput, wired to the writeSession IPC path) or session
// exit/reap. Mirrors pushService.ts's `notified` map — the documented
// reference (ARCHITECTURE.md §Session status pipeline).
const notified = new Map<string, Set<'needs' | 'done'>>()

/** Update the status of the session identified by its backend UUID. */
export function setSessionStatus(id: string, status: Status) {
  let prev: Status | undefined
  let title: string | undefined
  sessions.update(($s) =>
    $s.map((s) => {
      if (s.id !== id) return s
      prev = s.status
      title = s.title
      // A tearing-down session is being removed by cleanupAgent; ignore any
      // backend status push (e.g. the PTY-exit flap when it's killed) so the
      // "Tearing down" loading state doesn't flicker to running/done before
      // the row is dropped. (TASK-RAHTX)
      if (s.status === 'tearing-down') return s
      // FLO-105: needsSince is episode-scoped, not transition-scoped. Stamp it
      // on the FIRST entry into 'needs' this episode and PRESERVE it across the
      // needs→running→needs heuristic flap, so Mission Control's "waiting Xm"
      // shows when the agent actually went idle rather than snapping back to 0
      // on every re-entry. It's cleared on real user input (markSessionInput)
      // and on session reap/removal — never on a transition out of 'needs',
      // which is what caused the label to flicker.
      if (status === 'needs' && prev !== 'needs' && s.needsSince === undefined) {
        return { ...s, status, needsSince: Date.now() }
      }
      return { ...s, status }
    }),
  )
  // Reaped sessions are terminal: drop their episode tracking so the map can't
  // grow unboundedly across the renderer's lifetime.
  if (status === 'reaped') {
    notified.delete(id)
    return
  }
  if (prev !== status && (status === 'needs' || status === 'done')) {
    // Per-episode dedupe (FLO-105): without this, the needs↔running flap on an
    // idle TUI fires a fresh "Agent needs you" Notification every few seconds.
    const seen = notified.get(id)
    if (seen?.has(status)) return
    const next = new Set(seen)
    next.add(status)
    notified.set(id, next)
    // FLO-161: haptic buzz on the same per-episode dedupe as the desktop
    // notification below, but independent of it — notifyTransition() early-
    // returns when the bare `Notification` API is unavailable/ungranted,
    // which must never suppress the native haptic on mobile.
    if (status === 'needs') buzzNeedsYou()
    notifyTransition(status, title)
  }
}

/**
 * FLO-105: re-arm per-episode desktop-notification + needsSince tracking for a
 * session. Called on the writeSession path (real user input) — the renderer
 * equivalent of the backend `input` session event that re-arms pushService.ts's
 * `notified` map. Without this, the next genuine needs/done transition after the
 * user responds would be silently swallowed by the per-episode dedupe, and the
 * "waiting Xm" clock would keep counting from the stale pre-response entry.
 */
export function markSessionInput(id: string) {
  notified.delete(id)
  sessions.update(($s) => $s.map((s) => (s.id === id ? { ...s, needsSince: undefined } : s)))
}

/**
 * Best-effort desktop notification; silently no-ops if unavailable/not yet granted.
 * Permission is requested only from a user gesture in the settings UI
 * (src/lib/push.ts `enablePush`, invoked from SettingsNotifications.svelte's Enable
 * button) — browsers require a gesture for Notification.requestPermission(), so this
 * status-transition handler must never call it itself.
 */
function notifyTransition(status: 'needs' | 'done', title?: string) {
  try {
    if (typeof Notification === 'undefined') return
    if (Notification.permission !== 'granted') return
    const heading = status === 'needs' ? 'Agent needs you' : 'Agent finished'
    new Notification(heading, { body: title ?? '' })
  } catch {
    /* notifications unsupported — ignore */
  }
}

/** Remove a session by its backend UUID from the store. */
export function removeSession(id: string) {
  // FLO-105: drop per-episode notification tracking so the map can't grow
  // unboundedly as sessions come and go.
  notified.delete(id)
  sessions.update(($s) => $s.filter((s) => s.id !== id))
}

export function resolveNeedsInput(id: string) {
  patch(id, (s) => ({
    ...s,
    status: 'running',
    activity: { text: 'Applying decision, writing the fix…' },
  }))
}

/**
 * Shared agent teardown: kill the PTY, remove worktree+branch via the backend,
 * and drop it from the sidebar. `auto` (refresh-driven) SKIPS a dirty/unmerged
 * worktree and surfaces a warning instead of removing it — force-destroying
 * unpushed agent work behind the user's back is a data-loss bug. Only the
 * manual trash path force-removes, and only after the user confirms.
 */
export async function cleanupAgent(s: Session, opts?: { auto?: boolean }): Promise<boolean> {
  if (!hasBackend || !s.id) {
    sessions.update(($s) => $s.filter((x) => x.id !== s.id))
    if (get(selectedId) === s.id) select(null)
    return true
  }
  // Manual path only: confirm before tearing the agent down. Auto-reconcile
  // (refresh-driven) must stay non-blocking. If the agent is linked to a real
  // ticket, remind the user to update the ticket status too — cleanup doesn't
  // touch the tracker, so an in-progress ticket would otherwise go stale.
  if (!opts?.auto) {
    const hasTicket = !s.tid.startsWith('TASK-')
    const srcLabel = SRC_LABELS[s.src]
    const ok = await confirmDialog({
      title: 'Clean up agent?',
      message: hasTicket
        ? `This stops ${s.tid} and removes its worktree and branch. It's linked to a ${srcLabel} ticket — remember to update the ticket status there too.`
        : `This stops ${s.tid} and removes its worktree and branch.`,
      confirmLabel: 'Clean up',
      danger: true,
    })
    if (!ok) return false
  }
  // Manual teardown confirmed (or auto-reconcile). Only the MANUAL path
  // (TASK-RAHTX) flips the agent to the optimistic 'tearing-down' loading
  // state + bounces the user to mission control on confirm — auto-reconcile
  // is a background refresh and must stay non-disruptive (no tearing-down
  // flash, no yanking the user off whatever they're viewing). The row is
  // dropped once kill + cleanup finish below.
  const prevStatus = s.status
  const revert = () => {
    if (s.id) patch(s.id, (x) => ({ ...x, status: prevStatus }))
  }
  if (!opts?.auto) {
    if (s.id) patch(s.id, (x) => ({ ...x, status: 'tearing-down' }))
    if (get(selectedId) === s.id) select(null)
  }
  try {
    await killSession(s.id)
    let result = await cleanupSession(s.id, { force: false })
    if (!result.removed) {
      const reason = result.reason ?? 'uncommitted changes or unmerged commits'
      if (opts?.auto) {
        // Never force-destroy a dirty/unmerged worktree during auto-reconcile —
        // that silently discards unpushed agent work. Skip and surface a warning.
        patch(s.id, (x) => ({ ...x, reconcileWarning: reason }))
        revert()
        pushToast('warning', `Kept ${s.tid}: worktree not clean (${reason})`)
        return false
      }
      const ok = await confirmDialog({
        title: 'Force remove worktree?',
        message: `The worktree for ${s.tid} isn't clean. Force-removing discards any uncommitted changes and unmerged commits.`,
        detail: reason,
        confirmLabel: 'Force remove',
        danger: true,
      })
      if (!ok) {
        revert()
        return false
      }
      result = await cleanupSession(s.id, { force: true })
    }
    if (result.removed) {
      removeSession(s.id)
      if (get(selectedId) === s.id) select(null)
      pushToast('success', `Cleaned up ${s.tid}`)
      return true
    }
    revert()
    return false
  } catch (e) {
    revert()
    pushToast('error', cleanError(e))
    return false
  }
}

/** Bring a session's worktree up to date with its repo base. Rebase is the
 *  default; merge is the alternative. Conflicts are aborted backend-side —
 *  the worktree is never left mid-operation. */
export async function updateAgentFromBase(s: Session, mode: WorktreeUpdateMode): Promise<boolean> {
  if (!hasBackend || !s.repo || !s.branch) return false
  const base = repoById(s.repo)?.base ?? 'base'
  try {
    const res = await worktreeUpdateFromBase(s.repo, s.branch, mode)
    const info = res.info
    if (info && s.id) {
      patch(s.id, (x) => ({ ...x, behind: info.behind, add: info.added, del: info.deleted }))
    }
    if (res.stashSaved) {
      pushToast(
        'warning',
        'Uncommitted changes conflicted when re-applying — they are saved in the git stash (`git stash pop` to recover).',
      )
    }
    if (res.updated) {
      pushToast(
        'success',
        mode === 'rebase'
          ? `${s.tid}: rebased ${s.branch} onto ${base}`
          : `${s.tid}: merged ${base} into ${s.branch}`,
      )
      return true
    }
    pushToast('error', res.reason ?? `Could not update ${s.branch} from ${base}`)
    return false
  } catch (e) {
    pushToast('error', cleanError(e))
    return false
  }
}

/** Fetch real worktree diff stats for every started agent and update its +add/-del badge. */
export async function refreshDiffStats(): Promise<void> {
  if (!hasBackend) return
  const started = get(sessions).filter((s) => s.id && s.repo && s.branch)
  await Promise.all(
    started.map(async (s) => {
      try {
        const info = await worktreeStatus(s.repo as string, s.branch as string)
        patch(s.id as string, (x) => ({
          ...x,
          add: info.added,
          del: info.deleted,
          behind: info.behind,
        }))
      } catch {
        // leave existing values on failure
      }
    }),
  )
}

/** Run the app for a started session via its repo's start command. Opens that
 *  repo's settings if no start command is configured. */
export async function runAppForSession(s: Session): Promise<void> {
  if (!s.repo || !s.branch) return
  const key = appRunKey(s)
  try {
    const res = await runApp({ repoId: s.repo, branch: s.branch })
    if (res.started) {
      if (key) setAppRunning(key, true, res.url)
      if (res.reused) {
        pushToast('success', res.url ? `App already running at ${res.url}` : 'App already running')
      } else if (res.url) {
        pushToast('success', `Launched app at ${res.url}`)
      } else {
        pushToast('success', res.port ? `Launched app on port ${res.port}` : 'Launched app')
      }
    } else if (res.reason === 'no-start-command') {
      pushToast('error', 'No start command set for this repository. Configure it in settings.')
      openRepoSettings(s.repo)
    } else {
      pushToast('error', res.reason ?? 'Could not launch the app')
    }
  } catch (e) {
    pushToast('error', cleanError(e))
  }
}

/** Stop then restart the running dev-server app for a session. */
export async function restartAppForSession(s: Session): Promise<void> {
  await stopAppForSession(s)
  await runAppForSession(s)
}

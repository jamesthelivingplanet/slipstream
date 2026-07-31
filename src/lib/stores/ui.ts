import { writable, derived } from 'svelte/store'
import { statusBucket } from '../types'
import type { Filter } from '../types'
import { sessions } from './sessionsCore.js'

export const selectedId = writable<string | null>(null)
export const filter = writable<Filter>('all')
export const query = writable<string>('')
export const dialogOpen = writable<boolean>(false)
// TASK-CIOEQ: the "New chat" panel — deliberately separate from `dialogOpen`
// (the New Agent dialog) so the two entry points never fight over the same
// open/close state.
export const chatDialogOpen = writable<boolean>(false)
export const settingsOpen = writable<boolean>(false)
export const settingsRepoId = writable<string | null>(null)
// FLO-97: the Run history view, toggled from the header.
export const historyOpen = writable<boolean>(false)

/** The session id currently booting up (creating its worktree + spawning its
 *  agent), or null. Set by `startAgent` for a foreground (selected) start and
 *  cleared once the backend `startSession` resolves — drives the Nulliel
 *  loading screen over that agent's terminal (TASK-RAHTX). Batch starts
 *  (startAgentsFromTickets) never select, so they never set this. */
export const bootingId = writable<string | null>(null)

/** True when the viewport is at or below the mobile breakpoint. Synced from App.svelte. */
export const mobile = writable<boolean>(false)

/** Height (px) of the on-screen keyboard overlapping the viewport (mobile). Synced from App.svelte. */
export const keyboardInset = writable<number>(0)

/** True when the viewport is at or below the drawer breakpoint (≤900px), meaning
 *  the agent list sidebar should be a toggleable overlay drawer. Synced from App.svelte. */
export const drawer = writable<boolean>(false)

/** True when the WS transport is up (FLO-108). Defaults true so design mode
 *  (no backend) never shows a disconnected banner — subscribeConnectionChange
 *  is the only writer, and it's a no-op without hasBackend. */
export const connected = writable<boolean>(true)

// FLO-56: the header refresh button doubles as the agent-content fetch indicator.
// TicketStatusBar reports its ticket-status fetch here so the header can show loading/resolved.
export const contentLoading = writable<boolean>(false)
// Bumped (to Date.now()) each time a content fetch resolves successfully; header shows a brief check mark.
export const contentResolvedAt = writable<number>(0)
// Bumped by the header refresh button to force a re-fetch of the selected agent's content.
export const contentRefreshNonce = writable<number>(0)

export const selected = derived([sessions, selectedId], ([$sessions, $id]) =>
  $id ? ($sessions.find((s) => s.id === $id) ?? null) : null,
)

export const counts = derived(sessions, ($sessions) => {
  const c = { all: $sessions.length, needs: 0, running: 0, done: 0 } as Record<string, number>
  for (const s of $sessions) {
    const bucket = statusBucket(s.status)
    if (bucket) c[bucket] += 1
  }
  return c
})

export const visible = derived([sessions, filter, query], ([$sessions, $filter, $query]) => {
  const q = $query.toLowerCase()
  return $sessions.filter(
    (s) =>
      ($filter === 'all' || statusBucket(s.status) === $filter) &&
      (s.title.toLowerCase().includes(q) || s.tid.toLowerCase().includes(q)),
  )
})

export function select(tid: string | null) {
  selectedId.set(tid)
  if (tid) historyOpen.set(false)
}

/** Deep-link entry point (TASK-F0TYG): opens the agent a notification points
 *  at. Shared by every notification transport that can deliver a tap/click —
 *  the service-worker 'open-agent' message (App.svelte), the `?agent=` query
 *  param set by the SW's notificationclick before it opens/focuses a window
 *  (App.svelte), and the native FCM pushNotificationActionPerformed listener
 *  (push.ts) — so they all land on the exact same behavior instead of each
 *  reimplementing "select this session". */
export function openAgentById(sessionId: string) {
  select(sessionId)
}

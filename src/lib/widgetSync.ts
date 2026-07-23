import { repoById, sessions, openAgentById } from './stores'
import { statusBucket, STATUS_LABEL, type Session } from './types'

// ── Home-screen widget sync (TASK-DM25C) ────────────────────────────────────
//
// Mirrors the live `sessions` store into a small on-device snapshot the
// native AppWidgetProvider renders — no network, no auth token on the
// widget side. Session titles/statuses are what the widget is FOR showing on
// the home screen; the auth token is the actual secret, and it never leaves
// the WebView (see nativeStorage.ts / push.ts for the same feature-detection
// pattern this module follows: window.Capacitor only exists inside the
// Capacitor mobile shell, never in a plain browser tab or the Electron
// renderer loading this same bundle).
//
// Freshness ceiling: the snapshot only updates while this page is alive
// (foreground or backgrounded-but-not-killed). That's an accepted v1
// tradeoff — it avoids minting any credential the widget process could leak,
// and avoids a new polling-friendly backend endpoint. The widget shows
// `updatedAt` so a stale snapshot reads as stale rather than as fact.

interface AppControlPluginListenerHandle {
  remove(): void | Promise<void>
}

interface AppControlPlugin {
  syncWidget(options: { snapshotJson: string; updatedAt: number }): Promise<void>
  // Fired by MainActivity.relayAgentIdToWebView() (native, not a syncWidget
  // caller) when a widget row is tapped while the app is already running —
  // see AppControlPlugin.notifyOpenAgent() on the native side. The
  // cold-start case (app not yet running) instead arrives via the
  // `?agent=` query param on the initial page load, same as the
  // push-notification tap path — see App.svelte's onMount.
  addListener(
    eventName: 'openAgent',
    listenerFunc: (data: { agentId: string }) => void,
  ): Promise<AppControlPluginListenerHandle>
}

// Cast through `unknown` rather than extending the global `Window.Capacitor`
// type (already declared in push.ts) — redeclaring that interface member
// here with a different shape would conflict under declaration merging.
function capacitorGlobal():
  | { isPluginAvailable?(name: string): boolean; Plugins?: { AppControl?: AppControlPlugin } }
  | undefined {
  return (window as unknown as { Capacitor?: unknown }).Capacitor as
    | { isPluginAvailable?(name: string): boolean; Plugins?: { AppControl?: AppControlPlugin } }
    | undefined
}

function widgetPlugin(): AppControlPlugin | undefined {
  return capacitorGlobal()?.Plugins?.AppControl
}

// Shared by both subscribeWidgetSync() and subscribeWidgetAgentOpen() — both
// need the same "is the AppControl plugin actually available" check before
// touching window.Capacitor.Plugins.AppControl.
function appControlAvailable(): boolean {
  return typeof window !== 'undefined' && !!capacitorGlobal()?.isPluginAvailable?.('AppControl')
}

/** Bucket priority for the widget's ordering: things needing attention float
 *  to the top, same triage order as the sidebar's segmented filter. */
const BUCKET_ORDER: Record<'needs' | 'running' | 'done' | 'idle', number> = {
  needs: 0,
  running: 1,
  done: 2,
  idle: 3,
}

/** Cap what we ship over the bridge — a home screen widget only has room for
 *  a handful of rows, and this keeps the JSON blob (round-tripped through
 *  SharedPreferences) small. */
const MAX_WIDGET_SESSIONS = 20

export interface WidgetSessionSnapshotEntry {
  id: string
  tid: string
  title: string
  repo: string | null
  bucket: 'needs' | 'running' | 'done' | 'idle'
  statusLabel: string
}

export interface WidgetCounts {
  needs: number
  running: number
  done: number
}

/** The native side renders a status-first ledger line ("2 need you · 1
 *  running") from `counts` rather than a static title — computed here, once,
 *  from the same statusBucket() the app's own sidebar counts use, so the
 *  widget and the app can never disagree about what "needs you" means. */
export interface WidgetSnapshot {
  sessions: WidgetSessionSnapshotEntry[]
  counts: WidgetCounts
}

function toEntry(s: Session & { id: string }): WidgetSessionSnapshotEntry {
  const repo = repoById(s.repo)
  return {
    id: s.id,
    tid: s.tid,
    title: s.title,
    repo: repo ? `${repo.org}/${repo.name}` : null,
    bucket: statusBucket(s.status) ?? 'idle',
    statusLabel: STATUS_LABEL[s.status],
  }
}

function toSnapshot(list: Session[]): WidgetSnapshot {
  const counts: WidgetCounts = { needs: 0, running: 0, done: 0 }
  for (const s of list) {
    const bucket = statusBucket(s.status)
    if (bucket) counts[bucket] += 1
  }

  const entries = list
    .filter((s): s is Session & { id: string } => !!s.id)
    .map(toEntry)
    .sort((a, b) => BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket])
    .slice(0, MAX_WIDGET_SESSIONS)

  return { sessions: entries, counts }
}

let pendingList: Session[] | null = null
let flushTimer: ReturnType<typeof setTimeout> | undefined

function flush(list: Session[]) {
  const plugin = widgetPlugin()
  if (!plugin) return
  plugin
    .syncWidget({
      snapshotJson: JSON.stringify(toSnapshot(list)),
      updatedAt: Date.now(),
    })
    .catch(() => {
      // best-effort — the widget just keeps showing its last synced snapshot
    })
}

// Schedules at most one pending flush at a time. Deliberately does NOT
// reset/reschedule the timer on every call — see subscribeWidgetSync()'s
// doc comment for why a reset-on-every-change debounce is wrong here.
function scheduleFlush() {
  if (flushTimer !== undefined) return // already scheduled — the next fire picks up the latest pendingList
  flushTimer = setTimeout(() => {
    flushTimer = undefined
    if (pendingList) flush(pendingList)
  }, 4000)
}

/** Subscribe to the sessions store and push a throttled (leading-edge,
 *  periodic-trailing-flush) snapshot to the native widget bridge. No-ops
 *  outside the Capacitor mobile shell. Returns an unsubscribe function, same
 *  shape as the other subscribeX() helpers in stores.ts.
 *
 *  This is a THROTTLE, not a debounce: the first emission in a quiet period
 *  starts a 4s timer that is never reset by later emissions — it only
 *  records the latest list and fires on schedule. A session's status can
 *  flap several times a second while its PTY is chatty, and can keep
 *  flapping indefinitely (see CLAUDE.md's "Session status flaps by
 *  design — never time-window dedupe a status consumer" gotcha); a
 *  reset-on-every-change debounce would have its timer perpetually
 *  cancelled and restarted by that flapping and could starve forever,
 *  leaving the widget silently stuck on a stale snapshot. Throttling
 *  guarantees a flush at least once every ~4s of continuous activity while
 *  still coalescing bursts within that window into a single native call. */
export function subscribeWidgetSync(): () => void {
  if (!appControlAvailable()) return () => {}

  const unsubscribe = sessions.subscribe((list) => {
    pendingList = list
    scheduleFlush()
  })

  return () => {
    clearTimeout(flushTimer)
    flushTimer = undefined
    pendingList = null
    unsubscribe()
  }
}

// Tracks the plugin instance we've already bound the 'openAgent' listener on
// (rather than a plain boolean) so repeated subscribeWidgetAgentOpen() calls
// against the SAME bridge don't double-register — mirrors push.ts's
// listenersBoundFor for the exact same reason.
let agentOpenListenerBoundFor: AppControlPlugin | null = null
let agentOpenListenerHandle: AppControlPluginListenerHandle | null = null

/** Warm-start half of the widget row-tap deep link (TASK-DM25C): when the
 *  app is already running, MainActivity can't use the CapConfig start-path
 *  trick (that only affects the WebView's *first* load), so it relays the
 *  tapped session's id natively via AppControlPlugin.notifyOpenAgent() —
 *  this listens for that event and opens the agent directly, the same
 *  openAgentById() the FCM push-tap path (push.ts) and the `?agent=` cold-
 *  start query param (App.svelte) both use, so every entry point converges
 *  on identical behavior. No-ops outside the Capacitor mobile shell. Returns
 *  an unsubscribe function, same shape as subscribeWidgetSync(). */
export function subscribeWidgetAgentOpen(): () => void {
  if (!appControlAvailable()) return () => {}
  const plugin = widgetPlugin()
  if (!plugin) return () => {}

  if (agentOpenListenerBoundFor !== plugin) {
    agentOpenListenerBoundFor = plugin
    agentOpenListenerHandle = null
    plugin
      .addListener('openAgent', (data) => {
        if (data?.agentId) openAgentById(data.agentId)
      })
      .then((handle) => {
        agentOpenListenerHandle = handle
      })
      .catch(() => {
        // best-effort — a widget tap while this failed to bind just falls
        // back to opening the app without deep-linking, no worse than before
      })
  }

  return () => {
    agentOpenListenerHandle?.remove()
    agentOpenListenerHandle = null
    agentOpenListenerBoundFor = null
  }
}

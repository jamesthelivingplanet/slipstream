import { sessions } from './stores'
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

interface AppControlPlugin {
  syncWidget(options: { sessionsJson: string; updatedAt: number }): Promise<void>
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

function widgetSyncAvailable(): boolean {
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
  title: string
  repo: string | null
  bucket: 'needs' | 'running' | 'done' | 'idle'
  statusLabel: string
}

function toSnapshot(list: Session[]): WidgetSessionSnapshotEntry[] {
  return list
    .filter((s): s is Session & { id: string } => !!s.id)
    .map((s): WidgetSessionSnapshotEntry => ({
      id: s.id,
      title: s.title,
      repo: s.repo,
      bucket: statusBucket(s.status) ?? 'idle',
      statusLabel: STATUS_LABEL[s.status],
    }))
    .sort((a, b) => BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket])
    .slice(0, MAX_WIDGET_SESSIONS)
}

let debounceTimer: ReturnType<typeof setTimeout> | undefined

function flush(list: Session[]) {
  const plugin = widgetPlugin()
  if (!plugin) return
  plugin
    .syncWidget({
      sessionsJson: JSON.stringify(toSnapshot(list)),
      updatedAt: Date.now(),
    })
    .catch(() => {
      // best-effort — the widget just keeps showing its last synced snapshot
    })
}

/** Subscribe to the sessions store and push a debounced snapshot to the
 *  native widget bridge. No-ops outside the Capacitor mobile shell. Returns
 *  an unsubscribe function, same shape as the other subscribeX() helpers in
 *  stores.ts. Debounced (rather than reacting to every change) because a
 *  session's status can flap several times a second while a PTY is chatty
 *  (see the status-flapping gotcha) — this is a level-based render, not a
 *  one-shot side effect, so coalescing rapid updates is the correct
 *  trade-off, not a correctness issue. */
export function subscribeWidgetSync(): () => void {
  if (!widgetSyncAvailable()) return () => {}

  const unsubscribe = sessions.subscribe((list) => {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => flush(list), 4000)
  })

  return () => {
    clearTimeout(debounceTimer)
    unsubscribe()
  }
}

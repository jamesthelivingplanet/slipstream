import { writable } from 'svelte/store'
import type { Session } from '../types'
import { hasBackend, stopApp, appStatus } from '../ipc'
import { pushToast } from '../toast'
import { cleanError } from './errors.js'

/** Sessions with a currently running dev-server app, keyed by "<repo> <branch>"
 *  (matching the backend's app-runner key). Svelte 4 reactivity on a Set needs
 *  reassignment, so `add`/`remove` always replace the Set instance. */
export const runningApps = writable<Set<string>>(new Set())

/** Stable key for the runningApps set. Returns null when repo/branch aren't set yet. */
export function appRunKey(s: Session): string | null {
  return s.repo && s.branch ? `${s.repo} ${s.branch}` : null
}

/** Tailnet URLs of running apps (from `tailscale serve`), keyed like runningApps. */
export const appUrls = writable<Record<string, string>>({})

export function setAppRunning(key: string, running: boolean, url?: string) {
  runningApps.update(($r) => {
    const next = new Set($r)
    if (running) next.add(key)
    else next.delete(key)
    return next
  })
  appUrls.update(($u) => {
    const next = { ...$u }
    if (running && url) next[key] = url
    else delete next[key]
    return next
  })
}

/** Stop the running dev-server app for a session. */
export async function stopAppForSession(s: Session): Promise<void> {
  if (!hasBackend || !s.repo || !s.branch) return
  const key = appRunKey(s)
  try {
    const res = await stopApp({ repoId: s.repo, branch: s.branch })
    if (res.stopped) {
      if (key) setAppRunning(key, false)
      pushToast('success', 'Stopped app')
    }
  } catch (e) {
    pushToast('error', cleanError(e))
  }
}

/** Hydrate runningApps for a session from the backend — call when a session's
 *  terminal is opened/changed so the Run/Stop buttons reflect reality after reload. */
export async function refreshAppStatus(s: Session): Promise<void> {
  if (!hasBackend || !s.repo || !s.branch) return
  const key = appRunKey(s)
  if (!key) return
  try {
    const res = await appStatus({ repoId: s.repo, branch: s.branch })
    setAppRunning(key, res.running, res.url)
  } catch {
    // leave existing state on failure
  }
}

import { writable, get } from 'svelte/store'
import type { Repo } from '../types'
import {
  pickAndRegisterRepo,
  registerRepo as ipcRegisterRepo,
  registerRepoByUrl as ipcRegisterRepoByUrl,
  removeRepo,
} from '../ipc'
import { pushToast } from '../toast'
import { cleanError } from './errors.js'
import { confirmDialog } from './confirmDialog.js'
import { sessions } from './sessionsCore.js'
import { settingsOpen, settingsRepoId } from './ui.js'

export const repos = writable<Repo[]>([])

/** Look up a repo by id from the current store value. */
export function repoById(id: string | null | undefined): Repo | undefined {
  if (!id) return undefined
  return get(repos).find((r) => r.id === id)
}

export function openRepoSettings(repoId: string) {
  settingsRepoId.set(repoId)
  settingsOpen.set(true)
}

/** Insert or replace a repo summary in the store, keyed by id (registration is
 *  idempotent backend-side, so re-registering must not duplicate the row). */
function upsertRepoEntry(dto: { id: string; org: string; name: string; base: string }): void {
  const entry = { id: dto.id, org: dto.org, name: dto.name, base: dto.base }
  repos.update(($r) => {
    const i = $r.findIndex((r) => r.id === entry.id)
    if (i === -1) return [...$r, entry]
    const next = [...$r]
    next[i] = entry
    return next
  })
}

/** Open the native folder picker and register the chosen repo. */
export async function registerRepo(): Promise<void> {
  try {
    const dto = await pickAndRegisterRepo()
    if (!dto) return
    upsertRepoEntry(dto)
    pushToast('success', `Imported ${dto.org}/${dto.name} · ${dto.base}`)
  } catch (e) {
    pushToast('error', cleanError(e))
  }
}

/** Web fallback: register a repo by typing an absolute path directly. */
export async function registerRepoByPath(absPath: string): Promise<void> {
  try {
    const dto = await ipcRegisterRepo(absPath)
    upsertRepoEntry(dto)
    pushToast('success', `Imported ${dto.org}/${dto.name} · ${dto.base}`)
  } catch (e) {
    pushToast('error', cleanError(e))
  }
}

/** Clone & register a repo from its git remote URL. Works in web and desktop. */
export async function registerRepoByUrl(remoteUrl: string): Promise<void> {
  try {
    const dto = await ipcRegisterRepoByUrl(remoteUrl)
    upsertRepoEntry(dto)
    pushToast('success', `Cloned ${dto.org}/${dto.name} · ${dto.base}`)
  } catch (e) {
    pushToast('error', cleanError(e))
  }
}

export async function removeRepoById(id: string): Promise<void> {
  const repo = repoById(id)
  const label = repo ? `${repo.org}/${repo.name}` : 'this repository'
  const liveSessions = get(sessions).filter((s) => s.repo === id)
  if (liveSessions.length > 0) {
    const n = liveSessions.length
    pushToast(
      'error',
      `Can't remove ${label}: ${n} session${n === 1 ? '' : 's'} still ${n === 1 ? 'references' : 'reference'} it. Clean those up first.`,
    )
    return
  }
  const ok = await confirmDialog({
    title: 'Remove repository?',
    message: `This untracks ${label} from Slipstream. It doesn't delete anything on disk.`,
    confirmLabel: 'Remove',
    danger: true,
  })
  if (!ok) return
  try {
    await removeRepo(id)
    repos.update(($r) => $r.filter((r) => r.id !== id))
    pushToast('success', 'Removed repository')
  } catch (e) {
    pushToast('error', cleanError(e))
  }
}

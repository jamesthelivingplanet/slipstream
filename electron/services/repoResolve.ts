import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RepoDTO } from '../shared/contract.js'

/** Get the origin remote URL for a checkout, or null when unset / not a git repo / path gone. */
export function getRemoteUrl(absPath: string): string | null {
  try {
    const url = execFileSync('git', ['-C', absPath, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
    }).trim()
    return url || null
  } catch {
    return null
  }
}

/** Clone `remoteUrl` into `dest`. Throws a clear error (with git's stderr) on
 *  failure — bad URL, auth, or network. The caller ensures `dest` does not
 *  already exist. */
export function cloneRepo(remoteUrl: string, dest: string): void {
  try {
    execFileSync('git', ['clone', remoteUrl, dest], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string }
    throw new Error(`Failed to clone ${remoteUrl}: ${(e.stderr ?? e.message ?? String(err)).trim()}`)
  }
}

/** True when absPath exists and is inside a git work tree. */
export function isWorkTree(absPath: string): boolean {
  if (!existsSync(absPath)) return false
  try {
    return execFileSync('git', ['-C', absPath, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
    }).trim() === 'true'
  } catch {
    return false
  }
}

/**
 * Search the sibling directories of `storedPath` for a git checkout whose
 * origin remote URL matches `remoteUrl`. Returns the matching absolute path,
 * or null when no sibling matches. Used to self-heal a moved/renamed repo.
 */
export function findSiblingCheckout(remoteUrl: string, storedPath: string): string | null {
  const parent = dirname(storedPath)
  let entries: string[]
  try {
    entries = readdirSync(parent)
  } catch {
    return null
  }
  for (const entry of entries) {
    const candidate = join(parent, entry)
    try {
      if (!statSync(candidate).isDirectory()) continue
    } catch {
      continue
    }
    if (candidate === storedPath) continue
    if (getRemoteUrl(candidate) === remoteUrl && isWorkTree(candidate)) {
      return candidate
    }
  }
  return null
}

export interface ResolveResult {
  repo: RepoDTO
  healed: boolean
}

/**
 * Resolve the current on-disk path of a repo, self-healing when the stored
 * path no longer matches. Returns the resolved repo (path possibly updated)
 * or null when no checkout can be found. Pure of DB — the caller persists the
 * updated path when `healed` is true.
 */
export function resolveRepoPath(repo: RepoDTO): ResolveResult | null {
  if (isWorkTree(repo.path)) {
    const currentRemote = getRemoteUrl(repo.path)
    if (!repo.remoteUrl || currentRemote === repo.remoteUrl) {
      return { repo, healed: false }
    }
  }

  if (repo.remoteUrl) {
    const healed = findSiblingCheckout(repo.remoteUrl, repo.path)
    if (healed) {
      return { repo: { ...repo, path: healed }, healed: true }
    }
  }

  return null
}

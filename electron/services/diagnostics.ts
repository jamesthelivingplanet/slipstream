import { existsSync } from 'node:fs'
import { getRemoteUrl, isWorkTree } from './repoResolve.js'
import type { RepoDTO, RepoDiagnostic } from '../shared/contract.js'

export interface RepoProbes {
  exists(p: string): boolean
  isWorktree(p: string): boolean
  actualRemote(p: string): string | undefined
}

/** Real-fs/git probes for production use. Wraps getRemoteUrl's null-on-failure
 *  into undefined so RepoDiagnostic's optional-field convention is consistent. */
export const realRepoProbes: RepoProbes = {
  exists(p: string): boolean {
    return existsSync(p)
  },
  isWorktree(p: string): boolean {
    return isWorkTree(p)
  },
  actualRemote(p: string): string | undefined {
    try {
      return getRemoteUrl(p) ?? undefined
    } catch {
      return undefined
    }
  },
}

/** Trim, drop a trailing `.git`, drop a trailing slash — so equivalent remote
 *  URLs written in different styles compare equal. */
function normalizeRemote(url: string): string {
  return url
    .trim()
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
}

function remotesMatch(configured: string | undefined, actual: string | undefined): boolean {
  if (!configured && !actual) return true
  if (!configured || !actual) return false
  return normalizeRemote(configured) === normalizeRemote(actual)
}

/** Build per-repo diagnostics from the registered repo list, using injected
 *  probes so this is unit-testable without touching real fs/git. */
export function diagnoseRepos(repos: RepoDTO[], probes: RepoProbes): RepoDiagnostic[] {
  return repos.map((repo) => {
    const exists = probes.exists(repo.path)
    const worktree = probes.isWorktree(repo.path)
    const actualRemote = worktree ? probes.actualRemote(repo.path) : undefined
    return {
      id: repo.id,
      org: repo.org,
      name: repo.name,
      path: repo.path,
      exists,
      isWorktree: worktree,
      configuredRemote: repo.remoteUrl,
      actualRemote,
      remoteMatches: remotesMatch(repo.remoteUrl, actualRemote),
    }
  })
}

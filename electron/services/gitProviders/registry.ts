import type { GitHost } from '../../shared/contract.js'
import { github } from './github.js'
import { gitlab } from './gitlab.js'
import { bitbucket } from './bitbucket.js'
import { gitea } from './gitea.js'
import type { GitHostConfig, GitProvider } from './types.js'

/** Registration order also determines match precedence in resolveRemote/
 *  resolvePrUrl — irrelevant today since each provider only claims its own
 *  domain, but keep github/gitlab first (the common case) regardless. */
export const GIT_PROVIDERS: GitProvider[] = [github, gitlab, bitbucket, gitea]

export function providerFor(host: GitHost): GitProvider {
  const provider = GIT_PROVIDERS.find((p) => p.meta.id === host)
  if (!provider) throw new Error(`Unknown git host: ${host}`)
  return provider
}

/** Resolve a git remote URL to its owning provider + org/name, consulting
 *  each provider's own config (needed for baseUrl-matched self-hosted
 *  providers like Gitea). Returns null when no provider claims the domain. */
export function resolveRemote(
  remoteUrl: string,
  getCfg: (host: GitHost) => GitHostConfig,
): { host: GitHost; org: string; name: string } | null {
  for (const provider of GIT_PROVIDERS) {
    const match = provider.matchRemote(remoteUrl, getCfg(provider.meta.id))
    if (match) return { host: provider.meta.id, org: match.org, name: match.name }
  }
  return null
}

/** Same idea for a PR/MR URL. */
export function resolvePrUrl(
  url: string,
  getCfg: (host: GitHost) => GitHostConfig,
): { host: GitHost; org: string; name: string; number: number } | null {
  for (const provider of GIT_PROVIDERS) {
    const match = provider.matchPrUrl(url, getCfg(provider.meta.id))
    if (match) return { host: provider.meta.id, ...match }
  }
  return null
}

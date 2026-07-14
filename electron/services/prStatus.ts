/**
 * PR/MR status — FLO-96. After an agent hands off (opens a PR/MR), mission
 * control needs to know whether it merged, whether CI is green, and whether
 * it's been reviewed — independent of the agent session's own exit status.
 *
 * Pure mapping/aggregation functions live per-provider in gitProviders/*.ts
 * (TASK-7LGAO Phase 1 moved them there) and are re-exported below so existing
 * importers of './prStatus.js' keep working unchanged. This file is now just
 * the thin factory: never throws — a provider/network/parse failure surfaces
 * as an 'unknown' DTO with `error` set, so mission control can keep rendering
 * the states it does have.
 */
import type { GitHost, PrStatusDTO, SessionDTO } from '../shared/contract.js'
import type { IConfigStore } from './configStore.js'
import { resolvePrUrl, providerFor } from './gitProviders/registry.js'
import type { GitHostConfig } from './gitProviders/types.js'

export {
  aggregateGithubChecks,
  mapGithubCombinedStatus,
  mapGithubReviews,
} from './gitProviders/github.js'
export { mapGitlabPipelineStatus, mapGitlabMrState } from './gitProviders/gitlab.js'

/* ───────── parsing ───────── */

/** host-agnostic: domain recognition only, no per-host config needed for the
 *  hosts supported today (github.com/gitlab.com). Delegates to the provider
 *  registry so newly-registered providers are picked up automatically. */
export function parsePrUrl(
  url: string,
): { host: GitHost; org: string; name: string; number: number } | null {
  return resolvePrUrl(url, () => ({}))
}

/** Best-effort host guess for a PR URL that failed to parse — used only to
 *  pick a stable fallback host for the error DTO. Never throws. Gitea has no
 *  fixed domain, so it's recognized via the configured `gitea.baseUrl` host
 *  when a config lookup is provided. */
function guessHost(url: string, getCfg?: (host: GitHost) => GitHostConfig): GitHost {
  try {
    const hostname = new URL(url).hostname
    if (hostname === 'gitlab.com') return 'gitlab'
    if (hostname === 'bitbucket.org') return 'bitbucket'
    const giteaBase = getCfg?.('gitea').baseUrl
    if (giteaBase) {
      try {
        if (new URL(giteaBase).hostname === hostname) return 'gitea'
      } catch {
        // malformed baseUrl in config — ignore
      }
    }
  } catch {
    // not a valid URL at all — fall through to the stable default
  }
  return 'github'
}

/* ───────── service ───────── */

export interface IPrStatusService {
  get(session: Pick<SessionDTO, 'id' | 'prUrl'>): Promise<PrStatusDTO | null>
}

interface CacheEntry {
  dto: PrStatusDTO
  expiresAt: number
}

export function createPrStatusService(deps: {
  config: Pick<IConfigStore, 'get'>
  fetchFn?: typeof fetch
  ttlMs?: number
  now?: () => number
}): IPrStatusService {
  const fetchFn = deps.fetchFn ?? fetch
  const ttlMs = deps.ttlMs ?? 60_000
  const now = deps.now ?? Date.now
  // Keyed by prUrl (not sessionId): a repeated PR URL across polls hits one
  // cache entry, keeping mission control's per-session polling cheap.
  const cache = new Map<string, CacheEntry>()

  function getHostConfig(host: GitHost): GitHostConfig {
    return {
      token: deps.config.get(`${host}.token`),
      username: deps.config.get(`${host}.username`),
      baseUrl: deps.config.get(`${host}.baseUrl`),
    }
  }

  function unknownDto(sessionId: string, url: string, host: GitHost, error: string): PrStatusDTO {
    return {
      sessionId,
      url,
      host,
      state: 'unknown',
      ci: 'unknown',
      review: 'unknown',
      approvals: 0,
      checkedAt: now(),
      error,
    }
  }

  async function compute(sessionId: string, url: string): Promise<PrStatusDTO> {
    const parsed = resolvePrUrl(url, getHostConfig)
    if (!parsed) {
      return unknownDto(
        sessionId,
        url,
        guessHost(url, getHostConfig),
        `Cannot parse PR URL: ${url}`,
      )
    }

    const { host, org, name, number } = parsed
    const cfg = getHostConfig(host)
    if (!cfg.token) return unknownDto(sessionId, url, host, `No ${host} token configured`)

    try {
      const provider = providerFor(host)
      return await provider.fetchPrStatus({ fetchFn, now, sessionId, url, org, name, number, cfg })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return unknownDto(sessionId, url, host, msg)
    }
  }

  return {
    async get(session) {
      const url = session.prUrl
      if (!url) return null
      const sessionId = session.id
      const cached = cache.get(url)
      if (cached && cached.expiresAt > now()) return { ...cached.dto, sessionId }

      const dto = await compute(sessionId, url)
      cache.set(url, { dto, expiresAt: now() + ttlMs })
      return dto
    },
  }
}

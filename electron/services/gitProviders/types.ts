/**
 * Git-provider seam (TASK-7LGAO). Each provider owns the domain-matching,
 * push-URL, and API logic for one git host; `registry.ts` iterates
 * `GIT_PROVIDERS` to resolve a remote/PR URL to its owning provider.
 *
 * House style (mirrors gitDriver.ts/prStatus.ts pre-refactor): pure
 * descriptor/mapper functions are exported from each provider module for
 * unit testing, and the `GitProvider` object is a thin adapter over them.
 */
import type { GitHost, PrStatusDTO } from '../../shared/contract.js'

/** Per-host config as stored under `<host>.token` / `<host>.username` /
 *  `<host>.baseUrl` in the config store. All optional — a host may be
 *  unconfigured, and not every provider needs username/baseUrl. */
export interface GitHostConfig {
  token?: string
  username?: string
  baseUrl?: string
}

export interface GitProviderMeta {
  id: GitHost
  displayName: string
  /** Shown under the token input in Settings → Integrations. */
  tokenHint: string
  /** Bitbucket Cloud needs the account username alongside the app password/token. */
  needsUsername: boolean
  /** Self-hosted providers (Gitea/Forgejo) need the instance base URL. */
  needsBaseUrl: boolean
}

export interface GitProvider {
  meta: GitProviderMeta
  /** Does this remote URL belong to this provider? Returns the org/name when
   *  it matches (domain match; self-hosted providers consult `cfg.baseUrl`),
   *  null otherwise — never throws. */
  matchRemote(remoteUrl: string, cfg: GitHostConfig): { org: string; name: string } | null
  /** Same idea for a PR/MR URL, plus the PR/MR number. */
  matchPrUrl(url: string, cfg: GitHostConfig): { org: string; name: string; number: number } | null
  /** Authenticated https push URL (e.g. `https://oauth2:<token>@host/org/name.git`),
   *  or null when there isn't enough config to build one — callers fall back
   *  to a plain `git push -u origin <branch>`. */
  buildAuthPushUrl(remoteUrl: string, org: string, name: string, cfg: GitHostConfig): string | null
  /** Find-then-create a PR/MR for `branch` → `base`. */
  openMergeRequest(input: {
    org: string
    name: string
    branch: string
    base: string
    title: string
    body: string
    cfg: GitHostConfig
    fetchFn: typeof fetch
  }): Promise<{ url: string; isNew: boolean }>
  /** Fetch merge/CI/review state for an existing PR/MR. May throw — callers
   *  (prStatus.ts) wrap this in an 'unknown' DTO with `error` set. */
  fetchPrStatus(input: {
    fetchFn: typeof fetch
    now: () => number
    sessionId: string
    url: string
    org: string
    name: string
    number: number
    cfg: GitHostConfig
  }): Promise<PrStatusDTO>
}

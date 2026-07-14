import { execFile as _execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitHost } from '../shared/contract.js'
import { resolveRemote, providerFor } from './gitProviders/registry.js'
import type { GitHostConfig } from './gitProviders/types.js'

export type { GitHostConfig } from './gitProviders/types.js'
export type { GitProvider, GitProviderMeta } from './gitProviders/types.js'
export { GIT_PROVIDERS, providerFor, resolveRemote, resolvePrUrl } from './gitProviders/registry.js'

// Re-exported so existing tests/callers importing these pure descriptor
// functions from './gitDriver.js' keep working unchanged (TASK-7LGAO Phase 1
// moved the actual GitHub/GitLab logic into gitProviders/*.ts).
export {
  buildGithubCreatePrDescriptor,
  buildGithubFindPrDescriptor,
} from './gitProviders/github.js'
export {
  gitlabProjectPath,
  buildGitlabCreateMrDescriptor,
  buildGitlabFindMrDescriptor,
} from './gitProviders/gitlab.js'

const execFile = promisify(_execFile)

/** The CONFIG-LESS resolution path: recognizes fixed-domain hosts only
 *  (github.com/gitlab.com — providers whose matchRemote ignores config).
 *  Self-hosted providers like Gitea/Forgejo match via their stored baseUrl and
 *  will NEVER match here — use `resolveRemote(remoteUrl, getHostConfig)` with
 *  real config access for those (e.g. the CLI's open-mr resolver). Kept for
 *  backward compat with existing callers/tests. */
export function parseRemote(
  remoteUrl: string,
): { host: GitHost; org: string; name: string } | null {
  return resolveRemote(remoteUrl, () => ({}))
}

export function configKeyForHost(host: GitHost): string {
  return `${host}.token`
}

export function redact(s: string, token: string): string {
  if (!token) return s
  return s.split(token).join('***')
}

export interface GitDriver {
  push(cwd: string, branch: string, opts?: { token?: string; remoteUrl?: string }): Promise<void>
  openMergeRequest(input: {
    remoteUrl: string
    branch: string
    base: string
    title: string
    body: string
    token: string
  }): Promise<{ url: string; isNew: boolean }>
}

export interface GitDriverDeps {
  /** Full per-host config (token/username/baseUrl) — needed by providers
   *  beyond github/gitlab that push/authenticate with more than a bearer
   *  token. Defaults to token-only behavior (matches pre-TASK-7LGAO
   *  createGitDriver(), which only ever saw a token via call-site opts). */
  getHostConfig?: (host: GitHost) => GitHostConfig
}

export function createGitDriver(deps: GitDriverDeps = {}): GitDriver {
  const getHostConfig = deps.getHostConfig ?? ((): GitHostConfig => ({}))

  return {
    async push(cwd, branch, opts) {
      const token = opts?.token
      const remoteUrl = opts?.remoteUrl

      if (remoteUrl) {
        const parsed = resolveRemote(remoteUrl, getHostConfig)
        if (parsed) {
          const provider = providerFor(parsed.host)
          const cfg: GitHostConfig = {
            ...getHostConfig(parsed.host),
            ...(token ? { token } : {}),
          }
          const authUrl = provider.buildAuthPushUrl(remoteUrl, parsed.org, parsed.name, cfg)
          if (authUrl) {
            try {
              await execFile('git', ['-C', cwd, 'push', authUrl, `HEAD:refs/heads/${branch}`])
            } catch (err: unknown) {
              const e = err as { stderr?: string; message?: string }
              const msg = e.stderr ?? e.message ?? String(err)
              throw new Error(cfg.token ? redact(msg, cfg.token) : msg, { cause: err })
            }
            return
          }
        }
      }

      // SSH or fallback
      try {
        await execFile('git', ['-C', cwd, 'push', '-u', 'origin', branch])
      } catch (err: unknown) {
        const e = err as { stderr?: string; message?: string }
        const msg = e.stderr ?? e.message ?? String(err)
        throw new Error(token ? redact(msg, token) : msg, { cause: err })
      }
    },

    async openMergeRequest(input) {
      const { remoteUrl, branch, base, title, body, token } = input
      const parsed = resolveRemote(remoteUrl, getHostConfig)
      if (!parsed) throw new Error(`Cannot parse remote URL: ${remoteUrl}`)

      const { host, org, name } = parsed
      const provider = providerFor(host)
      const cfg: GitHostConfig = { ...getHostConfig(host), token }
      return provider.openMergeRequest({
        org,
        name,
        branch,
        base,
        title,
        body,
        cfg,
        fetchFn: fetch,
      })
    },
  }
}

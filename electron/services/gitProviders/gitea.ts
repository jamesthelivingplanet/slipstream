/**
 * Gitea / Forgejo provider (TASK-7LGAO Phase 2). Self-hosted — there's no
 * fixed domain, so matching and API calls are derived from `cfg.baseUrl`
 * (a private instance, or e.g. https://codeberg.org). Gitea's API is also
 * what Forgejo and Codeberg speak, so this provider covers all three.
 *
 * House style mirrors github.ts/gitlab.ts: pure descriptor/mapper functions
 * are exported here for unit testing, and the `GitProvider` object is a thin
 * adapter over them. Unlike github.ts/gitlab.ts, matching and auth depend on
 * `cfg.baseUrl`/`cfg.token` rather than a fixed domain — missing config
 * means matching returns null (never throws) while the action methods
 * (openMergeRequest/fetchPrStatus) throw a clear, user-facing error.
 */
import type { PrCiState, PrMergeState, PrReviewState, PrStatusDTO } from '../../shared/contract.js'
import type { GitHostConfig, GitProvider } from './types.js'

const MISSING_CONFIG_MESSAGE =
  'Gitea requires a base URL and access token — set them in Settings → Integrations.'

/** Trim, strip trailing slashes, and validate `baseUrl` is a well-formed
 *  http(s) URL. Returns the normalized (trailing-slash-free) string, or null
 *  when missing/unparseable/not http(s) — callers treat that as "not
 *  configured", so matching returns null rather than throwing. */
export function normalizeBaseUrl(baseUrl: string | undefined | null): string | null {
  if (!baseUrl) return null
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (!trimmed) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return trimmed
}

function apiRoot(instanceUrl: string): string {
  return `${instanceUrl}/api/v1`
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `token ${token}`, Accept: 'application/json' }
}

export function matchGiteaRemote(
  remoteUrl: string,
  cfg: GitHostConfig,
): { org: string; name: string } | null {
  const instanceUrl = normalizeBaseUrl(cfg.baseUrl)
  if (!instanceUrl) return null
  const parsed = new URL(instanceUrl)
  const host = parsed.host // includes port, for https matching
  const hostname = parsed.hostname // no port — SSH remotes never carry one

  const sshMatch = remoteUrl.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/)
  if (sshMatch && sshMatch[1] === hostname) {
    return { org: sshMatch[2], name: sshMatch[3] }
  }
  const httpsMatch = remoteUrl.match(/^https?:\/\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/)
  if (httpsMatch && httpsMatch[1] === host) {
    return { org: httpsMatch[2], name: httpsMatch[3] }
  }
  return null
}

export function matchGiteaPrUrl(
  url: string,
  cfg: GitHostConfig,
): { org: string; name: string; number: number } | null {
  const instanceUrl = normalizeBaseUrl(cfg.baseUrl)
  if (!instanceUrl) return null
  const escapedBase = instanceUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^${escapedBase}/([^/]+)/([^/]+)/pulls/(\\d+)(?:[/?].*)?$`)
  const m = url.match(re)
  if (!m) return null
  return { org: m[1], name: m[2], number: Number(m[3]) }
}

export function buildGiteaAuthPushUrl(
  remoteUrl: string,
  org: string,
  name: string,
  cfg: GitHostConfig,
): string | null {
  const instanceUrl = normalizeBaseUrl(cfg.baseUrl)
  if (!instanceUrl || !cfg.token) return null
  const parsed = new URL(instanceUrl)
  if (parsed.protocol !== 'https:') return null
  // Gitea accepts a PAT as the basic-auth password with the username
  // ignored; `oauth2` is the conventional placeholder (also used by
  // github.ts/gitlab.ts).
  return `https://oauth2:${encodeURIComponent(cfg.token)}@${parsed.host}/${org}/${name}.git`
}

export function buildGiteaFindPrDescriptor(params: {
  instanceUrl: string
  org: string
  name: string
  token: string
}): { url: string; method: string; headers: Record<string, string> } {
  return {
    url: `${apiRoot(params.instanceUrl)}/repos/${params.org}/${params.name}/pulls?state=open&limit=50`,
    method: 'GET',
    headers: authHeaders(params.token),
  }
}

export function buildGiteaCreatePrDescriptor(params: {
  instanceUrl: string
  org: string
  name: string
  branch: string
  base: string
  title: string
  body: string
  token: string
}): { url: string; method: string; headers: Record<string, string>; body: string } {
  return {
    url: `${apiRoot(params.instanceUrl)}/repos/${params.org}/${params.name}/pulls`,
    method: 'POST',
    headers: {
      ...authHeaders(params.token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: params.title,
      body: params.body,
      head: params.branch,
      base: params.base,
    }),
  }
}

export function mapGiteaMergeState(pr: { merged?: boolean; state?: string }): PrMergeState {
  if (pr.merged === true) return 'merged'
  if (pr.state === 'open') return 'open'
  if (pr.state === 'closed') return 'closed'
  return 'unknown'
}

export function mapGiteaCombinedStatus(state: string, totalCount: number): PrCiState {
  if (totalCount === 0) return 'none'
  if (state === 'success') return 'passed'
  if (state === 'failure' || state === 'error') return 'failed'
  if (state === 'pending') return 'pending'
  if (state === 'warning') return 'passed'
  return 'unknown'
}

export function mapGiteaReviews(
  reviews: Array<{ user: { login: string } | null; state: string }>,
): { review: PrReviewState; approvals: number } {
  // Latest non-COMMENT review per reviewer, keeping array (chronological) order.
  const latestByUser = new Map<string, string>()
  for (const r of reviews) {
    const login = r.user?.login
    if (!login || r.state === 'COMMENT') continue
    latestByUser.set(login, r.state)
  }
  const states = [...latestByUser.values()]
  const approvals = states.filter((s) => s === 'APPROVED').length
  if (states.includes('REQUEST_CHANGES')) return { review: 'changes_requested', approvals }
  if (approvals > 0) return { review: 'approved', approvals }
  return { review: 'none', approvals: 0 }
}

async function openGiteaMergeRequest(input: {
  org: string
  name: string
  branch: string
  base: string
  title: string
  body: string
  cfg: GitHostConfig
  fetchFn: typeof fetch
}): Promise<{ url: string; isNew: boolean }> {
  const { org, name, branch, base, title, body, cfg, fetchFn } = input
  const instanceUrl = normalizeBaseUrl(cfg.baseUrl)
  const token = cfg.token
  if (!instanceUrl || !token) throw new Error(MISSING_CONFIG_MESSAGE)

  const findDesc = buildGiteaFindPrDescriptor({ instanceUrl, org, name, token })
  const findRes = await fetchFn(findDesc.url, {
    method: findDesc.method,
    headers: findDesc.headers,
  })
  if (findRes.ok) {
    const prs = (await findRes.json()) as Array<{ html_url: string; head: { ref: string } }>
    const existing = prs.find((pr) => pr.head?.ref === branch)
    if (existing) {
      return { url: existing.html_url, isNew: false }
    }
  }

  const createDesc = buildGiteaCreatePrDescriptor({
    instanceUrl,
    org,
    name,
    branch,
    base,
    title,
    body,
    token,
  })
  const createRes = await fetchFn(createDesc.url, {
    method: createDesc.method,
    headers: createDesc.headers,
    body: createDesc.body,
  })
  if (!createRes.ok) {
    const errBody = await createRes.text()
    throw new Error(`Gitea PR creation failed (${createRes.status}): ${errBody}`)
  }
  const pr = (await createRes.json()) as { html_url: string }
  return { url: pr.html_url, isNew: true }
}

async function fetchGiteaPrStatus(input: {
  fetchFn: typeof fetch
  now: () => number
  sessionId: string
  url: string
  org: string
  name: string
  number: number
  cfg: GitHostConfig
}): Promise<PrStatusDTO> {
  const { fetchFn, now, sessionId, url, org, name, number, cfg } = input
  const instanceUrl = normalizeBaseUrl(cfg.baseUrl)
  const token = cfg.token
  if (!instanceUrl || !token) throw new Error(MISSING_CONFIG_MESSAGE)
  const headers = authHeaders(token)

  const prRes = await fetchFn(`${apiRoot(instanceUrl)}/repos/${org}/${name}/pulls/${number}`, {
    headers,
  })
  if (!prRes.ok) throw new Error(`Gitea PR fetch failed (${prRes.status})`)
  const pr = (await prRes.json()) as { state: string; merged?: boolean; head: { sha: string } }
  const state = mapGiteaMergeState(pr)
  const sha = pr.head.sha

  let ci: PrCiState = 'unknown'
  try {
    const statusRes = await fetchFn(
      `${apiRoot(instanceUrl)}/repos/${org}/${name}/commits/${sha}/status`,
      { headers },
    )
    if (statusRes.ok) {
      const body = (await statusRes.json()) as { state: string; statuses?: unknown[] }
      ci = mapGiteaCombinedStatus(body.state, body.statuses?.length ?? 0)
    }
  } catch {
    ci = 'unknown'
  }

  let review: PrReviewState = 'unknown'
  let approvals = 0
  try {
    const reviewsRes = await fetchFn(
      `${apiRoot(instanceUrl)}/repos/${org}/${name}/pulls/${number}/reviews`,
      { headers },
    )
    if (reviewsRes.ok) {
      const reviews = (await reviewsRes.json()) as Array<{
        user: { login: string } | null
        state: string
      }>
      const mapped = mapGiteaReviews(reviews)
      review = mapped.review
      approvals = mapped.approvals
    }
  } catch {
    review = 'unknown'
    approvals = 0
  }

  return { sessionId, url, host: 'gitea', state, ci, review, approvals, checkedAt: now() }
}

export const gitea: GitProvider = {
  meta: {
    id: 'gitea',
    displayName: 'Gitea / Forgejo',
    tokenHint:
      'Personal access token with repo scope. Also works for Forgejo and Codeberg instances.',
    needsUsername: false,
    needsBaseUrl: true,
  },
  matchRemote: (remoteUrl, cfg) => matchGiteaRemote(remoteUrl, cfg),
  matchPrUrl: (url, cfg) => matchGiteaPrUrl(url, cfg),
  buildAuthPushUrl: buildGiteaAuthPushUrl,
  openMergeRequest: openGiteaMergeRequest,
  fetchPrStatus: fetchGiteaPrStatus,
}

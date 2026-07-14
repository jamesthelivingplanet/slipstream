/**
 * GitHub Cloud provider. Descriptor/mapper functions moved here verbatim
 * from gitDriver.ts / prStatus.ts (TASK-7LGAO Phase 1) — behavior (including
 * the check-runs → combined-status CI fallback and review mapping) is
 * unchanged; gitDriver.ts/prStatus.ts re-export the pure functions so
 * existing tests keep passing unchanged.
 */
import type { PrCiState, PrMergeState, PrReviewState, PrStatusDTO } from '../../shared/contract.js'
import type { GitHostConfig, GitProvider } from './types.js'

const DOMAIN = 'github.com'

export function matchGithubRemote(remoteUrl: string): { org: string; name: string } | null {
  const sshMatch = remoteUrl.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/)
  if (sshMatch && sshMatch[1] === DOMAIN) {
    return { org: sshMatch[2], name: sshMatch[3] }
  }
  const httpsMatch = remoteUrl.match(/^https:\/\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/)
  if (httpsMatch && httpsMatch[1] === DOMAIN) {
    return { org: httpsMatch[2], name: httpsMatch[3] }
  }
  return null
}

export function matchGithubPrUrl(
  url: string,
): { org: string; name: string; number: number } | null {
  const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/)
  if (!m) return null
  return { org: m[1], name: m[2], number: Number(m[3]) }
}

export function buildGithubAuthPushUrl(
  remoteUrl: string,
  org: string,
  name: string,
  cfg: GitHostConfig,
): string | null {
  if (!cfg.token || !remoteUrl.startsWith('https://')) return null
  return `https://oauth2:${cfg.token}@${DOMAIN}/${org}/${name}.git`
}

export function buildGithubCreatePrDescriptor(params: {
  org: string
  name: string
  branch: string
  base: string
  title: string
  body: string
  token: string
}): { url: string; method: string; headers: Record<string, string>; body: string } {
  return {
    url: `https://api.github.com/repos/${params.org}/${params.name}/pulls`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: params.title,
      head: params.branch,
      base: params.base,
      body: params.body,
    }),
  }
}

export function buildGithubFindPrDescriptor(params: {
  org: string
  name: string
  org_login: string
  branch: string
  token: string
}): { url: string; method: string; headers: Record<string, string> } {
  return {
    url: `https://api.github.com/repos/${params.org}/${params.name}/pulls?state=open&head=${encodeURIComponent(params.org_login)}:${encodeURIComponent(params.branch)}`,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${params.token}`,
      Accept: 'application/vnd.github+json',
    },
  }
}

const GITHUB_CI_FAILURE_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
])

export function aggregateGithubChecks(
  runs: Array<{ status: string; conclusion: string | null }>,
): PrCiState {
  if (runs.length === 0) return 'none'
  if (runs.some((r) => r.status !== 'completed')) return 'running'
  if (runs.some((r) => r.conclusion !== null && GITHUB_CI_FAILURE_CONCLUSIONS.has(r.conclusion))) {
    return 'failed'
  }
  return 'passed'
}

export function mapGithubCombinedStatus(state: string, totalCount: number): PrCiState {
  if (totalCount === 0) return 'none'
  if (state === 'success') return 'passed'
  if (state === 'failure' || state === 'error') return 'failed'
  if (state === 'pending') return 'pending'
  return 'unknown'
}

export function mapGithubReviews(
  reviews: Array<{ user: { login: string } | null; state: string; submitted_at?: string }>,
): { review: PrReviewState; approvals: number } {
  // Latest non-COMMENTED review per reviewer, keeping array (chronological) order.
  const latestByUser = new Map<string, string>()
  for (const r of reviews) {
    const login = r.user?.login
    if (!login || r.state === 'COMMENTED') continue
    latestByUser.set(login, r.state)
  }
  const states = [...latestByUser.values()]
  const approvals = states.filter((s) => s === 'APPROVED').length
  if (states.includes('CHANGES_REQUESTED')) return { review: 'changes_requested', approvals }
  if (approvals > 0) return { review: 'approved', approvals }
  return { review: 'none', approvals: 0 }
}

async function githubCombinedStatus(
  fetchFn: typeof fetch,
  org: string,
  name: string,
  sha: string,
  headers: Record<string, string>,
): Promise<PrCiState> {
  const res = await fetchFn(`https://api.github.com/repos/${org}/${name}/commits/${sha}/status`, {
    headers,
  })
  if (!res.ok) throw new Error(`GitHub status fetch failed (${res.status})`)
  const body = (await res.json()) as { state: string; total_count: number }
  return mapGithubCombinedStatus(body.state, body.total_count)
}

async function openGithubMergeRequest(input: {
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
  const token = cfg.token
  if (!token) throw new Error('No github token configured')

  const findDesc = buildGithubFindPrDescriptor({ org, name, org_login: org, branch, token })
  const findRes = await fetchFn(findDesc.url, {
    method: findDesc.method,
    headers: findDesc.headers,
  })
  if (findRes.ok) {
    const prs = (await findRes.json()) as Array<{ html_url: string }>
    if (prs.length > 0) {
      return { url: prs[0].html_url, isNew: false }
    }
  }

  const createDesc = buildGithubCreatePrDescriptor({ org, name, branch, base, title, body, token })
  const createRes = await fetchFn(createDesc.url, {
    method: createDesc.method,
    headers: createDesc.headers,
    body: createDesc.body,
  })
  if (!createRes.ok) {
    const errBody = await createRes.text()
    throw new Error(`GitHub PR creation failed (${createRes.status}): ${errBody}`)
  }
  const pr = (await createRes.json()) as { html_url: string }
  return { url: pr.html_url, isNew: true }
}

async function fetchGithubPrStatus(input: {
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
  const token = cfg.token
  if (!token) throw new Error('No github token configured')
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }

  const prRes = await fetchFn(`https://api.github.com/repos/${org}/${name}/pulls/${number}`, {
    headers,
  })
  if (!prRes.ok) throw new Error(`GitHub PR fetch failed (${prRes.status})`)
  const pr = (await prRes.json()) as { state: string; merged: boolean; head: { sha: string } }
  const state: PrMergeState = pr.merged ? 'merged' : pr.state === 'open' ? 'open' : 'closed'
  const sha = pr.head.sha

  let ci: PrCiState = 'unknown'
  try {
    const checksRes = await fetchFn(
      `https://api.github.com/repos/${org}/${name}/commits/${sha}/check-runs`,
      { headers },
    )
    if (checksRes.ok) {
      const body = (await checksRes.json()) as {
        total_count: number
        check_runs: Array<{ status: string; conclusion: string | null }>
      }
      ci =
        body.total_count > 0
          ? aggregateGithubChecks(body.check_runs)
          : await githubCombinedStatus(fetchFn, org, name, sha, headers)
    } else {
      ci = await githubCombinedStatus(fetchFn, org, name, sha, headers)
    }
  } catch {
    try {
      ci = await githubCombinedStatus(fetchFn, org, name, sha, headers)
    } catch {
      ci = 'unknown'
    }
  }

  let review: PrReviewState = 'unknown'
  let approvals = 0
  try {
    const reviewsRes = await fetchFn(
      `https://api.github.com/repos/${org}/${name}/pulls/${number}/reviews?per_page=100`,
      { headers },
    )
    if (reviewsRes.ok) {
      const reviews = (await reviewsRes.json()) as Array<{
        user: { login: string } | null
        state: string
      }>
      const mapped = mapGithubReviews(reviews)
      review = mapped.review
      approvals = mapped.approvals
    }
  } catch {
    review = 'unknown'
    approvals = 0
  }

  return { sessionId, url, host: 'github', state, ci, review, approvals, checkedAt: now() }
}

export const github: GitProvider = {
  meta: {
    id: 'github',
    displayName: 'GitHub',
    tokenHint: 'Personal access token with repo scope.',
    needsUsername: false,
    needsBaseUrl: false,
  },
  matchRemote: (remoteUrl) => matchGithubRemote(remoteUrl),
  matchPrUrl: (url) => matchGithubPrUrl(url),
  buildAuthPushUrl: buildGithubAuthPushUrl,
  openMergeRequest: openGithubMergeRequest,
  fetchPrStatus: fetchGithubPrStatus,
}

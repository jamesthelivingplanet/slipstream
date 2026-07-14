/**
 * Bitbucket Cloud provider (TASK-7LGAO Phase 2). Same descriptor/mapper
 * house style as github.ts/gitlab.ts, but Bitbucket differs in a few ways
 * that shape this file:
 *  - Auth is HTTP Basic (username + app password/API token), not a bearer
 *    token, so every action method requires both `cfg.username` and
 *    `cfg.token` and throws a clear, user-facing Error when either is
 *    missing (caught by prStatus.ts/gitDriver.ts and surfaced as an error
 *    DTO/toast).
 *  - Review state (`participants[]`) comes back on the PR GET itself, no
 *    separate reviews call like GitHub/GitLab need.
 *  - CI is a flat `/statuses` list (no separate check-runs vs. combined-
 *    status fallback).
 */
import type { PrCiState, PrMergeState, PrReviewState, PrStatusDTO } from '../../shared/contract.js'
import type { GitHostConfig, GitProvider } from './types.js'

const DOMAIN = 'bitbucket.org'
const API_BASE = 'https://api.bitbucket.org/2.0'

export function matchBitbucketRemote(remoteUrl: string): { org: string; name: string } | null {
  const sshMatch = remoteUrl.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/)
  if (sshMatch && sshMatch[1] === DOMAIN) {
    return { org: sshMatch[2], name: sshMatch[3] }
  }
  // https remotes commonly embed userinfo (https://user@bitbucket.org/org/name.git).
  const httpsMatch = remoteUrl.match(/^https:\/\/(?:[^@/]+@)?([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/)
  if (httpsMatch && httpsMatch[1] === DOMAIN) {
    return { org: httpsMatch[2], name: httpsMatch[3] }
  }
  return null
}

export function matchBitbucketPrUrl(
  url: string,
): { org: string; name: string; number: number } | null {
  const m = url.match(/^https:\/\/bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)(?:\/|$)/)
  if (!m) return null
  return { org: m[1], name: m[2], number: Number(m[3]) }
}

export function buildBitbucketAuthPushUrl(
  remoteUrl: string,
  org: string,
  name: string,
  cfg: GitHostConfig,
): string | null {
  if (!cfg.username || !cfg.token || !remoteUrl.startsWith('https://')) return null
  return `https://${encodeURIComponent(cfg.username)}:${encodeURIComponent(cfg.token)}@${DOMAIN}/${org}/${name}.git`
}

export function basicAuthHeader(username: string, token: string): string {
  return `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`
}

export function buildBitbucketFindPrDescriptor(params: {
  org: string
  name: string
  branch: string
  username: string
  token: string
}): { url: string; method: string; headers: Record<string, string> } {
  const query = `source.branch.name = "${params.branch}" AND state = "OPEN"`
  return {
    url: `${API_BASE}/repositories/${params.org}/${params.name}/pullrequests?q=${encodeURIComponent(query)}`,
    method: 'GET',
    headers: {
      Authorization: basicAuthHeader(params.username, params.token),
    },
  }
}

export function buildBitbucketCreatePrDescriptor(params: {
  org: string
  name: string
  branch: string
  base: string
  title: string
  body: string
  username: string
  token: string
}): { url: string; method: string; headers: Record<string, string>; body: string } {
  return {
    url: `${API_BASE}/repositories/${params.org}/${params.name}/pullrequests`,
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(params.username, params.token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: params.title,
      description: params.body,
      source: { branch: { name: params.branch } },
      destination: { branch: { name: params.base } },
    }),
  }
}

export function mapBitbucketPrState(state: string): PrMergeState {
  if (state === 'OPEN') return 'open'
  if (state === 'MERGED') return 'merged'
  if (state === 'DECLINED' || state === 'SUPERSEDED') return 'closed'
  return 'unknown'
}

export function mapBitbucketReviews(
  participants: Array<{ approved: boolean; state: string | null }>,
): { review: PrReviewState; approvals: number } {
  const approvals = participants.filter((p) => p.approved === true).length
  if (participants.some((p) => p.state === 'changes_requested')) {
    return { review: 'changes_requested', approvals }
  }
  if (approvals > 0) return { review: 'approved', approvals }
  return { review: 'none', approvals: 0 }
}

export function aggregateBitbucketStatuses(statuses: Array<{ state: string }>): PrCiState {
  if (statuses.length === 0) return 'none'
  if (statuses.some((s) => s.state === 'INPROGRESS')) return 'running'
  if (statuses.some((s) => s.state === 'FAILED' || s.state === 'STOPPED')) return 'failed'
  return 'passed'
}

function requireBitbucketCreds(cfg: GitHostConfig): { username: string; token: string } {
  if (!cfg.username || !cfg.token) {
    throw new Error(
      'Bitbucket requires a username and app password/API token — set them in Settings → Integrations.',
    )
  }
  return { username: cfg.username, token: cfg.token }
}

async function openBitbucketMergeRequest(input: {
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
  const { username, token } = requireBitbucketCreds(cfg)

  const findDesc = buildBitbucketFindPrDescriptor({ org, name, branch, username, token })
  const findRes = await fetchFn(findDesc.url, {
    method: findDesc.method,
    headers: findDesc.headers,
  })
  if (findRes.ok) {
    const found = (await findRes.json()) as {
      values: Array<{ links: { html: { href: string } } }>
    }
    if (found.values.length > 0) {
      return { url: found.values[0].links.html.href, isNew: false }
    }
  }

  const createDesc = buildBitbucketCreatePrDescriptor({
    org,
    name,
    branch,
    base,
    title,
    body,
    username,
    token,
  })
  const createRes = await fetchFn(createDesc.url, {
    method: createDesc.method,
    headers: createDesc.headers,
    body: createDesc.body,
  })
  if (!createRes.ok) {
    const errBody = await createRes.text()
    throw new Error(`Bitbucket PR creation failed (${createRes.status}): ${errBody}`)
  }
  const pr = (await createRes.json()) as { links: { html: { href: string } } }
  return { url: pr.links.html.href, isNew: true }
}

async function fetchBitbucketPrStatus(input: {
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
  const { username, token } = requireBitbucketCreds(cfg)
  const headers = { Authorization: basicAuthHeader(username, token) }

  const prRes = await fetchFn(`${API_BASE}/repositories/${org}/${name}/pullrequests/${number}`, {
    headers,
  })
  if (!prRes.ok) throw new Error(`Bitbucket PR fetch failed (${prRes.status})`)
  const pr = (await prRes.json()) as {
    state: string
    participants?: Array<{ approved: boolean; state: string | null }>
  }
  const state = mapBitbucketPrState(pr.state)

  let review: PrReviewState = 'unknown'
  let approvals = 0
  try {
    const mapped = mapBitbucketReviews(pr.participants ?? [])
    review = mapped.review
    approvals = mapped.approvals
  } catch {
    review = 'unknown'
    approvals = 0
  }

  let ci: PrCiState = 'unknown'
  try {
    const statusesRes = await fetchFn(
      `${API_BASE}/repositories/${org}/${name}/pullrequests/${number}/statuses?pagelen=100`,
      { headers },
    )
    if (statusesRes.ok) {
      const body = (await statusesRes.json()) as { values: Array<{ state: string }> }
      ci = aggregateBitbucketStatuses(body.values)
    }
  } catch {
    ci = 'unknown'
  }

  return { sessionId, url, host: 'bitbucket', state, ci, review, approvals, checkedAt: now() }
}

export const bitbucket: GitProvider = {
  meta: {
    id: 'bitbucket',
    displayName: 'Bitbucket',
    tokenHint: 'App password with repository:write and pullrequest:write scopes.',
    needsUsername: true,
    needsBaseUrl: false,
  },
  matchRemote: (remoteUrl) => matchBitbucketRemote(remoteUrl),
  matchPrUrl: (url) => matchBitbucketPrUrl(url),
  buildAuthPushUrl: buildBitbucketAuthPushUrl,
  openMergeRequest: openBitbucketMergeRequest,
  fetchPrStatus: fetchBitbucketPrStatus,
}

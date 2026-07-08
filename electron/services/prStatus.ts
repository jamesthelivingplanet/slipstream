/**
 * PR/MR status — FLO-96. After an agent hands off (opens a PR/MR), mission
 * control needs to know whether it merged, whether CI is green, and whether
 * it's been reviewed — independent of the agent session's own exit status.
 *
 * Pure mapping/aggregation functions are exported and unit-tested in
 * isolation (mirrors the gitDriver.ts house style: pure descriptor/mapper
 * functions + a thin factory that does the actual fetches). The factory
 * never throws — a provider/network/parse failure surfaces as an 'unknown'
 * DTO with `error` set, so mission control can keep rendering the states it
 * does have.
 */
import type {
  GitHost,
  PrCiState,
  PrMergeState,
  PrReviewState,
  PrStatusDTO,
  SessionDTO,
} from '../shared/contract.js'
import type { IConfigStore } from './configStore.js'

/* ───────── parsing ───────── */

export function parsePrUrl(
  url: string,
): { host: GitHost; org: string; name: string; number: number } | null {
  const githubMatch = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/)
  if (githubMatch) {
    return {
      host: 'github',
      org: githubMatch[1],
      name: githubMatch[2],
      number: Number(githubMatch[3]),
    }
  }

  const gitlabMatch = url.match(/^https:\/\/gitlab\.com\/(.+)$/)
  if (gitlabMatch) {
    const rest = gitlabMatch[1]
    const modernSep = '/-/merge_requests/'
    const legacySep = '/merge_requests/'
    const idx = rest.includes(modernSep) ? rest.indexOf(modernSep) : rest.indexOf(legacySep)
    const sepLen = rest.includes(modernSep) ? modernSep.length : legacySep.length
    if (idx > 0) {
      const pathPart = rest.slice(0, idx)
      const tail = rest.slice(idx + sepLen)
      const numMatch = tail.match(/^(\d+)/)
      const segments = pathPart.split('/').filter(Boolean)
      if (numMatch && segments.length >= 2) {
        const name = segments[segments.length - 1]
        const org = segments.slice(0, -1).join('/')
        return { host: 'gitlab', org, name, number: Number(numMatch[1]) }
      }
    }
  }

  return null
}

function gitlabProjectPath(org: string, name: string): string {
  return encodeURIComponent(`${org}/${name}`)
}

/** Best-effort host guess for a PR URL that failed to parse — used only to
 *  pick a stable fallback host for the error DTO. Never throws. */
function guessHost(url: string): GitHost {
  try {
    const hostname = new URL(url).hostname
    if (hostname === 'gitlab.com') return 'gitlab'
  } catch {
    // not a valid URL at all — fall through to the stable default
  }
  return 'github'
}

/* ───────── pure mappers (unit-tested) ───────── */

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

const GITLAB_PENDING_STATUSES = new Set([
  'created',
  'pending',
  'waiting_for_resource',
  'preparing',
  'scheduled',
  'manual',
])

export function mapGitlabPipelineStatus(status: string | null | undefined): PrCiState {
  if (status === null || status === undefined) return 'none'
  if (status === 'success') return 'passed'
  if (status === 'failed' || status === 'canceled') return 'failed'
  if (status === 'running') return 'running'
  if (status === 'skipped') return 'none'
  if (GITLAB_PENDING_STATUSES.has(status)) return 'pending'
  return 'unknown'
}

export function mapGitlabMrState(state: string): PrMergeState {
  if (state === 'opened' || state === 'locked') return 'open'
  if (state === 'merged') return 'merged'
  if (state === 'closed') return 'closed'
  return 'unknown'
}

/* ───────── service ───────── */

export interface IPrStatusService {
  get(session: Pick<SessionDTO, 'id' | 'prUrl'>): Promise<PrStatusDTO | null>
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

async function fetchGithubStatus(params: {
  fetchFn: typeof fetch
  now: () => number
  sessionId: string
  url: string
  org: string
  name: string
  number: number
  token: string
}): Promise<PrStatusDTO> {
  const { fetchFn, now, sessionId, url, org, name, number, token } = params
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

async function fetchGitlabStatus(params: {
  fetchFn: typeof fetch
  now: () => number
  sessionId: string
  url: string
  org: string
  name: string
  number: number
  token: string
}): Promise<PrStatusDTO> {
  const { fetchFn, now, sessionId, url, org, name, number, token } = params
  const headers = { 'PRIVATE-TOKEN': token }
  const projectPath = gitlabProjectPath(org, name)

  const mrRes = await fetchFn(
    `https://gitlab.com/api/v4/projects/${projectPath}/merge_requests/${number}`,
    { headers },
  )
  if (!mrRes.ok) throw new Error(`GitLab MR fetch failed (${mrRes.status})`)
  const mr = (await mrRes.json()) as {
    state: string
    head_pipeline?: { status: string | null } | null
    pipeline?: { status: string | null } | null
  }
  const state = mapGitlabMrState(mr.state)
  const pipelineStatus = mr.head_pipeline?.status ?? mr.pipeline?.status ?? null
  const ci = mapGitlabPipelineStatus(pipelineStatus)

  let review: PrReviewState = 'unknown'
  let approvals = 0
  try {
    const apRes = await fetchFn(
      `https://gitlab.com/api/v4/projects/${projectPath}/merge_requests/${number}/approvals`,
      { headers },
    )
    if (apRes.ok) {
      const ap = (await apRes.json()) as { approved: boolean; approved_by: unknown[] }
      if (ap.approved) {
        review = 'approved'
        approvals = ap.approved_by.length
      } else {
        review = 'none'
        approvals = 0
      }
    }
  } catch {
    review = 'unknown'
    approvals = 0
  }

  return { sessionId, url, host: 'gitlab', state, ci, review, approvals, checkedAt: now() }
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
    const parsed = parsePrUrl(url)
    if (!parsed) return unknownDto(sessionId, url, guessHost(url), `Cannot parse PR URL: ${url}`)

    const { host, org, name, number } = parsed
    const token = deps.config.get(`${host}.token`)
    if (!token) return unknownDto(sessionId, url, host, `No ${host} token configured`)

    try {
      const fetchParams = { fetchFn, now, sessionId, url, org, name, number, token }
      return host === 'github'
        ? await fetchGithubStatus(fetchParams)
        : await fetchGitlabStatus(fetchParams)
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

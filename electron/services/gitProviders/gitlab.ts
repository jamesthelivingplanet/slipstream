/**
 * GitLab.com provider. Descriptor/mapper functions moved here verbatim from
 * gitDriver.ts / prStatus.ts (TASK-7LGAO Phase 1) — behavior (including the
 * head_pipeline → pipeline fallback) is unchanged; gitDriver.ts/prStatus.ts
 * re-export the pure functions so existing tests keep passing unchanged.
 */
import type { PrCiState, PrMergeState, PrReviewState, PrStatusDTO } from '../../shared/contract.js'
import type { GitHostConfig, GitProvider } from './types.js'

const DOMAIN = 'gitlab.com'

export function matchGitlabRemote(remoteUrl: string): { org: string; name: string } | null {
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

export function matchGitlabPrUrl(
  url: string,
): { org: string; name: string; number: number } | null {
  const gitlabMatch = url.match(/^https:\/\/gitlab\.com\/(.+)$/)
  if (!gitlabMatch) return null
  const rest = gitlabMatch[1]
  const modernSep = '/-/merge_requests/'
  const legacySep = '/merge_requests/'
  const idx = rest.includes(modernSep) ? rest.indexOf(modernSep) : rest.indexOf(legacySep)
  const sepLen = rest.includes(modernSep) ? modernSep.length : legacySep.length
  if (idx <= 0) return null
  const pathPart = rest.slice(0, idx)
  const tail = rest.slice(idx + sepLen)
  const numMatch = tail.match(/^(\d+)/)
  const segments = pathPart.split('/').filter(Boolean)
  if (!numMatch || segments.length < 2) return null
  const name = segments[segments.length - 1]
  const org = segments.slice(0, -1).join('/')
  return { org, name, number: Number(numMatch[1]) }
}

export function buildGitlabAuthPushUrl(
  remoteUrl: string,
  org: string,
  name: string,
  cfg: GitHostConfig,
): string | null {
  if (!cfg.token || !remoteUrl.startsWith('https://')) return null
  return `https://oauth2:${cfg.token}@${DOMAIN}/${org}/${name}.git`
}

export function gitlabProjectPath(org: string, name: string): string {
  return encodeURIComponent(`${org}/${name}`)
}

export function buildGitlabCreateMrDescriptor(params: {
  org: string
  name: string
  branch: string
  base: string
  title: string
  description: string
  token: string
}): { url: string; method: string; headers: Record<string, string>; body: string } {
  const projectPath = gitlabProjectPath(params.org, params.name)
  return {
    url: `https://gitlab.com/api/v4/projects/${projectPath}/merge_requests`,
    method: 'POST',
    headers: {
      'PRIVATE-TOKEN': params.token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      source_branch: params.branch,
      target_branch: params.base,
      title: params.title,
      description: params.description,
    }),
  }
}

export function buildGitlabFindMrDescriptor(params: {
  org: string
  name: string
  branch: string
  token: string
}): { url: string; method: string; headers: Record<string, string> } {
  const projectPath = gitlabProjectPath(params.org, params.name)
  return {
    url: `https://gitlab.com/api/v4/projects/${projectPath}/merge_requests?state=opened&source_branch=${encodeURIComponent(params.branch)}`,
    method: 'GET',
    headers: {
      'PRIVATE-TOKEN': params.token,
    },
  }
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

async function openGitlabMergeRequest(input: {
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
  if (!token) throw new Error('No gitlab token configured')

  const findDesc = buildGitlabFindMrDescriptor({ org, name, branch, token })
  const findRes = await fetchFn(findDesc.url, {
    method: findDesc.method,
    headers: findDesc.headers,
  })
  if (findRes.ok) {
    const mrs = (await findRes.json()) as Array<{ web_url: string }>
    if (mrs.length > 0) {
      return { url: mrs[0].web_url, isNew: false }
    }
  }

  const createDesc = buildGitlabCreateMrDescriptor({
    org,
    name,
    branch,
    base,
    title,
    description: body,
    token,
  })
  const createRes = await fetchFn(createDesc.url, {
    method: createDesc.method,
    headers: createDesc.headers,
    body: createDesc.body,
  })
  if (!createRes.ok) {
    const errBody = await createRes.text()
    throw new Error(`GitLab MR creation failed (${createRes.status}): ${errBody}`)
  }
  const mr = (await createRes.json()) as { web_url: string }
  return { url: mr.web_url, isNew: true }
}

async function fetchGitlabPrStatus(input: {
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
  if (!token) throw new Error('No gitlab token configured')
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

export const gitlab: GitProvider = {
  meta: {
    id: 'gitlab',
    displayName: 'GitLab',
    tokenHint: 'Personal access token with repo scope.',
    needsUsername: false,
    needsBaseUrl: false,
  },
  matchRemote: (remoteUrl) => matchGitlabRemote(remoteUrl),
  matchPrUrl: (url) => matchGitlabPrUrl(url),
  buildAuthPushUrl: buildGitlabAuthPushUrl,
  openMergeRequest: openGitlabMergeRequest,
  fetchPrStatus: fetchGitlabPrStatus,
}

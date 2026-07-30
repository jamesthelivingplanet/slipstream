import type {
  ITicketProvider,
  ScopeOption,
  TicketDTO,
  WorkflowState,
  PaginatedTickets,
  TicketSourceSettings,
} from '../shared/contract.js'
import type { IConfigStore } from '../services/configStore.js'

const API_ROOT = 'https://api.github.com'

interface GithubRepo {
  id: number
  full_name: string
}

interface GithubSearchIssue {
  id: number
  number: number
  title: string
  body?: string | null
  state: string
  repository_url: string
  pull_request?: unknown
}

interface GithubSearchResponse {
  total_count: number
  items: GithubSearchIssue[]
}

interface GithubIssue {
  id: number
  number: number
  title: string
  body?: string | null
  state: string
}

function parseRepos(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
}

/** GitHub issue tid format: "owner/repo#123" (mirrors how GitHub itself
 *  displays cross-repo references). Splits on the LAST '#' (issue titles
 *  can't contain one at that position since it's appended by us), then the
 *  owner/repo on the last '/' before it. */
export function parseGithubTid(tid: string): { owner: string; repo: string; number: number } {
  const hashIdx = tid.lastIndexOf('#')
  if (hashIdx <= 0 || hashIdx === tid.length - 1) {
    throw new Error(`Invalid GitHub ticket id: ${tid}`)
  }
  const ownerRepo = tid.slice(0, hashIdx)
  const number = Number(tid.slice(hashIdx + 1))
  if (isNaN(number)) {
    throw new Error(`Invalid GitHub ticket id: ${tid}`)
  }
  const slashIdx = ownerRepo.lastIndexOf('/')
  if (slashIdx <= 0 || slashIdx === ownerRepo.length - 1) {
    throw new Error(`Invalid GitHub ticket id: ${tid}`)
  }
  return { owner: ownerRepo.slice(0, slashIdx), repo: ownerRepo.slice(slashIdx + 1), number }
}

/** repository_url looks like "https://api.github.com/repos/owner/repo" — the
 *  owner/repo are its last two path segments. */
function parseRepoFromUrl(repositoryUrl: string): { owner: string; repo: string } {
  const segments = repositoryUrl.split('/')
  return { owner: segments[segments.length - 2] ?? '', repo: segments[segments.length - 1] ?? '' }
}

function toWorkflowState(state: string): WorkflowState {
  return {
    id: state,
    name: state === 'closed' ? 'Closed' : 'Open',
    type: state === 'closed' ? 'completed' : 'unstarted',
  }
}

function toTicketDTO(item: GithubSearchIssue): TicketDTO {
  const { owner, repo } = parseRepoFromUrl(item.repository_url)
  return {
    id: item.id.toString(),
    tid: `${owner}/${repo}#${item.number}`,
    src: 'github',
    title: item.title,
    description: item.body ?? undefined,
    done: item.state === 'closed',
    repoHint: `${owner}/${repo}`,
    status: toWorkflowState(item.state),
  }
}

const EMPTY_RESULT: PaginatedTickets = {
  tickets: [],
  totalCount: 0,
  page: 1,
  pageSize: 20,
  hasMore: false,
}

export function createGithubIssuesProvider(config: IConfigStore): ITicketProvider {
  function getToken(): string | undefined {
    return config.get('github.token') || undefined
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = getToken()
    if (!token) throw new Error('GitHub token not set')

    const res = await fetch(`${API_ROOT}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    })

    if (!res.ok) {
      throw new Error(`GitHub API error: ${res.status} ${res.statusText}`)
    }

    if (res.status === 204) return undefined as T
    const text = await res.text()
    if (!text) return undefined as T
    return JSON.parse(text) as T
  }

  return {
    id: 'github',

    async listScopes(): Promise<ScopeOption[]> {
      const repos = await request<GithubRepo[]>(
        '/user/repos?per_page=100&affiliation=owner,collaborator,organization_member',
      )
      return repos.map((r) => ({ id: r.id.toString(), key: r.full_name, name: r.full_name }))
    },

    async listTickets(opts?: {
      page?: number
      pageSize?: number
      query?: string
    }): Promise<PaginatedTickets> {
      if (!getToken()) return EMPTY_RESULT

      const repos = parseRepos(config.get('github.issueRepos'))
      const onlyMine = config.get('github.onlyMine') !== '0'

      // Safety: the GitHub Search Issues API has no per-token default scope —
      // with no repo scope AND no onlyMine filter there is no safe query to
      // build (it would search all of public GitHub). Same "empty, no fetch"
      // response as the unconfigured case rather than risk that.
      if (repos.length === 0 && !onlyMine) return EMPTY_RESULT

      const page = opts?.page ?? 1
      const pageSize = opts?.pageSize ?? 20

      const qParts = ['is:issue', 'state:open']
      for (const repo of repos) qParts.push(`repo:${repo}`)
      if (onlyMine) qParts.push('assignee:@me')
      if (opts?.query) qParts.push(opts.query)
      const q = qParts.join(' ')

      const data = await request<GithubSearchResponse>(
        `/search/issues?q=${encodeURIComponent(q)}&per_page=${pageSize}&page=${page}`,
      )

      const rawItems = data.items ?? []
      // The Search Issues API returns PRs too (they're issues under the hood) —
      // filter them out, issues only.
      const tickets = rawItems.filter((item) => !item.pull_request).map(toTicketDTO)
      const hasMore = rawItems.length >= pageSize

      return { tickets, totalCount: data.total_count ?? tickets.length, page, pageSize, hasMore }
    },

    async getTicketStatus(
      tid: string,
    ): Promise<{ current: WorkflowState | null; available: WorkflowState[] }> {
      const { owner, repo, number } = parseGithubTid(tid)
      const issue = await request<GithubIssue>(`/repos/${owner}/${repo}/issues/${number}`)
      const current = toWorkflowState(issue.state)
      const available = [toWorkflowState(issue.state === 'closed' ? 'open' : 'closed')]
      return { current, available }
    },

    async setTicketStatus(tid: string, stateId: string): Promise<WorkflowState> {
      const { owner, repo, number } = parseGithubTid(tid)
      const issue = await request<GithubIssue>(`/repos/${owner}/${repo}/issues/${number}`, {
        method: 'PATCH',
        body: JSON.stringify({ state: stateId }),
      })
      return toWorkflowState(issue.state)
    },

    // GitHub issues have no "in progress" state without Projects (out of
    // scope here) — this is the interface's documented "no transition
    // applies" branch, kept honest rather than pretending a richer workflow
    // exists.
    async startTicket(): Promise<WorkflowState | null> {
      return null
    },

    async resetTicket(): Promise<WorkflowState | null> {
      return null
    },

    async postComment(tid: string, body: string): Promise<boolean> {
      if (!getToken()) return false
      const { owner, repo, number } = parseGithubTid(tid)
      await request(`/repos/${owner}/${repo}/issues/${number}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      })
      return true
    },

    getSettings(): TicketSourceSettings {
      return {
        configured: !!getToken(),
        scopeKeys: parseRepos(config.get('github.issueRepos')),
        onlyMine: config.get('github.onlyMine') !== '0',
        // apiKey/baseUrl/email/apiToken are Linear/Jira-specific per
        // TicketSourceSettings' doc comment — GitHub's credential is the
        // shared git-host token (github.token), edited only via the
        // git-host card, never through this ticket-settings path.
        apiKey: '',
        baseUrl: '',
        email: '',
        apiToken: '',
      }
    },

    setSettings(cfg: TicketSourceSettings): void {
      // Credential fields intentionally ignored — see getSettings' comment
      // above: nothing here ever writes github.token.
      config.set('github.issueRepos', (cfg.scopeKeys ?? []).join(','))
      config.set('github.onlyMine', cfg.onlyMine === false ? '0' : '1')
    },
  }
}

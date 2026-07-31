import type {
  ITicketProvider,
  ScopeOption,
  TicketDTO,
  WorkflowState,
  PaginatedTickets,
  TicketSourceSettings,
} from '../shared/contract.js'
import type { IConfigStore } from '../services/configStore.js'
import { DEFAULT_OWNER_ID } from '../services/configStore.js'

const DEFAULT_BASE_URL = 'https://gitlab.com'

/** Caps how many 100-per-page fetches we'll do per project (or globally when
 *  unscoped) — mirrors jiraProvider.ts's 3-page cap on its cursor loop, to
 *  bound API calls rather than pull an unbounded issue list. */
const MAX_PAGES = 3
const PER_PAGE = 100

interface GitlabProject {
  id: number
  path_with_namespace: string
  name: string
}

interface GitlabIssue {
  id: number
  iid: number
  title: string
  description?: string | null
  state: string // 'opened' | 'closed'
  references: { full: string }
}

function parseProjects(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

/** GitLab issue tid: the full "group/project#123" reference GitLab itself
 *  reports (issue.references.full) — the whole prefix before the last '#' is
 *  the project path (which may contain subgroup segments), the suffix is the
 *  iid (the number GitLab shows users, not the global id). */
export function parseGitlabTid(tid: string): { path: string; iid: number } {
  const hashIdx = tid.lastIndexOf('#')
  if (hashIdx <= 0 || hashIdx === tid.length - 1) {
    throw new Error(`Invalid GitLab ticket id: ${tid}`)
  }
  const path = tid.slice(0, hashIdx)
  const iid = Number(tid.slice(hashIdx + 1))
  if (isNaN(iid)) {
    throw new Error(`Invalid GitLab ticket id: ${tid}`)
  }
  return { path, iid }
}

function toWorkflowState(issue: { state: string }): WorkflowState {
  // GitLab's own state vocabulary is 'opened'|'closed' (NOT 'open') — used
  // verbatim as the WorkflowState id, never translated, so a status
  // round-trip (getTicketStatus -> setTicketStatus) doesn't drift.
  return {
    id: issue.state,
    name: issue.state === 'opened' ? 'Open' : 'Closed',
    type: issue.state === 'opened' ? 'unstarted' : 'completed',
  }
}

function toTicketDTO(issue: GitlabIssue): TicketDTO {
  return {
    id: issue.id.toString(),
    tid: issue.references.full,
    src: 'gitlab',
    title: issue.title,
    description: issue.description ?? undefined,
    done: issue.state === 'closed',
    repoHint: issue.references.full.slice(0, issue.references.full.lastIndexOf('#')),
    status: toWorkflowState(issue),
  }
}

const EMPTY_RESULT: PaginatedTickets = {
  tickets: [],
  totalCount: 0,
  page: 1,
  pageSize: 20,
  hasMore: false,
}

export function createGitlabIssuesProvider(
  config: IConfigStore,
  ownerId: string = DEFAULT_OWNER_ID,
): ITicketProvider {
  function getToken(): string | undefined {
    return config.getForOwner!(ownerId, 'gitlab.token') || undefined
  }

  function getApiRoot(): string {
    const baseUrl = (config.getForOwner!(ownerId, 'gitlab.baseUrl') || DEFAULT_BASE_URL).replace(
      /\/+$/,
      '',
    )
    return `${baseUrl}/api/v4`
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = getToken()
    if (!token) throw new Error('GitLab token not set')

    const res = await fetch(`${getApiRoot()}${path}`, {
      ...init,
      headers: {
        'PRIVATE-TOKEN': token,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    })

    if (!res.ok) {
      throw new Error(`GitLab API error: ${res.status} ${res.statusText}`)
    }

    if (res.status === 204) return undefined as T
    const text = await res.text()
    if (!text) return undefined as T
    return JSON.parse(text) as T
  }

  /** Fetches up to MAX_PAGES pages (PER_PAGE each) from `basePath`, stopping
   *  early once a short page signals the end. */
  async function fetchPages(basePath: string): Promise<GitlabIssue[]> {
    const collected: GitlabIssue[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const items = await request<GitlabIssue[]>(`${basePath}&per_page=${PER_PAGE}&page=${page}`)
      collected.push(...items)
      if (items.length < PER_PAGE) break
    }
    return collected
  }

  return {
    id: 'gitlab',

    async listScopes(): Promise<ScopeOption[]> {
      const projects = await request<GitlabProject[]>(
        '/projects?membership=true&per_page=100&order_by=updated_at',
      )
      return projects.map((p) => ({
        id: p.id.toString(),
        key: p.path_with_namespace,
        name: p.name,
      }))
    },

    async listTickets(opts?: {
      page?: number
      pageSize?: number
      query?: string
    }): Promise<PaginatedTickets> {
      if (!getToken()) return EMPTY_RESULT

      const projects = parseProjects(config.getForOwner!(ownerId, 'gitlab.issueProjects'))
      const onlyMine = config.getForOwner!(ownerId, 'gitlab.onlyMine') !== '0'
      const scope = onlyMine ? 'assigned_to_me' : 'all'
      const searchParam = opts?.query ? `&search=${encodeURIComponent(opts.query)}` : ''

      const page = opts?.page ?? 1
      const pageSize = opts?.pageSize ?? 20

      // No project scope = the GLOBAL issues endpoint, which GitLab scopes to
      // the token's own visibility — same "no scope = everything visible to
      // me" default spirit as Linear/Jira (unlike GitHub's search, which has
      // no such per-token default and would otherwise need a repo filter).
      let allIssues: GitlabIssue[]
      if (projects.length > 0) {
        const perProject = await Promise.all(
          projects.map((p) =>
            fetchPages(
              `/projects/${encodeURIComponent(p)}/issues?state=opened&scope=${scope}${searchParam}`,
            ),
          ),
        )
        allIssues = perProject.flat()
      } else {
        allIssues = await fetchPages(`/issues?state=opened&scope=${scope}${searchParam}`)
      }

      // Fetch-then-slice client side, mirroring jiraProvider.ts's pagination
      // style (no cheap total-count-aware cursor across merged project lists).
      const tickets = allIssues.map(toTicketDTO)
      const start = (page - 1) * pageSize
      const end = start + pageSize
      const paginated = tickets.slice(start, end)

      return {
        tickets: paginated,
        totalCount: tickets.length,
        page,
        pageSize,
        hasMore: end < tickets.length,
      }
    },

    async getTicketStatus(
      tid: string,
    ): Promise<{ current: WorkflowState | null; available: WorkflowState[] }> {
      const { path, iid } = parseGitlabTid(tid)
      const issue = await request<GitlabIssue>(
        `/projects/${encodeURIComponent(path)}/issues/${iid}`,
      )
      const current = toWorkflowState(issue)
      const available = [toWorkflowState({ state: issue.state === 'opened' ? 'closed' : 'opened' })]
      return { current, available }
    },

    async setTicketStatus(tid: string, stateId: string): Promise<WorkflowState> {
      const { path, iid } = parseGitlabTid(tid)
      // GitLab's actual API takes a state_event ('close'/'reopen'), not the
      // state itself — translate from the WorkflowState id vocabulary
      // ('opened'/'closed') used everywhere else in this provider.
      const stateEvent = stateId === 'closed' ? 'close' : 'reopen'
      const issue = await request<GitlabIssue>(
        `/projects/${encodeURIComponent(path)}/issues/${iid}`,
        { method: 'PUT', body: JSON.stringify({ state_event: stateEvent }) },
      )
      return toWorkflowState(issue)
    },

    // GitLab issues have no built-in "in progress" state (that's a board/label
    // convention, not part of the issue's own state machine) — this is the
    // interface's documented "no transition applies" branch, same rationale
    // as githubIssuesProvider.ts.
    async startTicket(): Promise<WorkflowState | null> {
      return null
    },

    async resetTicket(): Promise<WorkflowState | null> {
      return null
    },

    async postComment(tid: string, body: string): Promise<boolean> {
      if (!getToken()) return false
      const { path, iid } = parseGitlabTid(tid)
      await request(`/projects/${encodeURIComponent(path)}/issues/${iid}/notes`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      })
      return true
    },

    getSettings(): TicketSourceSettings {
      return {
        configured: !!getToken(),
        scopeKeys: parseProjects(config.getForOwner!(ownerId, 'gitlab.issueProjects')),
        onlyMine: config.getForOwner!(ownerId, 'gitlab.onlyMine') !== '0',
        // apiKey/baseUrl/email/apiToken are Linear/Jira-specific per
        // TicketSourceSettings' doc comment — GitLab's credential (and base
        // URL, for self-hosted instances) is the shared git-host config
        // (gitlab.token/gitlab.baseUrl), edited only via the git-host card,
        // never through this ticket-settings path.
        apiKey: '',
        baseUrl: '',
        email: '',
        apiToken: '',
      }
    },

    setSettings(cfg: TicketSourceSettings): void {
      // Credential fields intentionally ignored — see getSettings' comment
      // above: nothing here ever writes gitlab.token/gitlab.baseUrl.
      config.setForOwner!(ownerId, 'gitlab.issueProjects', (cfg.scopeKeys ?? []).join(','))
      config.setForOwner!(ownerId, 'gitlab.onlyMine', cfg.onlyMine === false ? '0' : '1')
    },
  }
}

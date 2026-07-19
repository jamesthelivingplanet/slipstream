import type { ITicketProvider, ScopeOption, TicketDTO, WorkflowState, PaginatedTickets } from '../shared/contract.js'
import type { IConfigStore } from '../services/configStore.js'

interface LinearNode {
  id: string
  identifier: string
  title: string
  description?: string
  team?: { id?: string; key: string }
  state?: { id?: string; name?: string; type?: string }
}

interface LinearResponse {
  data?: Record<string, unknown>
  errors?: Array<{ message: string }>
}

function parseTeamKeys(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
}

const LIST_QUERY = `
  query($filter: IssueFilter, $first: Int!, $after: String, $term: String) {
    issues(filter: $filter, orderBy: updatedAt, first: $first, after: $after, term: $term) {
      nodes {
        id
        identifier
        title
        description
        team { key }
        state { id name type }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`

export function createLinearProvider(config: IConfigStore): ITicketProvider {
  async function gql(
    key: string,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: key,
      },
      body: JSON.stringify({ query, variables }),
    })

    if (!res.ok) {
      throw new Error(`Linear API error: ${res.status} ${res.statusText}`)
    }

    const json = (await res.json()) as LinearResponse

    if (json.errors?.length) {
      throw new Error(`Linear GraphQL error: ${json.errors.map((e) => e.message).join(', ')}`)
    }

    return (json.data ?? {}) as Record<string, unknown>
  }

  async function resolveIssue(tid: string): Promise<LinearNode> {
    const lastDash = tid.lastIndexOf('-')
    if (lastDash <= 0 || lastDash === tid.length - 1) {
      throw new Error(`Invalid ticket id: ${tid}`)
    }
    const key = tid.slice(0, lastDash)
    const number = Number(tid.slice(lastDash + 1))
    if (isNaN(number)) {
      throw new Error(`Invalid ticket id: ${tid}`)
    }

    const apiKey = config.get('linear.apiKey')
    if (!apiKey) throw new Error('Linear API key not set')

    const data = await gql(
      apiKey,
      `
      query($key:String!,$number:Float!){
        issues(filter:{ team:{ key:{ eq:$key } }, number:{ eq:$number } }, first:1){
          nodes{ id identifier team{ id key } state{ id name type } }
        }
      }
    `,
      { key, number },
    )

    const issues = data.issues as { nodes: LinearNode[] } | undefined
    const node = issues?.nodes?.[0]
    if (!node) throw new Error(`Ticket not found: ${tid}`)
    return node
  }

  return {
    id: 'linear',

    async listScopes(): Promise<ScopeOption[]> {
      const apiKey = config.get('linear.apiKey')
      if (!apiKey) throw new Error('Linear API key not set')

      const data = await gql(
        apiKey,
        `
        query {
          teams(first: 100) {
            nodes { id key name }
          }
        }
      `,
      )

      const teams = data.teams as
        { nodes: Array<{ id: string; key: string; name: string }> } | undefined
      return (teams?.nodes ?? []).map((t) => ({ id: t.id, key: t.key, name: t.name }))
    },

    async listTickets(opts?: { page?: number; pageSize?: number; query?: string }): Promise<PaginatedTickets> {
      const apiKey = config.get('linear.apiKey')
      if (!apiKey) return { tickets: [], totalCount: 0, page: 1, pageSize: 20, hasMore: false }

      const teamKeys = parseTeamKeys(config.get('linear.teamKeys'))
      const onlyMine = config.get('linear.onlyMine') !== '0'

      const page = opts?.page ?? 1
      const pageSize = opts?.pageSize ?? 20
      const query = opts?.query

      const and: unknown[] = [{ state: { type: { nin: ['completed', 'canceled'] } } }]
      if (teamKeys.length > 0) {
        and.push({ team: { key: { in: teamKeys } } })
      }
      if (onlyMine) {
        and.push({ or: [{ assignee: { isMe: { eq: true } } }, { assignee: { null: true } }] })
      }

      const variables: Record<string, unknown> = {
        filter: { and },
        first: pageSize,
      }
      if (page > 1) {
        // For simplicity, we'll just fetch more and slice. Linear cursor pagination is complex.
        // Since we can't easily get total count, we'll fetch pageSize * page and slice
        variables.first = pageSize * page
      }
      if (query) {
        variables.term = query
      }

      const data = await gql(apiKey, LIST_QUERY, variables)
      const issues = data.issues as { nodes: LinearNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } | undefined
      const nodes = issues?.nodes ?? []
      const hasNextPage = issues?.pageInfo?.hasNextPage ?? false

      // Slice for the requested page
      const start = (page - 1) * pageSize
      const pageNodes = nodes.slice(start, start + pageSize)

      const tickets = pageNodes.map((node): TicketDTO => ({
        id: node.id,
        tid: node.identifier,
        src: 'linear',
        title: node.title,
        description: node.description,
        done: node.state?.type === 'completed',
        repoHint: node.team?.key,
        status: node.state?.id
          ? { id: node.state.id, name: node.state.name ?? '', type: node.state.type }
          : undefined,
      }))

      // Estimate total count - since Linear doesn't easily provide it, we use a heuristic
      const totalCount = hasNextPage ? start + pageSize + 1 : tickets.length
      const hasMore = hasNextPage && pageNodes.length >= pageSize

      return { tickets, totalCount, page, pageSize, hasMore }
    },

    async getTicketStatus(
      tid: string,
    ): Promise<{ current: WorkflowState | null; available: WorkflowState[] }> {
      const apiKey = config.get('linear.apiKey')
      if (!apiKey) throw new Error('Linear API key not set')

      const node = await resolveIssue(tid)
      const teamId = node.team?.id
      if (!teamId) throw new Error(`No team found for ticket: ${tid}`)

      const data = await gql(
        apiKey,
        `
        query($teamId:ID!){
          workflowStates(filter:{ team:{ id:{ eq:$teamId } } }, first:100){
            nodes{ id name type position }
          }
        }
      `,
        { teamId },
      )

      const statesData = data.workflowStates as
        { nodes: Array<{ id: string; name: string; type?: string; position?: number }> } | undefined
      const available = (statesData?.nodes ?? [])
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map((s) => ({ id: s.id, name: s.name, type: s.type }))

      const current = node.state?.id
        ? { id: node.state.id, name: node.state.name ?? '', type: node.state.type }
        : null

      return { current, available }
    },

    async setTicketStatus(tid: string, stateId: string): Promise<WorkflowState> {
      const apiKey = config.get('linear.apiKey')
      if (!apiKey) throw new Error('Linear API key not set')

      const node = await resolveIssue(tid)

      const data = await gql(
        apiKey,
        `
        mutation($id:String!,$stateId:String!){
          issueUpdate(id:$id, input:{ stateId:$stateId }){ success issue { state { id name type } } }
        }
      `,
        { id: node.id, stateId },
      )

      const result = data.issueUpdate as
        | { success: boolean; issue: { state: { id: string; name: string; type?: string } } }
        | undefined
      if (!result?.success) throw new Error('Failed to update ticket status')

      return result.issue.state
    },

    async startTicket(tid: string): Promise<WorkflowState | null> {
      const apiKey = config.get('linear.apiKey')
      if (!apiKey) throw new Error('Linear API key not set')

      const node = await resolveIssue(tid)

      if (node.state?.type === 'started') return null

      const teamId = node.team?.id
      if (!teamId) throw new Error(`No team found for ticket: ${tid}`)

      const data = await gql(
        apiKey,
        `
        query($teamId:ID!){
          workflowStates(filter:{ team:{ id:{ eq:$teamId } } }, first:100){
            nodes{ id name type position }
          }
        }
      `,
        { teamId },
      )

      const statesData = data.workflowStates as
        { nodes: Array<{ id: string; name: string; type?: string; position?: number }> } | undefined
      const startedState = (statesData?.nodes ?? [])
        .filter((s) => s.type === 'started')
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0]

      if (!startedState) return null

      const mutData = await gql(
        apiKey,
        `
        mutation($id:String!,$stateId:String!){
          issueUpdate(id:$id, input:{ stateId:$stateId }){ success issue { state { id name type } } }
        }
      `,
        { id: node.id, stateId: startedState.id },
      )

      const result = mutData.issueUpdate as
        | { success: boolean; issue: { state: { id: string; name: string; type?: string } } }
        | undefined
      if (!result?.success) throw new Error('Failed to update ticket status')

      return result.issue.state
    },

    async resetTicket(tid: string): Promise<WorkflowState | null> {
      const apiKey = config.get('linear.apiKey')
      if (!apiKey) throw new Error('Linear API key not set')

      const node = await resolveIssue(tid)

      // Only reset tickets currently in a started ("In Progress") state.
      // Done / canceled / already-to-do tickets are left untouched.
      if (node.state?.type !== 'started') return null

      const teamId = node.team?.id
      if (!teamId) throw new Error(`No team found for ticket: ${tid}`)

      const data = await gql(
        apiKey,
        `
        query($teamId:ID!){
          workflowStates(filter:{ team:{ id:{ eq:$teamId } } }, first:100){
            nodes{ id name type position }
          }
        }
      `,
        { teamId },
      )

      const statesData = data.workflowStates as
        { nodes: Array<{ id: string; name: string; type?: string; position?: number }> } | undefined
      const states = statesData?.nodes ?? []
      const unstartedState =
        states
          .filter((s) => s.type === 'unstarted')
          .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0] ??
        states
          .filter((s) => s.type === 'backlog')
          .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0]

      if (!unstartedState) return null

      const mutData = await gql(
        apiKey,
        `
        mutation($id:String!,$stateId:String!){
          issueUpdate(id:$id, input:{ stateId:$stateId }){ success issue { state { id name type } } }
        }
      `,
        { id: node.id, stateId: unstartedState.id },
      )

      const result = mutData.issueUpdate as
        | { success: boolean; issue: { state: { id: string; name: string; type?: string } } }
        | undefined
      if (!result?.success) throw new Error('Failed to update ticket status')

      return result.issue.state
    },

    async postComment(tid: string, body: string): Promise<boolean> {
      const apiKey = config.get('linear.apiKey')
      if (!apiKey) return false

      const node = await resolveIssue(tid)

      // Linear comments accept markdown, so the plain body string is fine.
      const data = await gql(
        apiKey,
        `
        mutation($issueId:String!,$body:String!){
          commentCreate(input:{ issueId:$issueId, body:$body }){ success }
        }
      `,
        { issueId: node.id, body },
      )

      const result = data.commentCreate as { success: boolean } | undefined
      if (!result?.success) throw new Error('Failed to post comment')
      return true
    },
  }
}

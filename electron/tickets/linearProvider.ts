import type { ITicketProvider, TicketDTO, WorkflowState } from '../shared/contract.js'
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

const QUERY = `
  query {
    issues(filter: { and: [
      { state: { type: { neq: "canceled" } } },
      { or: [ { assignee: { isMe: { eq: true } } }, { assignee: { null: true } } ] }
    ] }, orderBy: updatedAt, first: 50) {
      nodes {
        id
        identifier
        title
        description
        team { key }
        state { id name type }
      }
    }
  }
`

export function createLinearProvider(config: IConfigStore): ITicketProvider {
  async function gql(key: string, query: string, variables?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': key,
      },
      body: JSON.stringify({ query, variables }),
    })

    if (!res.ok) {
      throw new Error(`Linear API error: ${res.status} ${res.statusText}`)
    }

    const json = await res.json() as LinearResponse

    if (json.errors?.length) {
      throw new Error(`Linear GraphQL error: ${json.errors.map(e => e.message).join(', ')}`)
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

    const data = await gql(apiKey, `
      query($key:String!,$number:Float!){
        issues(filter:{ team:{ key:{ eq:$key } }, number:{ eq:$number } }, first:1){
          nodes{ id identifier team{ id key } state{ id name type } }
        }
      }
    `, { key, number })

    const issues = data.issues as { nodes: LinearNode[] } | undefined
    const node = issues?.nodes?.[0]
    if (!node) throw new Error(`Ticket not found: ${tid}`)
    return node
  }

  return {
    id: 'linear',

    async listTickets(): Promise<TicketDTO[]> {
      const apiKey = config.get('linear.apiKey')
      if (!apiKey) return []

      const data = await gql(apiKey, QUERY)
      const issues = data.issues as { nodes: LinearNode[] } | undefined
      const nodes = issues?.nodes ?? []
      return nodes.map((node): TicketDTO => ({
        id: node.id,
        tid: node.identifier,
        src: 'linear',
        title: node.title,
        description: node.description,
        done: node.state?.type === 'completed',
        repoHint: node.team?.key,
        status: node.state?.id ? { id: node.state.id, name: node.state.name ?? '', type: node.state.type } : undefined,
      }))
    },

    async getTicketStatus(tid: string): Promise<{ current: WorkflowState | null; available: WorkflowState[] }> {
      const apiKey = config.get('linear.apiKey')
      if (!apiKey) throw new Error('Linear API key not set')

      const node = await resolveIssue(tid)
      const teamId = node.team?.id
      if (!teamId) throw new Error(`No team found for ticket: ${tid}`)

      const data = await gql(apiKey, `
        query($teamId:ID!){
          workflowStates(filter:{ team:{ id:{ eq:$teamId } } }, first:100){
            nodes{ id name type position }
          }
        }
      `, { teamId })

      const statesData = data.workflowStates as { nodes: Array<{ id: string; name: string; type?: string; position?: number }> } | undefined
      const available = (statesData?.nodes ?? [])
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map(s => ({ id: s.id, name: s.name, type: s.type }))

      const current = node.state?.id ? { id: node.state.id, name: node.state.name ?? '', type: node.state.type } : null

      return { current, available }
    },

    async setTicketStatus(tid: string, stateId: string): Promise<WorkflowState> {
      const apiKey = config.get('linear.apiKey')
      if (!apiKey) throw new Error('Linear API key not set')

      const node = await resolveIssue(tid)

      const data = await gql(apiKey, `
        mutation($id:String!,$stateId:String!){
          issueUpdate(id:$id, input:{ stateId:$stateId }){ success issue { state { id name type } } }
        }
      `, { id: node.id, stateId })

      const result = data.issueUpdate as { success: boolean; issue: { state: { id: string; name: string; type?: string } } } | undefined
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

      const data = await gql(apiKey, `
        query($teamId:ID!){
          workflowStates(filter:{ team:{ id:{ eq:$teamId } } }, first:100){
            nodes{ id name type position }
          }
        }
      `, { teamId })

      const statesData = data.workflowStates as { nodes: Array<{ id: string; name: string; type?: string; position?: number }> } | undefined
      const startedState = (statesData?.nodes ?? [])
        .filter(s => s.type === 'started')
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0]

      if (!startedState) return null

      const mutData = await gql(apiKey, `
        mutation($id:String!,$stateId:String!){
          issueUpdate(id:$id, input:{ stateId:$stateId }){ success issue { state { id name type } } }
        }
      `, { id: node.id, stateId: startedState.id })

      const result = mutData.issueUpdate as { success: boolean; issue: { state: { id: string; name: string; type?: string } } } | undefined
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

      const data = await gql(apiKey, `
        query($teamId:ID!){
          workflowStates(filter:{ team:{ id:{ eq:$teamId } } }, first:100){
            nodes{ id name type position }
          }
        }
      `, { teamId })

      const statesData = data.workflowStates as { nodes: Array<{ id: string; name: string; type?: string; position?: number }> } | undefined
      const states = statesData?.nodes ?? []
      const unstartedState =
        states.filter(s => s.type === 'unstarted').sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0]
        ?? states.filter(s => s.type === 'backlog').sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0]

      if (!unstartedState) return null

      const mutData = await gql(apiKey, `
        mutation($id:String!,$stateId:String!){
          issueUpdate(id:$id, input:{ stateId:$stateId }){ success issue { state { id name type } } }
        }
      `, { id: node.id, stateId: unstartedState.id })

      const result = mutData.issueUpdate as { success: boolean; issue: { state: { id: string; name: string; type?: string } } } | undefined
      if (!result?.success) throw new Error('Failed to update ticket status')

      return result.issue.state
    },
  }
}

import type { ITicketProvider, TicketDTO } from '../shared/contract.js'
import type { IConfigStore } from '../services/configStore.js'

interface LinearNode {
  id: string
  identifier: string
  title: string
  description?: string
  team?: { key: string }
  state?: { type: string }
}

interface LinearResponse {
  data?: {
    issues?: {
      nodes: LinearNode[]
    }
  }
  errors?: Array<{ message: string }>
}

interface LinearCompleteIssueNode {
  id: string
  state: { id: string }
  team: {
    states: {
      nodes: Array<{ id: string; type: string; position: number }>
    }
  }
}

interface LinearCompleteResponse {
  data?: {
    issues?: {
      nodes: LinearCompleteIssueNode[]
    }
    issueUpdate?: {
      success: boolean
    }
  }
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
        state { type }
      }
    }
  }
`

async function linearRequest<T>(
  url: string,
  key: string,
  body: object,
): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': key,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    throw new Error(`Linear API error: ${res.status} ${res.statusText}`)
  }

  const json = await res.json() as (T & { errors?: Array<{ message: string }> })

  if ((json as { errors?: Array<{ message: string }> }).errors?.length) {
    const errors = (json as { errors: Array<{ message: string }> }).errors
    throw new Error(`Linear GraphQL error: ${errors.map((e: { message: string }) => e.message).join(', ')}`)
  }

  return json
}

export function createLinearProvider(config: IConfigStore): ITicketProvider {
  return {
    id: 'linear',
    async listTickets(): Promise<TicketDTO[]> {
      const key = config.get('linear.apiKey')
      if (!key) return []

      const json = await linearRequest<LinearResponse>(
        'https://api.linear.app/graphql',
        key,
        { query: QUERY },
      )

      const nodes = json.data?.issues?.nodes ?? []
      return nodes.map((node): TicketDTO => ({
        id: node.id,
        tid: node.identifier,
        src: 'linear',
        title: node.title,
        description: node.description,
        done: node.state?.type === 'completed',
        repoHint: node.team?.key,
      }))
    },

    async completeTicket(tid: string): Promise<void> {
      const key = config.get('linear.apiKey')
      if (!key) throw new Error('Linear API key not configured')

      // Parse tid by splitting on the LAST '-': "FLO-9" → key="FLO", num=9
      const lastDash = tid.lastIndexOf('-')
      const teamKey = tid.slice(0, lastDash)
      const num = Number(tid.slice(lastDash + 1))

      const COMPLETE_QUERY = `query($key:String!,$num:Float!){ issues(filter:{ team:{ key:{ eq:$key } }, number:{ eq:$num } }, first:1){ nodes{ id state{ id } team{ states{ nodes{ id type position } } } } } }`

      const issueJson = await linearRequest<LinearCompleteResponse>(
        'https://api.linear.app/graphql',
        key,
        { query: COMPLETE_QUERY, variables: { key: teamKey, num } },
      )

      const nodes = issueJson.data?.issues?.nodes ?? []
      if (nodes.length === 0) {
        throw new Error(`Ticket not found: ${tid}`)
      }

      const issue = nodes[0]
      const completedStates = issue.team.states.nodes.filter((s) => s.type === 'completed')
      if (completedStates.length === 0) {
        throw new Error('No completed workflow state found for this team')
      }

      // Pick the completed state with the lowest position
      completedStates.sort((a, b) => a.position - b.position)
      const targetState = completedStates[0]

      const MUTATION = `mutation($id:String!,$stateId:String!){ issueUpdate(id:$id, input:{ stateId:$stateId }){ success } }`

      const mutationJson = await linearRequest<LinearCompleteResponse>(
        'https://api.linear.app/graphql',
        key,
        { query: MUTATION, variables: { id: issue.id, stateId: targetState.id } },
      )

      if (!mutationJson.data?.issueUpdate?.success) {
        throw new Error('Linear failed to update issue state')
      }
    },
  }
}

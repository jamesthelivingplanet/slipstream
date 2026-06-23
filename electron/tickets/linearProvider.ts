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

export function createLinearProvider(config: IConfigStore): ITicketProvider {
  return {
    id: 'linear',
    async listTickets(): Promise<TicketDTO[]> {
      const key = config.get('linear.apiKey')
      if (!key) return []

      const res = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': key,
        },
        body: JSON.stringify({ query: QUERY }),
      })

      if (!res.ok) {
        throw new Error(`Linear API error: ${res.status} ${res.statusText}`)
      }

      const json = await res.json() as LinearResponse

      if (json.errors?.length) {
        throw new Error(`Linear GraphQL error: ${json.errors.map(e => e.message).join(', ')}`)
      }

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
  }
}

import type { BackendKind } from './types'
import { AGENT_META, type AgentMeta } from '../../electron/shared/agents.js'

export type AgentOption = AgentMeta

/** The agents surfaced in the UI selector. Add new backends in electron/shared/agents.ts. */
export const AGENTS: AgentOption[] = [...AGENT_META]

/** Look up the option for a kind, falling back to the first agent. */
export function agentOption(kind: BackendKind): AgentOption {
  return AGENTS.find((a) => a.kind === kind) ?? AGENTS[0]
}

import type { BackendKind } from './types'

export interface AgentOption {
  kind: BackendKind
  label: string
  /** Short description shown beneath the selector. */
  description: string
  /** Path (under public/) to the agent's brand icon. */
  icon: string
}

/** The agents surfaced in the UI selector. Add new backends here. */
export const AGENTS: AgentOption[] = [
  {
    kind: 'claude-code',
    label: 'Claude Code',
    description: 'Uses claude --dangerously-skip-permissions in a git worktree.',
    icon: '/icons/agents/claude-code.svg',
  },
  {
    kind: 'opencode',
    label: 'OpenCode',
    description: 'Uses opencode in a git worktree with auto-discovered AGENTS.md.',
    icon: '/icons/agents/opencode.svg',
  },
  {
    kind: 'pi',
    label: 'Pi',
    description: 'Uses pi --approve in a git worktree with auto-discovered AGENTS.md.',
    icon: '/icons/agents/pi.svg',
  },
]

/** Look up the option for a kind, falling back to the first agent. */
export function agentOption(kind: BackendKind): AgentOption {
  return AGENTS.find((a) => a.kind === kind) ?? AGENTS[0]
}

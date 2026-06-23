export interface TicketContext { tid: string; title: string; description?: string }
export interface PromptLayers { system: string; user: string }
export type BackendKind = 'claude-code'
export interface SpawnPrompt { systemArgs: string[]; userPrompt: string }

export function defaultUserPrompt(tid: string): string {
  return `Begin implementing ${tid}.`
}

export function buildSystemPrompt(ticket: TicketContext): string {
  const { tid, title, description } = ticket
  const desc =
    description && description.trim().length > 0
      ? description.trim()
      : 'No description provided.'

  return `You are an autonomous agent implementing one ticket inside a dedicated git worktree branched from the base branch.

Process:
- Investigate the codebase before editing anything.
- Implement the ticket fully, including tests where appropriate.
- Run checks and tests until they pass.
- Open a PR when the acceptance criteria are met.

Note: CLAUDE.md already covers repo conventions — follow it but do not duplicate it here.

Ticket:
${tid}: ${title}

${desc}`
}

export function deliverPrompt(kind: BackendKind, layers: PromptLayers): SpawnPrompt {
  const { system, user } = layers
  switch (kind) {
    case 'claude-code':
      if (system) {
        return { systemArgs: ['--append-system-prompt', system], userPrompt: user }
      }
      return { systemArgs: [], userPrompt: user }

    default:
      return { systemArgs: [], userPrompt: system ? `${system}\n\n${user}` : user }
  }
}

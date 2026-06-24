export interface TicketContext { tid: string; title: string; description?: string }
export interface PromptLayers { system: string; user: string }
export type BackendKind = 'claude-code'
export interface SpawnPrompt { systemArgs: string[]; userPrompt: string }

/**
 * Sentinel markers the agent prints to signal its state to the app.
 * Kept deliberately short (never wraps at 80 cols) and distinctive (will not
 * occur in normal output) so the status detector can match them reliably even
 * through the PTY/TUI rendering. Single source of truth: shared by the system
 * prompt (which tells the agent to emit them) and the status detector (which
 * reads them back). See electron/services/statusDetector.ts.
 */
export const NEEDS_INPUT_MARKER = '⟦SLIPSTREAM:NEEDS_INPUT⟧'
export const DONE_MARKER = '⟦SLIPSTREAM:DONE⟧'
export const IN_PROGRESS_MARKER = '⟦SLIPSTREAM:IN_PROGRESS⟧'

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

## Signaling your state to the app

The app tracks your current state. You MUST tell it your state by printing a marker on its own line as the VERY LAST thing you output in a turn. The most recently printed marker is the one the app uses.

- When you begin or resume actively working on the ticket, finish your message with this exact marker alone on the final line:
  ${IN_PROGRESS_MARKER}
- When you need the user to answer a question, make a decision, or provide input — and you cannot make further progress without it — finish your message with this exact marker alone on the final line:
  ${NEEDS_INPUT_MARKER}
- When you have fully completed the ticket (acceptance criteria met / PR opened) and there is nothing left to do, finish with this exact marker alone on the final line:
  ${DONE_MARKER}

Rules:
- Print the marker EXACTLY as shown, with no code fences, quotes, or extra characters around it, as the final line of your output.
- The most recently printed marker is what the app displays — if you resume work after a ${NEEDS_INPUT_MARKER}, print ${IN_PROGRESS_MARKER} to show you are running again.
- Emit a marker ONLY when the condition is true.

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

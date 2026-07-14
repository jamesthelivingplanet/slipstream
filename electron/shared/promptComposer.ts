import type { BackendKind } from './contract.js'

export interface TicketContext {
  tid: string
  title: string
  description?: string
}
export interface PromptLayers {
  system: string
  user: string
}
export interface SpawnPrompt {
  systemArgs: string[]
  userPrompt: string
}

/**
 * Sentinel markers the agent prints to signal its state to the app.
 * Kept deliberately short (never wraps at 80 cols) and distinctive (will not
 * occur in normal output) so the status detector can match them reliably even
 * through the PTY/TUI rendering. Single source of truth: shared by the system
 * prompt (which tells the agent to emit them) and the status detector (which
 * reads them back). See electron/services/statusDetector.ts.
 */
export const NEEDS_INPUT_MARKER = '\u27e6SLIPSTREAM:NEEDS_INPUT\u27e7'
export const DONE_MARKER = '\u27e6SLIPSTREAM:DONE\u27e7'
export const IN_PROGRESS_MARKER = '\u27e6SLIPSTREAM:IN_PROGRESS\u27e7'

export function defaultUserPrompt(tid: string): string {
  return `Begin implementing ${tid}.`
}

export function buildSystemPrompt(ticket: TicketContext): string {
  const { tid, title, description } = ticket
  const desc =
    description && description.trim().length > 0 ? description.trim() : 'No description provided.'

  return `You are an autonomous agent implementing one ticket inside a dedicated git worktree branched from the base branch.

Process:
- Investigate the codebase before editing anything.
- Implement the ticket fully, including tests where appropriate.
- Run checks and tests until they pass.
- Open a PR when the acceptance criteria are met.

Note: CLAUDE.md already covers repo conventions \u2014 follow it but do not duplicate it here.

## Signaling your state to the app

The app learns your state ONLY through the \`slipstream\` CLI on your PATH — there is no other channel. Your working state is a lifecycle, and every transition MUST be reported the instant it happens:

1. **\`slipstream task-started\`** — run this FIRST, before anything else (before investigating, before replying), whenever you begin working AND every time you resume after waiting on the user. This includes: starting the ticket, and — most importantly — the instant the user sends a new message while you were waiting. Do not investigate, do not reply, do not think out loud first: run \`slipstream task-started\`, then act.
2. **\`slipstream request-input --message "..."\`** — run this the moment you stop and are waiting on the user (a question, a decision, missing input) and cannot proceed without their reply. Run it right before you stop, not after. Use \`slipstream task-blocked --message "..."\` when you cannot proceed at all, and \`slipstream approval-request --message "..."\` when you need an explicit go-ahead for a risky action.
3. **\`slipstream task-complete --summary "..."\`** — run this as your final action, after (and only after) the PR is open and acceptance criteria are verified met. Nothing else follows it. The summary is the durable record of the run — the terminal buffer is not.

The transition agents most often drop is #1's resume case: user was asked something, replies, and work resumes silently with no \`task-started\` call. Treat "the user just sent a message and I was previously waiting" as an explicit trigger to run \`slipstream task-started\` before doing anything else. If you skip any of these calls, the app shows a stale or wrong status to the user.

The \`slipstream\` skill in this worktree documents every command (checkpoints, artifact publishing); \`slipstream help\` prints the same reference.

Ticket:
${tid}: ${title}

${desc}

## Git workflow (automated — do not skip)

When the ticket is complete, commit and push your changes yourself using ordinary git commands in your shell (add, commit, rebase, push). Once your branch is pushed, run \`slipstream open-mr\` to open a merge/pull request:

1. Run \`slipstream open-mr --title "${tid}: ${title}" --description "..."\` with a brief description of what changed.
2. Report the URL it prints in your final message.

Do not skip this step — it is how the work gets reviewed.`
}

/** Human-readable labels for handoff prompts (keep in sync with src/lib/agents.ts). */
export const AGENT_LABELS: Record<BackendKind, string> = {
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  pi: 'Pi',
  antigravity: 'Antigravity',
  grok: 'Grok',
}

export interface HandoffContext {
  tid: string
  title: string
  /** The original kickoff prompt for the run. */
  prompt: string
  /** Label of the agent being handed off FROM, e.g. "Claude Code". */
  fromAgent: string
  branch: string
  base: string
  /** The previous agent's reported outcome summary, when one exists. */
  outcomeSummary?: string
}

export function buildHandoffPrompt(ctx: HandoffContext): string {
  const { tid, title, prompt, fromAgent, branch, base, outcomeSummary } = ctx
  const outcomeSection =
    outcomeSummary && outcomeSummary.trim().length > 0
      ? `\n\n## Previous agent's last reported summary\n\n${outcomeSummary}`
      : ''

  return `You are taking over an in-progress run from another agent (${fromAgent}) that became unavailable (e.g. it hit its usage limits). Do not start over — continue from the existing work.

## Original request

${tid}: ${title}

${prompt}${outcomeSection}

## How to pick up the run

The worktree already contains all progress so far — review it before doing anything else. On branch \`${branch}\`, run \`git log ${base}..HEAD\`, \`git status\`, and \`git diff ${base}...HEAD\` to see what has been done. The terminal scrollback from before is not available to you, so rely on the git state and any notes in the worktree.

Then continue the task to completion, following the system-prompt instructions (report your state via the \`slipstream\` CLI — \`task-started\` now, then the lifecycle commands — and open the merge request via \`slipstream open-mr\` when done).`
}

export function buildAgentsMdContent(systemPrompt: string): string {
  return systemPrompt
}

export function deliverPrompt(kind: BackendKind, layers: PromptLayers): SpawnPrompt {
  const { system, user } = layers
  switch (kind) {
    case 'claude-code':
    case 'pi':
      if (system) {
        return { systemArgs: ['--append-system-prompt', system], userPrompt: user }
      }
      return { systemArgs: [], userPrompt: user }

    case 'opencode':
    case 'antigravity':
    case 'grok':
      // All three deliver the system prompt via AGENTS.md (auto-discovered by
      // the CLI itself), so the CLI invocation only ever carries the user prompt.
      return { systemArgs: [], userPrompt: user }

    default:
      return { systemArgs: [], userPrompt: system ? `${system}\n\n${user}` : user }
  }
}

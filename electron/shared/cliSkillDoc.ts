/**
 * cliSkillDoc — single source of truth for the `slipstream` agent skill
 * (FLO-104). Written into every session worktree by promptWriter's
 * writeSlipstreamSkill at the open-standard location
 * `.agents/skills/slipstream/SKILL.md` (with a `.claude/skills/slipstream`
 * symlink for Claude Code), so all three backends discover the same file:
 *
 *  - pi:          reads project `.agents/skills/` natively
 *  - opencode:    reads project `.agents/skills/` and `.claude/skills/`
 *  - Claude Code: reads `.claude/skills/`, following symlinked skill dirs
 *
 * Frontmatter constraints come from pi, the strictest parser of the three:
 * `name` (lowercase/hyphens, ≤64 chars) and `description` (≤1024 chars) are
 * mandatory — pi silently skips the skill without them.
 */

export function buildSlipstreamSkillMd(): string {
  return `---
name: slipstream
description: Report your working state to the Slipstream app (task started, needs input, blocked, waiting for approval, complete), record progress checkpoints, publish artifact files, and open the merge request when done. Use the moment your working state changes, at meaningful milestones, and as the final step of the ticket.
---

# Slipstream session CLI

You are running inside a Slipstream-managed session. The Slipstream app learns
your state ONLY through the \`slipstream\` CLI on your PATH — nothing else
updates the status badge, push notifications, or the durable run record.

## Lifecycle rules (every transition, the instant it happens)

1. \`slipstream task-started\` — FIRST action whenever you begin working AND
   every time you resume after waiting on the user. **The transition agents
   drop most:** the user answers your question and work resumes silently.
   Treat "the user just replied while I was waiting" as an explicit trigger to
   run \`slipstream task-started\` before investigating or replying.
2. \`slipstream request-input --message "..."\` — the moment you stop to wait
   on the user (question, decision, missing input). Run it right before you
   stop, not after.
3. \`slipstream task-blocked --message "..."\` — you cannot proceed at all
   (broken environment, missing dependency, failing precondition you cannot
   fix). Also a waiting state: resume with \`task-started\`.
4. \`slipstream approval-request --message "..."\` — you need an explicit
   go-ahead before a risky or irreversible action. Wait for the reply, then
   \`task-started\`.
5. \`slipstream task-complete --summary "..."\` — final action, after (and only
   after) the merge request is open and acceptance criteria are verified.
   Nothing follows it.

## Command reference

| Command | Required | Optional | Effect |
|---|---|---|---|
| \`slipstream task-started\` | — | \`--message\` | status → running |
| \`slipstream request-input\` | \`--message\` | — | status → waiting on user (input) |
| \`slipstream task-blocked\` | \`--message\` | — | status → waiting on user (blocked) |
| \`slipstream approval-request\` | \`--message\` | — | status → waiting on user (approval) + approval event |
| \`slipstream checkpoint\` | \`--message\` | — | records a progress milestone |
| \`slipstream artifact publish <file>\` | file path | \`--title\` | copies the file into the session's artifact store |
| \`slipstream task-complete\` | \`--summary\` | \`--result success\\|partial\\|failure\`, \`--details\` | records the durable outcome, then status → done |
| \`slipstream open-mr\` | \`--title\` | \`--description\` | pushes the branch (best-effort) and opens the merge/pull request |
| \`slipstream help [command]\` | — | — | usage |

Notes:
- \`checkpoint\` at meaningful milestones (tests passing, phase complete) —
  the terminal scrollback is not durable; checkpoints and the
  \`task-complete\` summary are.
- \`artifact publish\` for files the user should keep (reports, screenshots,
  generated docs); the worktree may be cleaned up after the run.
- \`open-mr\` opens the MR from your current branch; commit and push with
  ordinary git first (open-mr's push is only a best-effort fallback).
  Report the printed MR URL in your final message.
- Exit codes: 0 ok · 1 usage error · 2 not inside a Slipstream session ·
  3 operation failed. Each success prints the next expected transition.
`
}

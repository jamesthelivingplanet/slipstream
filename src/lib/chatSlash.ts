import type { AgentSkillDTO } from '../../electron/shared/contract.js'

/** A slash-command token currently being typed at the start of the chat
 *  draft — `start`/`end` are draft indices so callers can splice a
 *  replacement back in without re-deriving the token's position. */
export interface SlashToken {
  /** Text after the leading '/', used to filter the skill list. */
  query: string
  /** Index of the leading '/' in the draft. */
  start: number
  /** Index one past the end of the token. */
  end: number
}

/**
 * Detects an in-progress slash command at the very start of the draft: the
 * whole draft is `/` followed by zero or more non-whitespace characters and
 * nothing else. Once a space is typed the command is "committed" (the user
 * is now typing arguments/a message) and this returns null, closing the
 * menu — matching typical slash-command UX (Slack, Discord, etc).
 */
export function detectSlashToken(draft: string): SlashToken | null {
  const m = /^\/(\S*)$/.exec(draft)
  if (!m) return null
  return { query: m[1], start: 0, end: draft.length }
}

/** Case-insensitive prefix filter over skill names — an empty query matches
 *  everything. Reasoned as "which skills would this command complete to". */
export function filterSkills(skills: AgentSkillDTO[], query: string): AgentSkillDTO[] {
  if (query === '') return skills
  const q = query.toLowerCase()
  return skills.filter((s) => s.name.toLowerCase().startsWith(q))
}

/** Replaces the draft's slash token with `/name ` (trailing space so the
 *  user can keep typing straight into arguments) and leaves anything after
 *  the token untouched. */
export function applySlashSelection(draft: string, token: SlashToken, name: string): string {
  return draft.slice(0, token.start) + `/${name} ` + draft.slice(token.end)
}

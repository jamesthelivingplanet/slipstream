/**
 * Centralized agent-CLI constants (FLO-43).
 *
 * Every binary name, command-line flag, and spawn/resume timing literal used to
 * launch or resume an agent process lives here so a CLI rename is a one-file
 * change instead of a grep-and-pray across services.
 */

/** Binary names. */
export const CLAUDE_BIN = 'claude'
export const OPENCODE_BIN_NAME = 'opencode'
/** Google Antigravity CLI — never an npm dependency, so agentBackend.ts uses
 *  this bare name directly (no node_modules/.bin preference). */
export const ANTIGRAVITY_BIN = 'agy'
/** grok-cli (grokcli.io / superagent-ai). The npm package is `grok-dev`, but
 *  the installed binary name on PATH is `grok`. */
export const GROK_BIN_NAME = 'grok'
/** Kilo Code CLI (an opencode fork). Typically installed to `~/.kilo/bin/kilo`,
 *  a directory that is NOT on the daemon's PATH — agentBackend.ts's KILO_BIN
 *  prefers that absolute path when present, falling back to this bare name. */
export const KILO_BIN_NAME = 'kilo'

/** Claude Code CLI flags. */
export const CLAUDE_FLAGS = {
  skipPermissions: '--dangerously-skip-permissions',
  sessionId: '--session-id',
  resume: '--resume',
  remoteControl: '--remote-control',
} as const

/** opencode CLI flags. */
export const OPENCODE_FLAGS = {
  port: '--port',
  session: '--session',
  continue: '--continue',
  prompt: '--prompt',
} as const

/** Antigravity (`agy`) CLI flags. `-i`/`--prompt-interactive` runs the given
 *  prompt then stays interactive; `--continue` resumes the conversation
 *  scoped to the current cwd. */
export const ANTIGRAVITY_FLAGS = {
  skipPermissions: '--dangerously-skip-permissions',
  promptInteractive: '-i',
  continue: '--continue',
} as const

/** grok-cli flags. No permission-bypass flag exists (tool execution is
 *  trust-based); `--session latest` resumes the most recent saved session
 *  (scoping within grok's store is undocumented). */
export const GROK_FLAGS = {
  session: '--session',
} as const

/** Kilo Code CLI flags — same shape as opencode's (Kilo is an opencode fork
 *  with an opencode-compatible embedded server API). The TUI has NO
 *  permission-bypass flag (`--dangerously-skip-permissions`/`--auto` exist
 *  only on the headless `kilo run`); the only bypass mechanism for the TUI is
 *  the `kilo.jsonc` config written by writeKiloConfig (promptWriter.ts). */
export const KILO_FLAGS = {
  port: '--port',
  session: '--session',
  continue: '--continue',
  prompt: '--prompt',
} as const

/** Interval (ms) for polling an opencode session's status from its server. */
export const OPENCODE_STATUS_POLL_MS = 2000

/** Retry budget for capturing an opencode session id after the TUI launches. */
export const OPENCODE_SESSION_CAPTURE_ATTEMPTS = 20
export const OPENCODE_SESSION_CAPTURE_INTERVAL_MS = 500

/**
 * Split a user-supplied extra-arguments string (e.g. `--advisor --chrome`)
 * into argv tokens for spawning an agent CLI (TASK-UQF55). Whitespace
 * separates tokens; single or double quotes group a value into one token
 * (the quotes are stripped; no nested-quote or backslash escaping). Returns
 * [] for empty/whitespace-only input. Throws a human-readable Error on an
 * unterminated quote so the caller can surface it on the agent run.
 */
export function parseAgentArgs(raw: string | null | undefined): string[] {
  if (!raw) return []
  const tokens: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let hasToken = false
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      hasToken = true
    } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (hasToken) {
        tokens.push(cur)
        cur = ''
        hasToken = false
      }
    } else {
      cur += ch
      hasToken = true
    }
  }
  if (quote)
    throw new Error(`Unterminated ${quote === '"' ? 'double' : 'single'} quote in agent arguments`)
  if (hasToken) tokens.push(cur)
  return tokens
}

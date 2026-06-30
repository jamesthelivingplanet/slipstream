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

/** Claude Code CLI flags. */
export const CLAUDE_FLAGS = {
  skipPermissions: '--dangerously-skip-permissions',
  sessionId: '--session-id',
  resume: '--resume',
  remoteControl: '--remote-control',
  mcpConfig: '--mcp-config',
} as const

/** opencode CLI flags. */
export const OPENCODE_FLAGS = {
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

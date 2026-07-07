/**
 * Environment scrubbing for spawned agent PTYs.
 *
 * Agents run arbitrary repo code, so they must not inherit the daemon's
 * internal variables — above all SLIPSTREAM_TOKEN, which would let worktree
 * code open the daemon's WebSocket RPC and drive every other session. The
 * app MCP server does not rely on inheritance either: its env is written
 * explicitly into the per-session MCP config (see mcpConfig.ts).
 *
 * Pure (no node-pty import) so it stays unit-testable under plain Node.
 */

const DAEMON_INTERNAL_KEYS = [
  'SLIPSTREAM_TOKEN',
  'SLIPSTREAM_PORT',
  'SLIPSTREAM_BIND',
  'SLIPSTREAM_DAEMON_URL',
  'SLIPSTREAM_DAEMON_EPHEMERAL',
]

/** Merge the daemon's environment with per-session overrides, then strip the
 *  daemon-internal keys. Overrides win over the base env (matching the
 *  previous spread order) but cannot re-introduce a scrubbed key. */
export function buildAgentEnv(
  base: NodeJS.ProcessEnv,
  overrides?: Record<string, string>,
): Record<string, string> {
  const merged = { ...base, ...(overrides ?? {}) } as Record<string, string>
  for (const key of DAEMON_INTERNAL_KEYS) delete merged[key]
  return merged
}

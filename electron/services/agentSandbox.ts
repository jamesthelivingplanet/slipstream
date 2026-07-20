/**
 * Opt-in bubblewrap (`bwrap`) containment for agent PTYs (FLO-146).
 *
 * Off by default; enabled via `SLIPSTREAM_SANDBOX=bwrap`. When enabled and
 * `bwrap` is on PATH, the spawned agent cmd/args are wrapped so the process
 * runs in a new mount namespace where the daemon's data dir is overmounted
 * with a tmpfs — hiding `daemon.json`, `slipstream.db`, `secret.key`/
 * `secret.salt`, and every other session's directory. Only the session's own
 * subtree (`sessions/<sid>`, rw — so the daemon's `fs.watch`-based status
 * sentinel still sees writes through the shared host inode), the CLI wrapper
 * dir (`bin`, ro), and the clipboard dir (`clipboard`, ro) are re-bound.
 * Everything else — `/`, home, the worktree, `/dev`, `/proc`, and the
 * network namespace — stays shared, so tools keep working and agents can
 * still reach localhost-embedded servers.
 *
 * This is NOT a uid change. Containment here is purely the mount namespace
 * hiding the data dir from the agent's view of the filesystem, which is what
 * satisfies the "no read access to the data dir" acceptance bar — see
 * docs/SECURITY.md §7.
 *
 * Pure/Node-only (no node-pty import) so this stays unit-testable under
 * plain Node.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

export type SandboxMode = 'none' | 'bwrap'

/** `'bwrap'` iff `SLIPSTREAM_SANDBOX=bwrap` is set; `'none'` otherwise
 *  (unset, or any other value). */
export function resolveSandboxMode(env: NodeJS.ProcessEnv): SandboxMode {
  return env.SLIPSTREAM_SANDBOX === 'bwrap' ? 'bwrap' : 'none'
}

export interface SandboxWrapParams {
  dataDir: string
  sessionId: string
  cmd: string
  args: string[]
}

/** PURE — builds the argv to pass to `bwrap` (not including the `bwrap`
 *  binary name itself). See the module header for the containment recipe. */
export function buildBwrapArgs(p: SandboxWrapParams): string[] {
  return [
    '--dev-bind',
    '/',
    '/',
    '--tmpfs',
    p.dataDir,
    '--ro-bind-try',
    path.join(p.dataDir, 'bin'),
    path.join(p.dataDir, 'bin'),
    '--bind-try',
    path.join(p.dataDir, 'sessions', p.sessionId),
    path.join(p.dataDir, 'sessions', p.sessionId),
    '--ro-bind-try',
    path.join(p.dataDir, 'clipboard'),
    path.join(p.dataDir, 'clipboard'),
    '--die-with-parent',
    '--',
    p.cmd,
    ...p.args,
  ]
}

let cached: boolean | undefined

/** Real detection of `bwrap` on PATH, module-cached after the first call. */
export function bwrapAvailable(): boolean {
  if (cached !== undefined) return cached
  try {
    execFileSync('bwrap', ['--version'], { stdio: 'ignore' })
    cached = true
  } catch {
    cached = false
  }
  return cached
}

export interface SandboxSpec {
  cmd: string
  args: string[]
  sandboxed: boolean
}

export interface SandboxDeps {
  mode?: SandboxMode
  available?: boolean
  ensureSessionDir?: (dir: string) => void
  warn?: (msg: string) => void
}

// Dedupes log spam across sessions — a message is only warned once per process.
const warned = new Set<string>()

function warnOnce(deps: SandboxDeps | undefined, msg: string): void {
  if (warned.has(msg)) return
  warned.add(msg)
  ;(deps?.warn ?? ((m: string) => console.warn('[slipstream] ' + m)))(msg)
}

/** Decides whether/how to wrap an agent spawn under bwrap. Passthrough
 *  (`sandboxed: false`, cmd/args unchanged) whenever the sandbox is off,
 *  misconfigured, or `bwrap` is unavailable — this is fail-open by design so
 *  a missing/absent sandbox never blocks agent launch. */
export function sandboxSpawnSpec(
  input: { cmd: string; args: string[]; env: Record<string, string> },
  deps?: SandboxDeps,
): SandboxSpec {
  const mode = deps?.mode ?? resolveSandboxMode(process.env)
  if (mode === 'none') {
    return { cmd: input.cmd, args: input.args, sandboxed: false }
  }

  const dataDir = input.env.SLIPSTREAM_DATA_DIR
  const sessionId = input.env.SLIPSTREAM_SESSION_ID
  if (!dataDir || !sessionId) {
    warnOnce(
      deps,
      'SLIPSTREAM_SANDBOX=bwrap set but SLIPSTREAM_DATA_DIR/SESSION_ID missing from session env; running agent UNSANDBOXED',
    )
    return { cmd: input.cmd, args: input.args, sandboxed: false }
  }

  const available = deps?.available ?? bwrapAvailable()
  if (!available) {
    warnOnce(
      deps,
      'SLIPSTREAM_SANDBOX=bwrap set but bwrap not found on PATH; running agent UNSANDBOXED',
    )
    return { cmd: input.cmd, args: input.args, sandboxed: false }
  }

  const sessionDir = path.join(dataDir, 'sessions', sessionId)
  // The rw bind needs a real host target so the daemon's watcher shares the
  // inode with what the sandboxed agent writes.
  ;(deps?.ensureSessionDir ?? ((d: string) => fs.mkdirSync(d, { recursive: true })))(sessionDir)

  return {
    cmd: 'bwrap',
    args: buildBwrapArgs({ dataDir, sessionId, cmd: input.cmd, args: input.args }),
    sandboxed: true,
  }
}

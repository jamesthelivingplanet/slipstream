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
 * Per-worktree dev instances (each with its own `SLIPSTREAM_DATA_DIR`, e.g.
 * this repo's own dev checkout) sandbox their OWN data dir with the recipe
 * above, but production's data dir (`~/.config/slipstream`, outside a dev
 * instance's view) is a different directory and would otherwise be fully
 * visible to a sandboxed agent through the shared `--dev-bind / /`. When
 * `prodDataDir`/`prodRepoRoot` are supplied (resolved from the daemon's own
 * env via `resolveProdPaths`, never hardcoded here), two more mounts are
 * added on top of the recipe above:
 *   - `--tmpfs <prodDataDir>` — hides production's `daemon.json`/
 *     `slipstream.db`/secrets the same way the dev instance's own data dir
 *     is hidden. Skipped when it resolves to the same path as `dataDir`, OR
 *     when it is a PARENT of `dataDir` (the existing `--tmpfs dataDir`
 *     already covers the same-path case; a duplicate mount of the same path
 *     is redundant, and mounting a tmpfs over an ancestor of `dataDir` would
 *     silently shadow `dataDir` itself — including the session-dir bind
 *     mount below it — which is the opposite of the intended behavior).
 *   - `--ro-bind-try <prodRepoRoot> <prodRepoRoot>` — makes production's
 *     checkout read-only to the sandboxed agent, UNLESS the session's own
 *     `cwd` is that checkout (or nested inside it) — an agent legitimately
 *     working in the main checkout must not have it silently made
 *     read-only underneath it.
 * Both are plain `--tmpfs`/`--ro-bind-try`, consistent with the rest of the
 * recipe, so a missing/nonexistent path is not a hard failure.
 *
 * LIMIT — this is filesystem containment ONLY. It does not, and cannot,
 * block `systemctl --user restart slipstream.service` or `tailscale serve`
 * run from inside a sandboxed agent PTY: the systemd user bus and the
 * network namespace are deliberately left shared (see above — dev deploys
 * kicked off from inside an agent PTY need to reach both), so a sandboxed
 * agent can still ask systemd to restart the production service or reshape
 * Tailscale serve config even though it cannot read/write prod's files
 * directly. Those two are enforced separately by the `PreToolUse` guard
 * hook — see `.claude/settings.json` and `scripts/guard-prod.mjs`.
 *
 * This is NOT a uid change. Containment here is purely the mount namespace
 * hiding the data dir (and, now, production's data dir/checkout) from the
 * agent's view of the filesystem, which is what satisfies the "no read
 * access to the data dir" acceptance bar — see docs/SECURITY.md §7.
 *
 * SIDE EFFECT OF THE USERNS: `bwrap`'s unprivileged user namespace maps only
 * the sandboxed uid (`uid_map` is a single `<uid> <uid> 1` line) — every
 * file owned by any OTHER uid, including root, appears owned by
 * `nobody`(65534) inside the sandbox, no matter its real owner or mode bits.
 * OpenSSH's `Include` directive (used by the distro's `/etc/ssh/ssh_config`
 * to pull in `/etc/ssh/ssh_config.d/*.conf`) refuses to load a file it
 * doesn't trust the ownership of, so every root-owned client-config
 * drop-in breaks with "Bad owner or permissions on ..." — which breaks
 * `ssh`/git-over-SSH entirely for every sandboxed agent, since OpenSSH
 * aborts rather than skip the untrusted file. The fix is `--tmpfs` over
 * `/etc/ssh/ssh_config.d` (added only when that directory exists on the
 * host — fail-open, same tolerance as the rest of this recipe): it removes
 * only the drop-ins, which are always going to be owned by some non-sandbox
 * uid in this userns and so were never going to be loadable anyway. Left
 * untouched: `/etc/ssh/ssh_config` itself (still nobody-owned but NOT
 * `Include`d, so OpenSSH doesn't apply the ownership check to it — its
 * `Include /etc/ssh/ssh_config.d/*.conf` line just matches nothing now) and
 * the user's own `~/.ssh/config`/keys/`known_hosts` (owned by the sandboxed
 * uid itself, so correctly mapped and untouched by this mount) — host
 * aliases, per-host `IdentityFile`, `StrictHostKeyChecking`, etc. all keep
 * working exactly as configured. No `GIT_SSH_COMMAND`/`-F` override is
 * injected, so this fixes bare `ssh` too, not just `git`.
 *
 * Pure/Node-only (no node-pty import) so this stays unit-testable under
 * plain Node.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

export type SandboxMode = 'none' | 'bwrap'

/** Where OpenSSH loads client-config drop-ins from on this system. Not
 *  configurable — it's a fixed OS path, not something a per-install env var
 *  should be steering. See the module header for why this needs hiding. */
export const SSH_CONFIG_DROPIN_DIR = '/etc/ssh/ssh_config.d'

/** `'bwrap'` iff `SLIPSTREAM_SANDBOX=bwrap` is set; `'none'` otherwise
 *  (unset, or any other value). */
export function resolveSandboxMode(env: NodeJS.ProcessEnv): SandboxMode {
  return env.SLIPSTREAM_SANDBOX === 'bwrap' ? 'bwrap' : 'none'
}

/** PURE — reads production's data dir/checkout from the daemon's own env.
 *  Host-agnostic by design: nothing here hardcodes `~/.config/slipstream`
 *  or `~/.repositories/slipstream`; both are `undefined` (containment
 *  no-op) unless the daemon's environment sets them. */
export function resolveProdPaths(env: NodeJS.ProcessEnv): {
  prodDataDir: string | undefined
  prodRepoRoot: string | undefined
} {
  return {
    prodDataDir: env.SLIPSTREAM_PROD_DATA_DIR || undefined,
    prodRepoRoot: env.SLIPSTREAM_PROD_REPO_ROOT || undefined,
  }
}

/** True iff `child` (already resolved) is `parent` (already resolved) itself
 *  or nested inside it. */
function isSameOrParentPath(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export interface SandboxWrapParams {
  dataDir: string
  sessionId: string
  cmd: string
  args: string[]
  /** Production's data dir (per-worktree dev instances only — see module
   *  header). Tmpfs'd in addition to `dataDir` when it resolves to a
   *  different path; omitted (no-op) when unset. */
  prodDataDir?: string
  /** Production's checkout (per-worktree dev instances only — see module
   *  header). Ro-bind'd unless `cwd` is inside it; omitted (no-op) when
   *  unset. */
  prodRepoRoot?: string
  /** The session's own cwd/worktree. Used only to decide whether the
   *  `prodRepoRoot` ro-bind applies — an agent legitimately working in the
   *  main checkout must not have it made read-only. */
  cwd?: string
  /** `SSH_CONFIG_DROPIN_DIR` when it exists on the host, `undefined`
   *  otherwise (checked by the caller — this function stays pure/no fs).
   *  Tmpfs'd so root-owned ssh client-config drop-ins — unloadable inside
   *  the sandbox's userns regardless of their content, see module header —
   *  don't break `ssh`/git-over-SSH for the sandboxed agent. Omitted
   *  (no-op) when unset, e.g. on a host with no such directory. */
  sshConfigDir?: string
}

/** PURE — builds the argv to pass to `bwrap` (not including the `bwrap`
 *  binary name itself). See the module header for the containment recipe. */
export function buildBwrapArgs(p: SandboxWrapParams): string[] {
  const args = [
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
  ]

  if (p.sshConfigDir) {
    args.push('--tmpfs', p.sshConfigDir)
  }

  if (p.prodDataDir && !isSameOrParentPath(path.resolve(p.prodDataDir), path.resolve(p.dataDir))) {
    args.push('--tmpfs', p.prodDataDir)
  }

  if (p.prodRepoRoot) {
    const resolvedProdRepo = path.resolve(p.prodRepoRoot)
    // Unknown cwd is treated as "not inside" — fail toward containment
    // rather than silently leaving prod writable.
    const insideProdRepo =
      p.cwd !== undefined && isSameOrParentPath(resolvedProdRepo, path.resolve(p.cwd))
    if (!insideProdRepo) {
      args.push('--ro-bind-try', p.prodRepoRoot, p.prodRepoRoot)
    }
  }

  args.push('--die-with-parent', '--', p.cmd, ...p.args)
  return args
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
  /** Existence check for `SSH_CONFIG_DROPIN_DIR`, injectable so tests don't
   *  depend on the real host's `/etc/ssh` layout. Defaults to `fs.existsSync`. */
  sshConfigDirExists?: (dir: string) => boolean
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
  input: { cmd: string; args: string[]; env: Record<string, string>; cwd?: string },
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

  const { prodDataDir, prodRepoRoot } = resolveProdPaths(process.env)

  const sshConfigDirExists = deps?.sshConfigDirExists ?? fs.existsSync
  const sshConfigDir = sshConfigDirExists(SSH_CONFIG_DROPIN_DIR) ? SSH_CONFIG_DROPIN_DIR : undefined

  return {
    cmd: 'bwrap',
    args: buildBwrapArgs({
      dataDir,
      sessionId,
      cmd: input.cmd,
      args: input.args,
      prodDataDir,
      prodRepoRoot,
      cwd: input.cwd,
      sshConfigDir,
    }),
    sandboxed: true,
  }
}

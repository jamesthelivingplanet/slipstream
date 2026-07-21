import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { RepoDTO } from '../shared/contract.js'

const execFileAsync = promisify(execFile)

/** Git transports we allow `cloneRepo` to invoke. Everything else — most
 *  importantly the `ext::` remote helper, which runs an arbitrary shell
 *  command as its "transport" — is rejected before git ever sees the URL.
 *  `file:` stays allowed because bare local filesystem paths (no scheme,
 *  used by our own tests and legitimate local remotes) resolve to it. */
const ALLOWED_CLONE_PROTOCOLS = 'https:ssh:file'

/**
 * Reject git remote "URLs" that aren't a plain https/ssh address or a bare
 * local filesystem path. Git treats any `<scheme>::<data>` or
 * `<scheme>://<data>` prefix as a request to invoke `git-remote-<scheme>`,
 * so an unvalidated string handed to `git clone` is command execution via
 * `ext::sh -c '<anything>'`. `GIT_ALLOW_PROTOCOL` (set in `cloneRepo`) is a
 * second, independent layer against the same class of bypass.
 */
export function assertAllowedRemoteUrl(remoteUrl: string): void {
  if (!remoteUrl || remoteUrl.startsWith('-')) {
    throw new Error(`Unsupported git remote URL: ${remoteUrl}`)
  }
  // scp-like syntax, e.g. git@github.com:org/repo.git — a single colon not
  // followed by another colon, with a user@host in front. Git treats this
  // as ssh.
  if (/^[\w.-]+@[\w.-]+:(?!:)/.test(remoteUrl)) return

  const schemeMatch = remoteUrl.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/)
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase()
    const rest = remoteUrl.slice(schemeMatch[0].length)
    if ((scheme === 'https' || scheme === 'ssh') && rest.startsWith('//')) return
    throw new Error(
      `Unsupported git remote URL scheme "${scheme}:" — only https and ssh are allowed.`,
    )
  }

  // No scheme at all: a bare local filesystem path. Allowed (matches
  // git's own default behavior, and used by local/test clones).
}

/** Get the origin remote URL for a checkout, or null when unset / not a git repo / path gone. */
export function getRemoteUrl(absPath: string): string | null {
  try {
    const url = execFileSync('git', ['-C', absPath, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
    }).trim()
    return url || null
  } catch {
    return null
  }
}

/** Clone `remoteUrl` into `dest`. Throws a clear error (with git's stderr) on
 *  failure — bad URL, auth, or network. The caller ensures `dest` does not
 *  already exist. Async: a clone can take minutes over a slow link, and a
 *  synchronous spawn would freeze every live agent PTY for the duration. */
export async function cloneRepo(remoteUrl: string, dest: string): Promise<void> {
  assertAllowedRemoteUrl(remoteUrl)
  try {
    await execFileAsync('git', ['clone', remoteUrl, dest], {
      encoding: 'utf8',
      env: { ...process.env, GIT_ALLOW_PROTOCOL: ALLOWED_CLONE_PROTOCOLS },
    })
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string }
    throw new Error(
      `Failed to clone ${remoteUrl}: ${(e.stderr ?? e.message ?? String(err)).trim()}`,
      {
        cause: err,
      },
    )
  }
}

/** True when absPath exists and is inside a git work tree. */
export function isWorkTree(absPath: string): boolean {
  if (!existsSync(absPath)) return false
  try {
    return (
      execFileSync('git', ['-C', absPath, 'rev-parse', '--is-inside-work-tree'], {
        encoding: 'utf8',
      }).trim() === 'true'
    )
  } catch {
    return false
  }
}

/**
 * Search the sibling directories of `storedPath` for a git checkout whose
 * origin remote URL matches `remoteUrl`. Returns the matching absolute path,
 * or null when no sibling matches. Used to self-heal a moved/renamed repo.
 */
export function findSiblingCheckout(remoteUrl: string, storedPath: string): string | null {
  const parent = dirname(storedPath)
  let entries: string[]
  try {
    entries = readdirSync(parent)
  } catch {
    return null
  }
  for (const entry of entries) {
    const candidate = join(parent, entry)
    try {
      if (!statSync(candidate).isDirectory()) continue
    } catch {
      continue
    }
    if (candidate === storedPath) continue
    if (getRemoteUrl(candidate) === remoteUrl && isWorkTree(candidate)) {
      return candidate
    }
  }
  return null
}

export interface ResolveResult {
  repo: RepoDTO
  healed: boolean
}

/**
 * Resolve the current on-disk path of a repo, self-healing when the stored
 * path no longer matches. Returns the resolved repo (path possibly updated)
 * or null when no checkout can be found. Pure of DB — the caller persists the
 * updated path when `healed` is true.
 */
export function resolveRepoPath(repo: RepoDTO): ResolveResult | null {
  if (isWorkTree(repo.path)) {
    const currentRemote = getRemoteUrl(repo.path)
    if (!repo.remoteUrl || currentRemote === repo.remoteUrl) {
      return { repo, healed: false }
    }
  }

  if (repo.remoteUrl) {
    const healed = findSiblingCheckout(repo.remoteUrl, repo.path)
    if (healed) {
      return { repo: { ...repo, path: healed }, healed: true }
    }
  }

  return null
}

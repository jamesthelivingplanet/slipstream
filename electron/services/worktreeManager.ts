import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { IWorktreeManager, RepoDTO, WorktreeInfo } from '../shared/contract.js'

// ── Pure parse helpers (exported for unit tests) ─────────────────────────────

/**
 * Parse `git status --porcelain` output.
 * Returns true when the output is non-empty (dirty).
 */
export function parsePorcelainDirty(output: string): boolean {
  return output.trim().length > 0
}

/**
 * Parse `git rev-list --left-right --count <base>...<branch>`.
 * Output is two tab-separated integers: "<behind>\t<ahead>"
 * (left = base commits not in branch = behind; right = branch commits not in base = ahead).
 */
export function parseRevListCount(output: string): { ahead: number; behind: number } {
  const parts = output.trim().split(/\s+/)
  const behind = parseInt(parts[0] ?? '0', 10)
  const ahead = parseInt(parts[1] ?? '0', 10)
  return {
    behind: isNaN(behind) ? 0 : behind,
    ahead: isNaN(ahead) ? 0 : ahead,
  }
}

/**
 * Parse `git diff --shortstat <base>` output.
 * Example: " 3 files changed, 12 insertions(+), 4 deletions(-)"
 */
export function parseShortstat(output: string): { added: number; deleted: number } {
  const insertMatch = output.match(/(\d+) insertion/)
  const deleteMatch = output.match(/(\d+) deletion/)
  return {
    added: insertMatch ? parseInt(insertMatch[1], 10) : 0,
    deleted: deleteMatch ? parseInt(deleteMatch[1], 10) : 0,
  }
}

/**
 * Parse `git worktree list --porcelain` output into an array of branch names.
 * Each stanza looks like:
 *   worktree /path/to/wt
 *   HEAD <sha>
 *   branch refs/heads/<branch>
 */
export function parsePorcelainWorktreeList(output: string): Array<{ path: string; branch: string }> {
  const stanzas = output.trim().split(/\n\n+/)
  const results: Array<{ path: string; branch: string }> = []

  for (const stanza of stanzas) {
    const lines = stanza.trim().split('\n')
    let wtPath = ''
    let branch = ''

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        wtPath = line.slice('worktree '.length).trim()
      } else if (line.startsWith('branch ')) {
        branch = line.slice('branch '.length).replace('refs/heads/', '').trim()
      }
    }

    if (wtPath && branch) {
      results.push({ path: wtPath, branch })
    }
  }

  return results
}

/**
 * True when a git error indicates the worktree path is missing or no longer a
 * valid working tree (moved/deleted dir, stale admin entry). Such an agent is
 * "detached" — treat its worktree as already gone rather than erroring.
 */
export function isMissingWorktreeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /not a working tree|No such file or directory|not a git repository/i.test(msg)
}

// ── Implementation ────────────────────────────────────────────────────────────

function git(args: string[], opts?: { cwd?: string }): string {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      cwd: opts?.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    throw new Error(
      `git ${args.slice(0, 3).join(' ')} failed: ${e.stderr ?? e.message ?? String(err)}`,
    )
  }
}

/**
 * "Pull before create": refresh the repo's base branch from origin so a brand-new
 * branch is cut from the latest remote state. Returns the start point to branch
 * from. Best-effort and offline-safe:
 *   1. Fast-forward the LOCAL base ref straight from origin without a checkout
 *      (`fetch origin <base>:<base>`) — keeps the new branch's ahead/behind honest.
 *      Fails when base is the repo's checked-out branch or the update isn't a
 *      fast-forward; then we fall through.
 *   2. Fetch the remote-tracking ref and cut from `origin/<base>` instead.
 *   3. No origin at all (local-only repo) / offline — cut from the local <base>,
 *      exactly as before.
 */
function pullBaseStartPoint(repoPath: string, base: string): string {
  try {
    git(['-C', repoPath, 'fetch', 'origin', `${base}:${base}`])
    return base
  } catch {
    // base is checked out, non-fast-forward, or no origin — try a plain fetch.
  }
  try {
    git(['-C', repoPath, 'fetch', 'origin', base])
    git(['-C', repoPath, 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${base}`])
    return `origin/${base}`
  } catch {
    // local-only repo / offline — fall back to the local base as before.
  }
  return base
}

export function createWorktreeManager(root: string): IWorktreeManager {
  return {
    // Pure, synchronous — no git calls.
    pathFor(repo: RepoDTO, branch: string): string {
      return join(root, '.worktrees', `${repo.org}-${repo.name}`, branch)
    },

    async create(repo: RepoDTO, branch: string): Promise<WorktreeInfo> {
      const wt = this.pathFor(repo, branch)

      // Idempotent: a failed previous attempt may have left a registered
      // worktree and/or the branch ref behind — reuse whatever's there.
      const existing = parsePorcelainWorktreeList(
        git(['-C', repo.path, 'worktree', 'list', '--porcelain']),
      )
      if (existing.some((e) => e.path === wt)) {
        return this.status(repo, branch)
      }

      // git() throws on non-zero exit; show-ref --quiet exits non-zero when the
      // ref is absent, so flip a boolean in the catch.
      let branchExists = true
      try {
        git(['-C', repo.path, 'show-ref', '--verify', '--quiet', 'refs/heads/' + branch])
      } catch {
        branchExists = false
      }

      if (branchExists) {
        // Check out the existing branch into a new worktree (no -b).
        git(['-C', repo.path, 'worktree', 'add', wt, branch])
      } else {
        const startPoint = pullBaseStartPoint(repo.path, repo.base)
        git(['-C', repo.path, 'worktree', 'add', wt, '-b', branch, startPoint])
      }

      return this.status(repo, branch)
    },

    async remove(
      repo: RepoDTO,
      branch: string,
      opts?: { force?: boolean },
    ): Promise<{ removed: boolean; reason?: string }> {
      const wt = this.pathFor(repo, branch)
      const present = existsSync(wt)

      if (!opts?.force) {
        // Uncommitted-change guard only applies when the worktree still exists.
        if (present) {
          let porcelain = ''
          try {
            porcelain = git(['-C', wt, 'status', '--porcelain'])
          } catch {
            // if we can't even run git here, let worktree remove decide
          }
          if (parsePorcelainDirty(porcelain)) {
            return { removed: false, reason: 'Worktree has uncommitted changes.' }
          }
        }

        // Unmerged-commit guard: the branch ref still exists even when the
        // worktree directory is gone, so always honour it.
        let countOut = ''
        try {
          countOut = git(['-C', repo.path, 'rev-list', '--count', `${repo.base}..${branch}`])
        } catch {
          // swallow — be permissive if we can't determine
        }
        const unmerged = parseInt(countOut.trim(), 10)
        if (!isNaN(unmerged) && unmerged > 0) {
          return {
            removed: false,
            reason: `Branch has ${unmerged} commit(s) not merged into ${repo.base}.`,
          }
        }
      }

      if (present) {
        const removeArgs = ['-C', repo.path, 'worktree', 'remove']
        if (opts?.force) removeArgs.push('--force')
        removeArgs.push(wt)
        try {
          git(removeArgs)
        } catch (err) {
          // A worktree that vanished underneath us (moved/deleted dir, stale admin
          // entry) is a detached agent — treat it as already gone and fall through
          // to prune + branch delete rather than surfacing a raw `git fatal:` error.
          if (!isMissingWorktreeError(err)) throw err
        }
      }

      // Prune stale admin entries (also clears the record for a vanished worktree).
      try {
        git(['-C', repo.path, 'worktree', 'prune'])
      } catch {
        // prune failure does not fail the removal
      }

      // Delete the branch
      try {
        git(['-C', repo.path, 'branch', '-D', branch])
      } catch {
        // deleting an already-gone branch doesn't fail removal
      }

      return { removed: true }
    },

    async status(repo: RepoDTO, branch: string): Promise<WorktreeInfo> {
      const wt = this.pathFor(repo, branch)

      // dirty
      let dirty = false
      try {
        const porcelain = git(['-C', wt, 'status', '--porcelain'])
        dirty = parsePorcelainDirty(porcelain)
      } catch { /* default false */ }

      // ahead / behind
      let ahead = 0
      let behind = 0
      try {
        const rl = git(['-C', repo.path, 'rev-list', '--left-right', '--count', `${repo.base}...${branch}`])
        ;({ ahead, behind } = parseRevListCount(rl))
      } catch { /* defaults */ }

      // added / deleted lines vs branch point (merge-base of base and HEAD)
      let added = 0
      let deleted = 0
      try {
        const mergeBase = git(['-C', wt, 'merge-base', repo.base, 'HEAD']).trim()
        const stat = git(['-C', wt, 'diff', '--shortstat', mergeBase])
        ;({ added, deleted } = parseShortstat(stat))
      } catch { /* defaults */ }

      return { branch, path: wt, dirty, ahead, behind, added, deleted }
    },

    async list(repo: RepoDTO): Promise<WorktreeInfo[]> {
      const raw = git(['-C', repo.path, 'worktree', 'list', '--porcelain'])
      const entries = parsePorcelainWorktreeList(raw)

      const results: WorktreeInfo[] = []
      for (const { branch } of entries) {
        // Skip the main checkout (which lives at repo.path itself)
        const wt = this.pathFor(repo, branch)
        if (wt === repo.path) continue

        try {
          results.push(await this.status(repo, branch))
        } catch {
          // include a minimal entry rather than dropping the worktree
          results.push({
            branch,
            path: wt,
            dirty: false,
            ahead: 0,
            behind: 0,
            added: 0,
            deleted: 0,
          })
        }
      }
      return results
    },
  }
}

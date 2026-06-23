import { execFileSync } from 'node:child_process'
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

export function createWorktreeManager(root: string): IWorktreeManager {
  return {
    // Pure, synchronous — no git calls.
    pathFor(repo: RepoDTO, branch: string): string {
      return join(root, '.worktrees', `${repo.org}-${repo.name}`, branch)
    },

    async create(repo: RepoDTO, branch: string): Promise<WorktreeInfo> {
      const wt = this.pathFor(repo, branch)
      git(['-C', repo.path, 'worktree', 'add', wt, '-b', branch, repo.base])
      return this.status(repo, branch)
    },

    async remove(
      repo: RepoDTO,
      branch: string,
      opts?: { force?: boolean },
    ): Promise<{ removed: boolean; reason?: string }> {
      const wt = this.pathFor(repo, branch)

      if (!opts?.force) {
        // Check for uncommitted changes
        let porcelain = ''
        try {
          porcelain = git(['-C', wt, 'status', '--porcelain'])
        } catch {
          // if we can't even run git here, let worktree remove decide
        }
        if (parsePorcelainDirty(porcelain)) {
          return { removed: false, reason: 'Worktree has uncommitted changes.' }
        }

        // Check for unmerged commits (branch ahead of base)
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

      const removeArgs = ['-C', repo.path, 'worktree', 'remove']
      if (opts?.force) removeArgs.push('--force')
      removeArgs.push(wt)

      git(removeArgs)

      // Prune stale admin entries (safety net)
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

      // added / deleted lines vs base
      let added = 0
      let deleted = 0
      try {
        const stat = git(['-C', wt, 'diff', '--shortstat', repo.base])
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

import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type {
  DiffFileDTO,
  IWorktreeManager,
  RepoDTO,
  WorktreeDiffDTO,
  WorktreeInfo,
  WorktreeUpdateMode,
  WorktreeUpdateResultDTO,
} from '../shared/contract.js'
import { parseUnifiedDiff } from './diffParser.js'

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
export function parsePorcelainWorktreeList(
  output: string,
): Array<{ path: string; branch: string }> {
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

/** True when git output indicates a content conflict (rebase or merge). */
export function isConflictOutput(output: string): boolean {
  return /CONFLICT|could not apply|Automatic merge failed|would be overwritten/i.test(output)
}

/** True when git parked the autostash in the stash list because re-applying it conflicted. */
export function hasAutostashConflict(output: string): boolean {
  return /autostash resulted in conflicts|safe in the stash/i.test(output)
}

// ── Implementation ────────────────────────────────────────────────────────────

const execFileAsync = promisify(execFile)

// Async so a slow git call (e.g. a network fetch) never blocks the daemon's
// event loop — a sync exec here would freeze every live agent PTY stream.
async function git(
  args: string[],
  opts?: { cwd?: string; maxBuffer?: number; allowExit1?: boolean },
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      encoding: 'utf8',
      cwd: opts?.cwd,
      maxBuffer: opts?.maxBuffer,
    })
    return stdout
  } catch (err: unknown) {
    const e = err as {
      code?: number | string
      status?: number
      stdout?: string
      stderr?: string
      message?: string
    }
    // `git diff --no-index` exits 1 (not an error) when the compared paths
    // differ — the caller opts in to treat that as success and read stdout.
    // Async execFile reports the exit status as `code`; sync used `status`.
    const exitCode = typeof e.code === 'number' ? e.code : e.status
    if (opts?.allowExit1 && exitCode === 1 && typeof e.stdout === 'string') {
      return e.stdout
    }
    throw new Error(
      `git ${args.slice(0, 3).join(' ')} failed: ${e.stderr ?? e.message ?? String(err)}`,
      {
        cause: err,
      },
    )
  }
}

/** Like git(), but never throws — conflict handling needs the exit code and
 *  full output of a failed rebase/merge, not an exception. */
async function gitResult(
  args: string[],
  opts?: { cwd?: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      encoding: 'utf8',
      cwd: opts?.cwd,
    })
    return { code: 0, stdout, stderr: stderr ?? '' }
  } catch (err: unknown) {
    const e = err as { code?: number | string; status?: number; stdout?: string; stderr?: string }
    const exitCode = typeof e.code === 'number' ? e.code : (e.status ?? -1)
    return { code: exitCode, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

/**
 * Diff a single untracked file against /dev/null so it renders through the
 * same unified-diff parser as tracked changes. `--no-index` exits 1 (not 0)
 * whenever the two sides differ, which is the expected/only case here.
 */
async function gitNoIndexDiff(wt: string, file: string): Promise<string> {
  return git(
    [
      '-C',
      wt,
      '-c',
      'core.quotepath=false',
      // Force canonical a// b/ prefixes; a user-set diff.mnemonicprefix=true
      // would otherwise emit c// w// etc. and break the parser's path stripping.
      '-c',
      'diff.mnemonicprefix=false',
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-index',
      '--',
      '/dev/null',
      file,
    ],
    { allowExit1: true },
  )
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
async function pullBaseStartPoint(repoPath: string, base: string): Promise<string> {
  try {
    await git(['-C', repoPath, 'fetch', 'origin', `${base}:${base}`])
    return base
  } catch {
    // base is checked out, non-fast-forward, or no origin — try a plain fetch.
  }
  try {
    await git(['-C', repoPath, 'fetch', 'origin', base])
    await git(['-C', repoPath, 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${base}`])
    return `origin/${base}`
  } catch {
    // local-only repo / offline — fall back to the local base as before.
  }
  return base
}

/**
 * Detect a SQUASH merge: the branch's individual commits are absent from base
 * (different SHAs), but base already contains an equivalent patch. Synthesize a
 * single commit holding the branch's cumulative diff on top of the merge-base,
 * then ask `git cherry` whether base already has that patch (`-` prefix means it
 * does). Best-effort — returns false if any git step fails.
 */
async function isSquashMerged(repoPath: string, base: string, branch: string): Promise<boolean> {
  try {
    const mergeBase = (await git(['-C', repoPath, 'merge-base', base, branch])).trim()
    if (!mergeBase) return false
    const tree = (await git(['-C', repoPath, 'rev-parse', `${branch}^{tree}`])).trim()
    const dangling = (
      await git(['-C', repoPath, 'commit-tree', tree, '-p', mergeBase, '-m', 'squash-merge-check'])
    ).trim()
    const cherry = await git(['-C', repoPath, 'cherry', base, dangling])
    return cherry.split('\n').some((line) => line.startsWith('-'))
  } catch {
    return false
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

      // Idempotent: a failed previous attempt may have left a registered
      // worktree and/or the branch ref behind — reuse whatever's there.
      const existing = parsePorcelainWorktreeList(
        await git(['-C', repo.path, 'worktree', 'list', '--porcelain']),
      )
      if (existing.some((e) => e.path === wt)) {
        return this.status(repo, branch)
      }

      // git() throws on non-zero exit; show-ref --quiet exits non-zero when the
      // ref is absent, so flip a boolean in the catch.
      let branchExists = true
      try {
        await git(['-C', repo.path, 'show-ref', '--verify', '--quiet', 'refs/heads/' + branch])
      } catch {
        branchExists = false
      }

      if (branchExists) {
        // Check out the existing branch into a new worktree (no -b).
        await git(['-C', repo.path, 'worktree', 'add', wt, branch])
      } else {
        const startPoint = await pullBaseStartPoint(repo.path, repo.base)
        await git(['-C', repo.path, 'worktree', 'add', wt, '-b', branch, startPoint])
      }

      return this.status(repo, branch)
    },

    async isMerged(
      repo: RepoDTO,
      branch: string,
    ): Promise<{ merged: boolean; via?: 'merge-commit' | 'squash'; ahead: number }> {
      // No branch ref → nothing to probe (and `ahead` must not read as 0,
      // which callers may combine with PR evidence).
      try {
        await git(['-C', repo.path, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
      } catch {
        return { merged: false, ahead: -1 }
      }

      // Refresh base so a merge that landed on the remote is visible locally.
      const baseRef = await pullBaseStartPoint(repo.path, repo.base)

      let ahead = -1
      try {
        const out = await git(['-C', repo.path, 'rev-list', '--count', `${baseRef}..${branch}`])
        const n = parseInt(out.trim(), 10)
        if (!isNaN(n)) ahead = n
      } catch {
        // permissive: leave ahead = -1
      }

      // 1) A merge commit on base since the fork point whose subject names the
      //    branch. Covers GitLab ("Merge branch '<branch>' into 'master'"),
      //    GitHub ("Merge pull request #N from <org>/<branch>"), Gitea/Forgejo
      //    ("Merge pull request 'title' (#N) from <branch>"), and Bitbucket
      //    ("Merged in <branch> (pull request #N)") for both plain and squash
      //    merges. Fixed-string (multiple --grep flags are OR'd), and bounded
      //    to merges after the fork point so an old branch-name collision
      //    can't false-positive.
      try {
        const mergeBase = (await git(['-C', repo.path, 'merge-base', baseRef, branch])).trim()
        if (mergeBase) {
          const hit = await git([
            '-C',
            repo.path,
            'log',
            '--merges',
            '--fixed-strings',
            '--grep',
            `'${branch}'`,
            '--grep',
            `/${branch}`,
            '--grep',
            ` from ${branch}`,
            '--grep',
            `in ${branch} (pull request`,
            '--format=%H',
            '-1',
            `${mergeBase}..${baseRef}`,
          ])
          if (hit.trim().length > 0) return { merged: true, via: 'merge-commit', ahead }
        }
      } catch {
        // fall through to the other signals
      }

      // 2) Squash merge without a telltale merge commit: the branch's cumulative
      //    patch is already on base even though its SHAs aren't (FLO-91 check).
      if (ahead !== 0 && (await isSquashMerged(repo.path, baseRef, branch))) {
        return { merged: true, via: 'squash', ahead }
      }

      // ahead === 0 alone is NOT merged evidence — a freshly cut branch also has
      // zero commits off base. Callers may combine it with a recorded PR.
      return { merged: false, ahead }
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
            porcelain = await git(['-C', wt, 'status', '--porcelain'])
          } catch {
            // if we can't even run git here, let worktree remove decide
          }
          if (parsePorcelainDirty(porcelain)) {
            return { removed: false, reason: 'Worktree has uncommitted changes.' }
          }
        }

        // Unmerged-commit guard: the branch ref still exists even when the
        // worktree directory is gone, so always honour it. Refresh base first so
        // a squash merge that landed on the remote base is visible locally.
        const baseRef = await pullBaseStartPoint(repo.path, repo.base)
        let countOut = ''
        try {
          countOut = await git(['-C', repo.path, 'rev-list', '--count', `${baseRef}..${branch}`])
        } catch {
          // swallow — be permissive if we can't determine
        }
        const unmerged = parseInt(countOut.trim(), 10)
        // A squash merge leaves the branch's original commits unmatched by SHA but
        // its cumulative patch already in base — treat that as merged (FLO-91).
        if (
          !isNaN(unmerged) &&
          unmerged > 0 &&
          !(await isSquashMerged(repo.path, baseRef, branch))
        ) {
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
          await git(removeArgs)
        } catch (err) {
          // A worktree that vanished underneath us (moved/deleted dir, stale admin
          // entry) is a detached agent — treat it as already gone and fall through
          // to prune + branch delete rather than surfacing a raw `git fatal:` error.
          if (!isMissingWorktreeError(err)) throw err
        }
      }

      // Prune stale admin entries (also clears the record for a vanished worktree).
      try {
        await git(['-C', repo.path, 'worktree', 'prune'])
      } catch {
        // prune failure does not fail the removal
      }

      // Delete the branch
      try {
        await git(['-C', repo.path, 'branch', '-D', branch])
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
        const porcelain = await git(['-C', wt, 'status', '--porcelain'])
        dirty = parsePorcelainDirty(porcelain)
      } catch {
        /* default false */
      }

      // ahead / behind
      let ahead = 0
      let behind = 0
      try {
        const rl = await git([
          '-C',
          repo.path,
          'rev-list',
          '--left-right',
          '--count',
          `${repo.base}...${branch}`,
        ])
        ;({ ahead, behind } = parseRevListCount(rl))
      } catch {
        /* defaults */
      }

      // added / deleted lines vs branch point (merge-base of base and HEAD)
      let added = 0
      let deleted = 0
      try {
        const mergeBase = (await git(['-C', wt, 'merge-base', repo.base, 'HEAD'])).trim()
        const stat = await git(['-C', wt, 'diff', '--shortstat', mergeBase])
        ;({ added, deleted } = parseShortstat(stat))
      } catch {
        /* defaults */
      }

      return { branch, path: wt, dirty, ahead, behind, added, deleted }
    },

    /**
     * Bring the worktree's branch up to date with repo.base. Refreshes base
     * from origin first (offline-safe, same as create()), then runs
     * `rebase --autostash` or `merge --autostash --no-edit`. Never leaves the
     * worktree mid-operation: any non-zero exit triggers an unconditional
     * `--abort`, restoring the pre-attempt state. An up-to-date branch still
     * runs the rebase/merge (a cheap no-op) rather than short-circuiting, so a
     * base advance revealed by the fetch is always picked up.
     */
    async updateFromBase(
      repo: RepoDTO,
      branch: string,
      opts: { mode: WorktreeUpdateMode },
    ): Promise<WorktreeUpdateResultDTO> {
      const { mode } = opts
      const wt = this.pathFor(repo, branch)

      if (!existsSync(wt)) {
        return { updated: false, mode, reason: `Worktree for "${branch}" is missing.` }
      }

      let head: string
      try {
        head = (await git(['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim()
      } catch (err) {
        const reason = isMissingWorktreeError(err)
          ? `Worktree for "${branch}" is missing.`
          : err instanceof Error
            ? err.message
            : String(err)
        return { updated: false, mode, reason }
      }
      if (head !== branch) {
        return { updated: false, mode, reason: `Worktree is on "${head}", expected "${branch}".` }
      }

      const baseRef = await pullBaseStartPoint(repo.path, repo.base)

      const res =
        mode === 'rebase'
          ? await gitResult(['-C', wt, 'rebase', '--autostash', baseRef])
          : await gitResult(['-C', wt, 'merge', '--autostash', '--no-edit', baseRef])

      if (res.code === 0) {
        const stashSaved = hasAutostashConflict(res.stdout + res.stderr)
        return { updated: true, mode, stashSaved, info: await this.status(repo, branch) }
      }

      // Non-zero exit — unconditionally abort so the worktree is never left
      // mid-rebase/mid-merge.
      const abort = await gitResult(['-C', wt, mode === 'rebase' ? 'rebase' : 'merge', '--abort'])
      const conflicted = abort.code === 0 || isConflictOutput(res.stdout + res.stderr)
      const stashSaved = hasAutostashConflict(res.stdout + res.stderr + abort.stdout + abort.stderr)

      let reason: string
      if (conflicted) {
        reason = `${mode === 'rebase' ? `Rebase onto ${repo.base}` : `Merge of ${repo.base}`} hit conflicts — the worktree was restored to its previous state.`
      } else {
        const firstNonEmptyLine = (text: string): string | undefined =>
          text
            .split('\n')
            .map((l) => l.trim())
            .find((l) => l.length > 0)
        reason =
          firstNonEmptyLine(res.stderr) ?? firstNonEmptyLine(res.stdout) ?? `git ${mode} failed`
      }

      let info: WorktreeInfo | undefined
      try {
        info = await this.status(repo, branch)
      } catch {
        // leave undefined
      }

      return { updated: false, mode, conflicted, stashSaved, reason, info }
    },

    async diff(repo: RepoDTO, branch: string): Promise<WorktreeDiffDTO> {
      const wt = this.pathFor(repo, branch)

      let mergeBase = ''
      try {
        mergeBase = (await git(['-C', wt, 'merge-base', repo.base, 'HEAD'])).trim()
      } catch (err) {
        const error = isMissingWorktreeError(err)
          ? `Worktree for "${branch}" is missing.`
          : `Could not find a merge-base with "${repo.base}": ${err instanceof Error ? err.message : String(err)}`
        return { branch, base: repo.base, mergeBase: '', files: [], truncated: false, error }
      }

      let raw: string
      try {
        raw = await git(
          [
            '-C',
            wt,
            '-c',
            'core.quotepath=false',
            // Force canonical a// b/ prefixes; a user-set diff.mnemonicprefix=true
            // would otherwise emit c// w// etc. and break the parser's path stripping.
            '-c',
            'diff.mnemonicprefix=false',
            'diff',
            '--no-color',
            '--no-ext-diff',
            '--find-renames',
            '--unified=3',
            mergeBase,
          ],
          { maxBuffer: 32 * 1024 * 1024 },
        )
      } catch (err) {
        return {
          branch,
          base: repo.base,
          mergeBase,
          files: [],
          truncated: false,
          error: `Could not compute diff: ${err instanceof Error ? err.message : String(err)}`,
        }
      }

      // Cap the raw tracked-diff size, truncating on a clean file boundary so
      // the parser never sees a half-emitted file.
      const RAW_CAP = 2 * 1024 * 1024
      let sizeTruncated = false
      if (raw.length > RAW_CAP) {
        const boundary = raw.lastIndexOf('\ndiff --git ', RAW_CAP)
        raw = boundary > 0 ? raw.slice(0, boundary) : raw.slice(0, RAW_CAP)
        sizeTruncated = true
      }

      // Untracked files don't show up in `git diff` — synthesize a diff for
      // each (against /dev/null) and fold it into the same raw text so the
      // one parser call produces the whole file list.
      let untrackedPaths: string[] = []
      try {
        untrackedPaths = (await git(['-C', wt, 'ls-files', '--others', '--exclude-standard']))
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, 50)
      } catch {
        // no untracked listing available — proceed with the tracked diff only
      }

      let untrackedRaw = ''
      const fallbackUntracked: DiffFileDTO[] = []
      for (const file of untrackedPaths) {
        let size: number
        try {
          size = statSync(join(wt, file)).size
        } catch {
          fallbackUntracked.push({
            path: file,
            status: 'untracked',
            binary: false,
            truncated: false,
            additions: 0,
            deletions: 0,
            hunks: [],
          })
          continue
        }
        if (size > 200 * 1024) continue // skip large untracked files entirely

        try {
          const out = await gitNoIndexDiff(wt, file)
          untrackedRaw += (untrackedRaw.length > 0 ? '\n' : '') + out.replace(/\n$/, '')
        } catch {
          fallbackUntracked.push({
            path: file,
            status: 'untracked',
            binary: false,
            truncated: false,
            additions: 0,
            deletions: 0,
            hunks: [],
          })
        }
      }

      const combinedRaw =
        untrackedRaw.length > 0
          ? `${raw}${raw.length > 0 && !raw.endsWith('\n') ? '\n' : ''}${untrackedRaw}`
          : raw

      const { files: parsedFiles, truncated: perFileTruncated } = parseUnifiedDiff(combinedRaw)

      // git shows an untracked file's synthesized /dev/null diff as "added";
      // relabel those to 'untracked' to match reality.
      const files = parsedFiles.map((f) =>
        untrackedPaths.includes(f.path) ? { ...f, status: 'untracked' as const } : f,
      )
      files.push(...fallbackUntracked)

      return {
        branch,
        base: repo.base,
        mergeBase,
        files,
        truncated: sizeTruncated || perFileTruncated,
      }
    },

    async list(repo: RepoDTO): Promise<WorktreeInfo[]> {
      const raw = await git(['-C', repo.path, 'worktree', 'list', '--porcelain'])
      const entries = parsePorcelainWorktreeList(raw)

      const results: WorktreeInfo[] = []
      for (const { path: stanzaPath, branch } of entries) {
        // Skip the main checkout — its stanza's path is the repo itself.
        if (stanzaPath === repo.path) continue

        try {
          results.push(await this.status(repo, branch))
        } catch {
          // include a minimal entry rather than dropping the worktree
          results.push({
            branch,
            path: this.pathFor(repo, branch),
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

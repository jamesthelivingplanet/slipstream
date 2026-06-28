import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Write AGENTS.md to the worktree root so OpenCode auto-discovers it as system prompt.
 * Also ensures AGENTS.md is ignored so it can't be accidentally committed.
 *
 * The ignore entry is written to the local `.git/info/exclude` (NOT the tracked
 * `.gitignore`): `info/exclude` is not versioned, so it never dirties the worktree.
 * Modifying `.gitignore` here previously made every OpenCode worktree report as
 * dirty, which blocked cleanup/removal of OpenCode agent runs (FLO-36).
 */
export function writeAgentsMd(worktreePath: string, content: string): void {
  const agentsMdPath = path.join(worktreePath, 'AGENTS.md')
  fs.writeFileSync(agentsMdPath, content, 'utf8')
  ensureIgnored(worktreePath, 'AGENTS.md')
}

/**
 * Resolve the path to a working tree's `.git/info/exclude`. Uses
 * `git rev-parse --git-path` so it's correct for both a plain checkout and a
 * linked worktree (where the exclude file lives in the shared common dir).
 * Returns null when the path can't be determined (not a git tree, git missing).
 */
export function resolveInfoExclude(worktreePath: string): string | null {
  try {
    const out = execFileSync(
      'git',
      ['-C', worktreePath, 'rev-parse', '--git-path', 'info/exclude'],
      { encoding: 'utf8' },
    ).trim()
    // git may return a path relative to the worktree cwd; absolutize either way.
    return path.isAbsolute(out) ? out : path.resolve(worktreePath, out)
  } catch {
    return null
  }
}

/**
 * Ensure `pattern` is listed in the local `.git/info/exclude`. Best-effort: any
 * git/fs error is swallowed so a failure to ignore never breaks agent launch.
 */
function ensureIgnored(worktreePath: string, pattern: string): void {
  try {
    const excludePath = resolveInfoExclude(worktreePath)
    if (!excludePath) return
    const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : ''
    const lines = existing.split('\n').map((l) => l.trim())
    if (lines.includes(pattern)) return
    fs.mkdirSync(path.dirname(excludePath), { recursive: true })
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
    fs.appendFileSync(excludePath, `${prefix}${pattern}\n`, 'utf8')
  } catch {
    // best-effort
  }
}

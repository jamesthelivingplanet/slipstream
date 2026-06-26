import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Write AGENTS.md to the worktree root so OpenCode auto-discovers it as system prompt.
 * Also ensures AGENTS.md is in .gitignore to prevent accidental commits.
 */
export function writeAgentsMd(worktreePath: string, content: string): void {
  const agentsMdPath = path.join(worktreePath, 'AGENTS.md')
  fs.writeFileSync(agentsMdPath, content, 'utf8')
  ensureGitignore(worktreePath)
}

/**
 * Ensure AGENTS.md is listed in .gitignore. If .gitignore doesn't exist,
 * create it. If it exists but doesn't contain AGENTS.md, append it.
 */
function ensureGitignore(worktreePath: string): void {
  const gitignorePath = path.join(worktreePath, '.gitignore')
  const line = 'AGENTS.md'
  try {
    if (fs.existsSync(gitignorePath)) {
      const content = fs.readFileSync(gitignorePath, 'utf8')
      const lines = content.split('\n').map((l) => l.trim())
      if (!lines.includes(line)) {
        fs.appendFileSync(gitignorePath, '\n' + line + '\n', 'utf8')
      }
    } else {
      fs.writeFileSync(gitignorePath, line + '\n', 'utf8')
    }
  } catch {
    // best-effort
  }
}

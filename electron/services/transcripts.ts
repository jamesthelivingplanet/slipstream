import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Root dir where Claude Code stores per-project transcripts. */
export function claudeProjectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')
  return path.join(base, 'projects')
}

/**
 * True if a Claude Code transcript (<id>.jsonl) exists for this session id under
 * any project dir. Session ids are globally unique UUIDs, so we scan project
 * subdirs rather than reproduce Claude's cwd-path encoding.
 */
export function hasTranscript(id: string, projectsDir: string = claudeProjectsDir()): boolean {
  let subs: string[]
  try {
    subs = fs.readdirSync(projectsDir)
  } catch {
    return false
  }
  for (const sub of subs) {
    if (fs.existsSync(path.join(projectsDir, sub, `${id}.jsonl`))) return true
  }
  return false
}

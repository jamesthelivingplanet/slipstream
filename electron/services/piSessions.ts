import { readdir, readFile, stat } from 'node:fs/promises'
import { readdirSync, statSync } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type { SessionStatus } from '../shared/contract.js'
import { NEEDS_INPUT_MARKER, DONE_MARKER, IN_PROGRESS_MARKER } from '../shared/promptComposer.js'

/**
 * piSessions — discovers pi's on-disk session files and classifies a run's
 * status from assistant text, mirroring how opencodeSessions polls opencode's
 * embedded server. Pi (a full-screen TUI) writes sessions as JSONL under
 * ~/.pi/agent/sessions/--<cwd-encoded>--/, so status is read reliably from the
 * file instead of scraping the TUI's PTY redraws.
 *
 * See https://pi.dev/docs/latest/session-format
 */

/** pi session directory name for a working directory (pure, documented encoding). */
export function piSessionDirName(cwd: string): string {
  return `-${cwd.replace(/\//g, '-')}-`
}

/** Resolve pi's session storage root, honoring env overrides. */
export function piSessionsRoot(): string {
  const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR
  if (sessionDir) return sessionDir
  const base = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent')
  return path.join(base, 'sessions')
}

/** Full path to pi's per-cwd session directory. Pass `root` to override for tests. */
export function piSessionDirFor(cwd: string, root?: string): string {
  return path.join(root ?? piSessionsRoot(), piSessionDirName(cwd))
}

export interface PiFileMtime {
  file: string
  mtime: number
}

/** Pure: pick the newest file by mtime. */
export function selectNewestPiSessionFile(files: PiFileMtime[]): string | null {
  let best: PiFileMtime | null = null
  for (const f of files) {
    if (!best || f.mtime > best.mtime) best = f
  }
  return best?.file ?? null
}

/**
 * Classify pi status from assistant text by honoring the most recently emitted
 * Slipstream marker (same semantics as the PTY StatusDetector / opencode
 * polling). Pure.
 */
export function piStatusFromText(text: string): SessionStatus {
  const candidates: [string, SessionStatus][] = [
    [DONE_MARKER, 'done'],
    [NEEDS_INPUT_MARKER, 'needs'],
    [IN_PROGRESS_MARKER, 'running'],
  ]
  let bestIdx = -1
  let bestStatus: SessionStatus = 'running'
  for (const [marker, status] of candidates) {
    const idx = text.lastIndexOf(marker)
    if (idx !== -1 && idx > bestIdx) {
      bestIdx = idx
      bestStatus = status
    }
  }
  return bestStatus
}

/** True if a parsed JSONL line looks like a pi message entry carrying a message. */
function isPiMessageEntry(
  entry: unknown,
): entry is { message: { role?: string; content?: unknown } } {
  return typeof entry === 'object' && entry !== null && 'message' in entry
}

/**
 * Pure: classify pi status from the raw JSONL session file content. Concatenates
 * assistant text blocks (in file order) and applies marker-based classification.
 * Non-message lines, malformed JSON, and non-text content blocks are skipped.
 */
export function piStatusFromFileContent(content: string): SessionStatus {
  let text = ''
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: unknown
    try {
      entry = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!isPiMessageEntry(entry)) continue
    const msg = entry.message
    if (msg?.role !== 'assistant') continue
    const blocks = Array.isArray(msg.content) ? msg.content : []
    for (const b of blocks) {
      if (
        b &&
        typeof b === 'object' &&
        (b as { type?: string }).type === 'text' &&
        typeof (b as { text?: string }).text === 'string'
      ) {
        text += '\n' + (b as { text: string }).text
      }
    }
  }
  return piStatusFromText(text)
}

/** List .jsonl files (with mtimes) in a pi session directory. Returns [] on error. */
export async function listPiSessionFiles(sessionDir: string): Promise<PiFileMtime[]> {
  try {
    const entries = await readdir(sessionDir)
    const out: PiFileMtime[] = []
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue
      const file = path.join(sessionDir, name)
      try {
        const st = await stat(file)
        out.push({ file, mtime: st.mtimeMs })
      } catch {
        /* skip unreadable */
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * One-shot: the newest `.jsonl` session file in `sessionDir` right now, or
 * null if the dir doesn't exist / has none yet. Used both by
 * capturePiSessionFile's retry loop and by the poll-fallback's lazy,
 * per-tick discovery (agentBackend.ts) — no built-in retry of its own.
 */
export async function findNewestPiSessionFile(sessionDir: string): Promise<string | null> {
  const files = await listPiSessionFiles(sessionDir)
  return selectNewestPiSessionFile(files)
}

/**
 * Poll `sessionDir` until a .jsonl session file appears, then return the newest
 * one by mtime. Used at spawn (waits for pi to create its session file) and at
 * resume (the file already exists, so the first attempt resolves immediately).
 */
export async function capturePiSessionFile(
  sessionDir: string,
  opts: { attempts?: number; intervalMs?: number } = {},
): Promise<string | null> {
  const attempts = opts.attempts ?? 30
  const intervalMs = opts.intervalMs ?? 500
  for (let i = 0; i < attempts; i++) {
    const newest = await findNewestPiSessionFile(sessionDir)
    if (newest) return newest
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return null
}

/**
 * Sync, best-effort check: does `piSessionDirFor(cwd)` contain at least one
 * `.jsonl` session file? Used by piBackend.hasPriorSession (AgentBackend is a
 * sync interface) to decide whether a resume/remote-control has real prior
 * state to continue, vs. falling back to a fresh start. Any error (dir
 * missing, unreadable) is treated as "no prior session".
 */
export function hasPiSessionFileSync(cwd: string, root?: string): boolean {
  try {
    const dir = piSessionDirFor(cwd, root)
    return readdirSync(dir).some((name) => name.endsWith('.jsonl'))
  } catch {
    return false
  }
}

/**
 * Sync variant of findNewestPiSessionFile, used by the chat tail's
 * `resolveFile` hook (chatTail.ts's startChatTail expects a synchronous
 * resolver, matching transcriptPathFor's contract for the claude-code tail).
 * Any error (dir missing, unreadable entries) resolves to null/skips, same
 * leniency as hasPiSessionFileSync.
 */
export function findNewestPiSessionFileSync(sessionDir: string): string | null {
  let entries: string[]
  try {
    entries = readdirSync(sessionDir)
  } catch {
    return null
  }
  const files: PiFileMtime[] = []
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue
    const file = path.join(sessionDir, name)
    try {
      const st = statSync(file)
      files.push({ file, mtime: st.mtimeMs })
    } catch {
      /* skip unreadable */
    }
  }
  return selectNewestPiSessionFile(files)
}

/** Read a pi session JSONL file. Returns '' on any error (missing, unreadable). */
export async function readPiSessionFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8')
  } catch {
    return ''
  }
}

/**
 * piUsage — parses pi's on-disk JSONL session files into the same
 * SessionUsage shape usage.ts produces for Claude Code transcripts (FLO-94
 * parity gap: opencode/pi sessions always showed usage:null).
 *
 * A slipstream session's worktree cwd maps to one pi session directory
 * (piSessionDirFor); each pi launch (start/resume/remote-control) appends a
 * new `.jsonl` file there, so summing every file in the dir gives the run's
 * total usage.
 *
 * Pure and node-runnable: root is overridable so this is unit-testable with
 * temp dirs and fixture files.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { SessionUsage, UsageTokens } from '../shared/contract.js'
import { round4 } from './usage.js'
import { piSessionDirFor } from './piSessions.js'

const ZERO_TOKENS: UsageTokens = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }

function emptyUsage(sessionId: string): SessionUsage {
  return { sessionId, exists: false, tokens: { ...ZERO_TOKENS }, costUsd: 0, turns: 0 }
}

interface RawPiUsage {
  input?: unknown
  output?: unknown
  reasoning?: unknown
  cacheWrite?: unknown
  cacheRead?: unknown
  cost?: { total?: unknown }
}

interface RawPiMessage {
  role?: unknown
  usage?: RawPiUsage
  model?: unknown
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * Parse every `.jsonl` file in a session's pi session directory into a
 * token + cost rollup. Returns `exists: false` with zeroed tokens when cwd is
 * null, the dir is missing, or it has zero `.jsonl` files. Tolerates
 * partial/garbage lines and files exactly like readTranscriptUsage.
 */
export async function readPiUsage(
  sessionId: string,
  cwd: string | null,
  root?: string,
): Promise<SessionUsage> {
  if (!cwd) return emptyUsage(sessionId)

  const dir = piSessionDirFor(cwd, root)
  let files: string[]
  try {
    files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return emptyUsage(sessionId)
  }
  if (files.length === 0) return emptyUsage(sessionId)

  let tokens = { ...ZERO_TOKENS }
  let cost = 0
  let turns = 0
  let model: string | undefined

  for (const file of files) {
    let text: string
    try {
      text = await fs.promises.readFile(path.join(dir, file), 'utf8')
    } catch {
      continue
    }

    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let entry: unknown
      try {
        entry = JSON.parse(trimmed)
      } catch {
        continue // tolerate partial/garbage lines
      }
      if (typeof entry !== 'object' || entry === null) continue
      const e = entry as { message?: RawPiMessage }
      const msg = e.message
      if (!msg || typeof msg !== 'object') continue
      if (msg.role !== 'assistant') continue
      if (!msg.usage || typeof msg.usage !== 'object') continue

      const u = msg.usage
      tokens = {
        input: tokens.input + n(u.input),
        output: tokens.output + n(u.output) + n(u.reasoning),
        cacheCreation: tokens.cacheCreation + n(u.cacheWrite),
        cacheRead: tokens.cacheRead + n(u.cacheRead),
      }
      cost += n(u.cost?.total)
      turns++
      if (typeof msg.model === 'string' && msg.model) model = msg.model
    }
  }

  return {
    sessionId,
    exists: true,
    tokens,
    costUsd: round4(cost),
    turns,
    model,
  }
}

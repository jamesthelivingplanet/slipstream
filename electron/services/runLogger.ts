/**
 * RunLogger — append-only per-session logs + a rolling process-level log.
 *
 * Two artefacts under `<root>/logs/`:
 *   - `<sessionId>.log`   one file per agent run: spawn args, exit code, tail.
 *   - `server.log`        process-level lifecycle / uncaught errors.
 *
 * Design notes:
 *   - Synchronous writes (fs.appendFileSync): agent runs are low-frequency,
 *     short-lived, and the data volume is small (spawn + exit lines + a tail
 *     snippet). Avoiding stream lifecycle complexity is worth more than async
 *     throughput here. Server.log uses async appendFile to never block the
 *     event loop on a hot path.
 *   - The OutputBuffer already retains recent PTY output in memory; on exit we
 *     snapshot the last TAIL_CHARS of it into the per-session log so a forensic
 *     tail is available without streaming the whole session.
 *   - No PII redaction beyond the prompt: prompts are user-authored text, not
 *     secrets, but we keep them out of the spawn line (which looks like a CLI
 *     invocation) and log them on a separate tagged line.
 */

import fs from 'node:fs'
import path from 'node:path'

const TAIL_CHARS = 2048

export interface RunLogger {
  /** Record a session spawn (start or resume). */
  spawn(sessionId: string, info: SpawnInfo): void
  /** Record a session exit. */
  exit(sessionId: string, info: ExitInfo): void
  /** Record a process-level event (startup, uncaught error, etc.). */
  server(level: 'info' | 'warn' | 'error', msg: string, extra?: unknown): void
}

export interface SpawnInfo {
  agentKind: string
  cmd: string
  args: string[]
  cwd: string
  tid?: string
  title?: string
  prompt?: string
}

export interface ExitInfo {
  exitCode: number
  signal?: string
  status: string
  tail: string
}

/**
 * Create a RunLogger that writes into `<root>/logs/`.
 * `root` is the Slipstream data dir (e.g. ~/.config/slipstream).
 */
export function createRunLogger(root: string): RunLogger {
  const logDir = path.join(root, 'logs')
  // mkdir at creation so the dir always exists before the first write.
  fs.mkdirSync(logDir, { recursive: true })
  const serverLogPath = path.join(logDir, 'server.log')

  function ts(): string {
    return new Date().toISOString()
  }

  function sessionLogPath(sessionId: string): string {
    // sessionId is a uuid; safe as a filename component
    return path.join(logDir, `${sessionId}.log`)
  }

  function spawn(sessionId: string, info: SpawnInfo): void {
    const lines = [
      `=== ${ts()} SPAWN session=${sessionId} ===`,
      `  agentKind: ${info.agentKind}`,
      `  cmd: ${info.cmd} ${info.args.join(' ').replace(/\n/g, '\\n')}`,
      `  cwd: ${info.cwd}`,
    ]
    if (info.tid) lines.push(`  tid: ${info.tid}`)
    if (info.title) lines.push(`  title: ${info.title}`)
    if (info.prompt) {
      const p = info.prompt.length > 500 ? info.prompt.slice(0, 500) + '…[truncated]' : info.prompt
      lines.push(`  prompt: ${p.replace(/\n/g, '\\n')}`)
    }
    lines.push('')
    try {
      fs.appendFileSync(sessionLogPath(sessionId), lines.join('\n') + '\n')
    } catch {
      // best-effort: never let logging crash an agent spawn
    }
  }

  function exit(sessionId: string, info: ExitInfo): void {
    const lines = [
      `=== ${ts()} EXIT session=${sessionId} code=${info.exitCode} signal=${info.signal ?? 'null'} status=${info.status} ===`,
      `  --- tail (${Math.min(info.tail.length, TAIL_CHARS)} chars) ---`,
      info.tail.slice(-TAIL_CHARS),
      `  --- end tail ---`,
      '',
    ]
    try {
      fs.appendFileSync(sessionLogPath(sessionId), lines.join('\n') + '\n')
    } catch {
      // best-effort
    }
  }

  function server(level: 'info' | 'warn' | 'error', msg: string, extra?: unknown): void {
    const extraStr = extra !== undefined ? ' ' + safeStringify(extra) : ''
    const line = `${ts()} [${level}] ${msg}${extraStr}\n`
    try {
      fs.appendFile(serverLogPath, line, () => {
        /* fire-and-forget */
      })
    } catch {
      // best-effort
    }
  }

  return { spawn, exit, server }
}

function safeStringify(v: unknown): string {
  try {
    if (v instanceof Error)
      return JSON.stringify({ name: v.name, message: v.message, stack: v.stack })
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { spawn } from 'node:child_process'

/**
 * Out-of-band health check for the app's own MCP server (electron/mcp/appMcp.ts).
 *
 * This spawns the same binary an agent session would, but does the
 * initialize/tools-list handshake itself — no agent, no prompt text, no new
 * MCP tool. It never calls tools/call, so no sentinel files are written; it
 * only proves the binary launches, loads its DB, and speaks the protocol.
 */

/** Builds the two JSON-RPC request lines (initialize, tools/list) used for the
 *  self-test handshake. Pure — no I/O. */
export function buildHealthRequests(): string[] {
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'slipstream-healthcheck', version: '1.0.0' },
    },
  }
  const toolsList = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  }
  return [JSON.stringify(initialize), JSON.stringify(toolsList)]
}

export interface InterpretedResponses {
  serverName?: string
  protocolVersion?: string
  tools: string[]
}

/** Parses collected stdout lines from the MCP subprocess into the fields we
 *  care about. Tolerates unparseable/notification lines. Pure — no I/O. */
export function interpretResponses(lines: string[]): InterpretedResponses {
  const result: InterpretedResponses = { tools: [] }

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let msg: unknown
    try {
      msg = JSON.parse(trimmed)
    } catch {
      continue
    }

    if (typeof msg !== 'object' || msg === null) continue
    const m = msg as Record<string, unknown>
    if (!('id' in m) || !('result' in m)) continue

    if (m['id'] === 1) {
      const res = m['result'] as Record<string, unknown> | undefined
      if (res && typeof res === 'object') {
        const serverInfo = res['serverInfo'] as Record<string, unknown> | undefined
        if (serverInfo && typeof serverInfo['name'] === 'string') {
          result.serverName = serverInfo['name'] as string
        }
        if (typeof res['protocolVersion'] === 'string') {
          result.protocolVersion = res['protocolVersion'] as string
        }
      }
    } else if (m['id'] === 2) {
      const res = m['result'] as Record<string, unknown> | undefined
      if (res && Array.isArray(res['tools'])) {
        result.tools = (res['tools'] as Array<Record<string, unknown>>)
          .map((t) => t['name'])
          .filter((n): n is string => typeof n === 'string')
      }
    }
  }

  return result
}

export interface McpHealthParams {
  electronPath: string
  appMcpJsPath: string
  dataDir: string
  timeoutMs?: number
}

export interface McpHealthResult {
  up: boolean
  serverName?: string
  protocolVersion?: string
  tools: string[]
  error?: string
}

/** Spawns the app's own MCP server out-of-band, runs the initialize/tools-list
 *  handshake, and resolves with the result. Never throws. Always cleans up
 *  the child process and any pending timers before resolving. */
export async function checkAppMcp(p: McpHealthParams): Promise<McpHealthResult> {
  const timeoutMs = p.timeoutMs ?? 4000

  return new Promise<McpHealthResult>((resolve) => {
    let settled = false
    const lines: string[] = []
    let gotInit = false
    let gotTools = false
    let timer: NodeJS.Timeout | null = null
    let rl: readline.Interface | null = null

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(p.electronPath, [p.appMcpJsPath], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          SLIPSTREAM_DATA_DIR: p.dataDir,
          SLIPSTREAM_SESSION_ID: '__healthcheck__',
          SLIPSTREAM_BASE: 'main',
          SLIPSTREAM_BRANCH: '__healthcheck__',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve({ up: false, tools: [], error: `spawn failed: ${(err as Error).message}` })
      return
    }

    function cleanup(): void {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (rl) {
        rl.removeAllListeners()
        rl.close()
        rl = null
      }
      child.removeAllListeners()
      if (!child.killed) {
        try {
          child.kill()
        } catch {
          // best effort
        }
      }
    }

    function finish(result: McpHealthResult): void {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }

    timer = setTimeout(() => {
      finish({ up: false, tools: [], error: 'timed out waiting for MCP handshake' })
    }, timeoutMs)

    child.on('error', (err) => {
      finish({ up: false, tools: [], error: `spawn error: ${err.message}` })
    })

    child.on('exit', (code, signal) => {
      if (!gotInit || !gotTools) {
        finish({ up: false, tools: [], error: `process exited before handshake completed (code=${code}, signal=${signal})` })
      }
    })

    if (child.stdout) {
      rl = readline.createInterface({ input: child.stdout, terminal: false })
      rl.on('line', (line) => {
        lines.push(line)

        try {
          const msg = JSON.parse(line.trim()) as Record<string, unknown>
          if (msg && 'id' in msg && 'result' in msg) {
            if (msg['id'] === 1) gotInit = true
            if (msg['id'] === 2) gotTools = true
          }
        } catch {
          // ignore unparseable lines
        }

        if (gotInit && gotTools) {
          finish({ up: true, ...interpretResponses(lines) })
        }
      })
    }

    if (child.stdin) {
      for (const req of buildHealthRequests()) {
        child.stdin.write(req + '\n')
      }
    }
  })
}

/** Best-effort scan of `<dataDir>/sessions/*\/{status.json,pr.json}` for the
 *  most recent mtime, as a signal of real (non-healthcheck) MCP activity.
 *  Never throws; resolves undefined if there's nothing to find or on error. */
export async function lastMcpActivity(dataDir: string): Promise<number | undefined> {
  try {
    const sessionsDir = path.join(dataDir, 'sessions')
    const entries = await fs.promises.readdir(sessionsDir, { withFileTypes: true })
    let max: number | undefined

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      for (const file of ['status.json', 'pr.json']) {
        try {
          const stat = await fs.promises.stat(path.join(sessionsDir, entry.name, file))
          if (max === undefined || stat.mtimeMs > max) max = stat.mtimeMs
        } catch {
          // file may not exist for this session; ignore
        }
      }
    }

    return max
  } catch {
    return undefined
  }
}

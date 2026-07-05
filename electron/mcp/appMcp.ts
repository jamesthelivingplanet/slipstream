import * as readline from 'node:readline'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFile as _execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitHost } from '../shared/contract.js'
import { parseRemote, createGitDriver } from '../services/gitDriver.js'

const execFile = promisify(_execFile)

export interface AppMcpDeps {
  cwd: string
  dataDir: string
  sessionId: string
  base: string
  branch: string
  getToken(host: GitHost): string | null
  push(branch: string, token?: string, remoteUrl?: string): Promise<void>
  openMergeRequest(input: {
    remoteUrl: string
    branch: string
    base: string
    title: string
    body: string
    token: string
  }): Promise<{ url: string; isNew: boolean }>
  getRemoteUrl(cwd: string): Promise<string>
  writeSentinel(url: string): Promise<void>
  writeStatus(state: 'running' | 'needs' | 'done', message?: string): Promise<void>
}

/** A single text content item in a tools/call result. */
export interface McpTextContent {
  type: string
  text: string
}

/** Payload returned by a tools/call: text content, optionally flagged as a tool error. */
export interface McpToolResult {
  content: McpTextContent[]
  isError?: boolean
}

/** Description of an MCP tool exposed via tools/list. */
export interface McpTool {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required: string[]
  }
}

/** JSON-RPC 2.0 response envelope. A success carries `result`; a failure carries `error`. */
export interface JsonRpcResponse<TResult = unknown> {
  jsonrpc: '2.0'
  id: unknown
  result?: TResult
  error?: { code: number; message: string }
}

const TOOLS: McpTool[] = [
  {
    name: 'open_merge_request',
    description: 'Open a merge/pull request on the remote host',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'PR/MR title' },
        description: { type: 'string', description: 'Optional description' },
      },
      required: ['title'],
    },
  },
  {
    name: 'report_status',
    description:
      'Report your current working state to the Slipstream app so it shows the correct status. Call with state "needs" when you are blocked waiting on the user, "done" when the ticket is fully complete, or "running" when actively working. This is the reliable status channel — prefer it over relying on printed terminal markers.',
    inputSchema: {
      type: 'object',
      properties: {
        state: {
          type: 'string',
          enum: ['running', 'needs', 'done'],
          description: 'Current working state',
        },
        message: { type: 'string', description: 'Optional short human-readable note' },
      },
      required: ['state'],
    },
  },
]

function makeResponse<TResult>(id: unknown, result: TResult): JsonRpcResponse<TResult> {
  return { jsonrpc: '2.0', id, result }
}

function makeError(id: unknown, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function makeToolError(text: string): McpToolResult {
  return { isError: true, content: [{ type: 'text', text }] }
}

function makeToolSuccess(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] }
}

export async function handleRpc(msg: unknown, deps: AppMcpDeps): Promise<JsonRpcResponse | null> {
  const m = msg as Record<string, unknown>

  // Notifications have no id
  if (!('id' in m)) return null

  const id = m['id']
  const method = m['method'] as string
  const params = (m['params'] ?? {}) as Record<string, unknown>

  switch (method) {
    case 'initialize':
      return makeResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'slipstream', version: '1.0.0' },
      })

    case 'notifications/initialized':
      return null

    case 'ping':
      return makeResponse(id, {})

    case 'tools/list':
      return makeResponse(id, { tools: TOOLS })

    case 'tools/call': {
      const toolName = params['name'] as string
      const args = (params['arguments'] ?? {}) as Record<string, unknown>

      try {
        if (toolName === 'open_merge_request') {
          const title = args['title'] as string
          const description = (args['description'] as string | undefined) ?? ''
          const branch = deps.branch
          const remoteUrl = await deps.getRemoteUrl(deps.cwd)
          const parsed = parseRemote(remoteUrl)
          if (!parsed) {
            return makeResponse(id, makeToolError(`Cannot parse remote URL: ${remoteUrl}`))
          }
          const token = deps.getToken(parsed.host)
          if (!token) {
            return makeResponse(
              id,
              makeToolError('No git token found. Set it in Settings → Integrations.'),
            )
          }
          // Best-effort push — the agent should already have pushed via its own
          // shell; ignore failures here (e.g. branch already pushed) and continue.
          try {
            await deps.push(branch, token, remoteUrl)
          } catch {
            /* best-effort; branch may already be pushed */
          }
          // Open MR/PR
          const result = await deps.openMergeRequest({
            remoteUrl,
            branch,
            base: deps.base,
            title,
            body: description,
            token,
          })
          await deps.writeSentinel(result.url)
          const action = result.isNew ? 'Opened' : 'Found existing'
          return makeResponse(id, makeToolSuccess(`${action} merge/pull request: ${result.url}`))
        }

        if (toolName === 'report_status') {
          const state = args['state'] as string
          const message = args['message'] as string | undefined
          if (state !== 'running' && state !== 'needs' && state !== 'done') {
            return makeResponse(id, makeToolError(`Invalid state: ${state}`))
          }
          await deps.writeStatus(state, message)
          return makeResponse(id, makeToolSuccess(`Status reported: ${state}`))
        }

        return makeError(id, -32601, `Unknown tool: ${toolName}`)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return makeResponse(id, makeToolError(message))
      }
    }

    default:
      return makeError(id, -32601, 'Method not found')
  }
}

export async function main(): Promise<void> {
  const dataDir = process.env.SLIPSTREAM_DATA_DIR ?? ''
  const sessionId = process.env.SLIPSTREAM_SESSION_ID ?? ''
  const base = process.env.SLIPSTREAM_BASE ?? 'main'
  const cwd = process.cwd()

  let branch = process.env.SLIPSTREAM_BRANCH ?? ''
  if (!branch) {
    try {
      const { stdout } = await execFile('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'])
      branch = stdout.trim()
    } catch {
      branch = ''
    }
  }

  // Dynamically import to avoid issues at module load time
  const { openDb } = await import('../db/db.js')
  const { createConfigStore, createSafeStorageEncryptor } =
    await import('../services/configStore.js')

  const dbPath = path.join(dataDir, 'slipstream.db')
  const db = openDb(dbPath)
  const configStore = createConfigStore(db, { encryptor: createSafeStorageEncryptor() })

  const driver = createGitDriver()

  const deps: AppMcpDeps = {
    cwd,
    dataDir,
    sessionId,
    base,
    branch,
    getToken(host: GitHost): string | null {
      return configStore.get(`${host}.token`) ?? null
    },
    async push(br: string, token?: string, remoteUrl?: string): Promise<void> {
      await driver.push(cwd, br, { token, remoteUrl })
    },
    async openMergeRequest(input) {
      return driver.openMergeRequest(input)
    },
    async getRemoteUrl(dir: string): Promise<string> {
      const { stdout } = await execFile('git', ['-C', dir, 'remote', 'get-url', 'origin'])
      return stdout.trim()
    },
    async writeSentinel(url: string): Promise<void> {
      const sentinelDir = path.join(dataDir, 'sessions', sessionId)
      await fs.promises.mkdir(sentinelDir, { recursive: true })
      await fs.promises.writeFile(path.join(sentinelDir, 'pr.json'), JSON.stringify({ url }))
    },
    async writeStatus(state: 'running' | 'needs' | 'done', message?: string): Promise<void> {
      if (!sessionId) return
      const sentinelDir = path.join(dataDir, 'sessions', sessionId)
      await fs.promises.mkdir(sentinelDir, { recursive: true })
      await fs.promises.writeFile(
        path.join(sentinelDir, 'status.json'),
        JSON.stringify({ state, message, ts: Date.now() }),
      )
    },
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  })

  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return

    let msg: unknown
    try {
      msg = JSON.parse(trimmed)
    } catch (err) {
      process.stderr.write(`[appMcp] Failed to parse JSON: ${err}\n`)
      return
    }

    void handleRpc(msg, deps)
      .then((response) => {
        if (response !== null) {
          process.stdout.write(JSON.stringify(response) + '\n')
        }
      })
      .catch((err) => {
        process.stderr.write(`[appMcp] Error handling RPC: ${err}\n`)
      })
  })

  rl.on('close', () => {
    process.exit(0)
  })
}

// Only auto-start when run as a script (not imported as a module)
if (import.meta.url === `file://${process.argv[1]}`) {
  void main()
}

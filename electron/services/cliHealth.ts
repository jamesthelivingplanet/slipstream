import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawn } from 'node:child_process'

/**
 * Out-of-band health check for the agent-facing `slipstream` CLI
 * (electron/cli/slipstream.ts). Spawns the same bundled entry an agent
 * session would (via Electron-as-Node), runs `help`, and asserts a clean
 * exit with usage text — no agent, no prompt text, no sentinel writes
 * (`help` never touches the session dir).
 */

export interface CliHealthParams {
  electronPath: string
  cliJsPath: string
  dataDir: string
  timeoutMs?: number
}

export interface CliHealthResult {
  up: boolean
  commands: string[]
  error?: string
}

/** Parse command names out of the CLI's usage text: indented lines whose
 *  first token is a lowercase command word. Pure — no I/O. */
export function parseUsageCommands(usage: string): string[] {
  const commands: string[] = []
  for (const line of usage.split('\n')) {
    const m = /^ {2}([a-z][a-z-]*)/.exec(line)
    if (m && !commands.includes(m[1])) commands.push(m[1])
  }
  return commands
}

/** Spawns the CLI out-of-band with `help` and resolves with the result.
 *  Never throws. Always cleans up the child process and any pending timer. */
export async function checkSlipstreamCli(p: CliHealthParams): Promise<CliHealthResult> {
  const timeoutMs = p.timeoutMs ?? 4000

  return new Promise<CliHealthResult>((resolve) => {
    let settled = false
    let stdout = ''
    let timer: NodeJS.Timeout | null = null

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(p.electronPath, [p.cliJsPath, 'help'], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          SLIPSTREAM_DATA_DIR: p.dataDir,
          SLIPSTREAM_SESSION_ID: '__healthcheck__',
          SLIPSTREAM_BASE: 'main',
          SLIPSTREAM_BRANCH: '__healthcheck__',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve({ up: false, commands: [], error: `spawn failed: ${(err as Error).message}` })
      return
    }

    function finish(result: CliHealthResult): void {
      if (settled) return
      settled = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      child.removeAllListeners()
      if (!child.killed) {
        try {
          child.kill()
        } catch {
          // best effort
        }
      }
      resolve(result)
    }

    timer = setTimeout(() => {
      finish({ up: false, commands: [], error: 'timed out waiting for CLI help output' })
    }, timeoutMs)

    child.on('error', (err) => {
      finish({ up: false, commands: [], error: `spawn error: ${err.message}` })
    })

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    child.on('exit', (code, signal) => {
      if (code === 0 && stdout.includes('Usage: slipstream')) {
        finish({ up: true, commands: parseUsageCommands(stdout) })
      } else {
        finish({
          up: false,
          commands: [],
          error: `CLI self-test failed (code=${code}, signal=${signal})`,
        })
      }
    })
  })
}

/** Best-effort scan of the per-session sentinel files for the most recent
 *  mtime, as a signal of real (non-healthcheck) CLI activity. Never throws;
 *  resolves undefined if there's nothing to find or on error. */
export async function lastCliActivity(dataDir: string): Promise<number | undefined> {
  try {
    const sessionsDir = path.join(dataDir, 'sessions')
    const entries = await fs.promises.readdir(sessionsDir, { withFileTypes: true })
    let max: number | undefined

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      for (const file of ['status.json', 'pr.json', 'outcome.json', 'events.ndjson']) {
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

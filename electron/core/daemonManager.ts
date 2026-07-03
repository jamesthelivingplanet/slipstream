/**
 * daemonManager.ts — spawn / reuse the local Slipstream daemon.
 *
 * Node builtins only (no electron, no native modules) so unit tests run in
 * plain node.
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as http from 'node:http'
import * as https from 'node:https'
import * as net from 'node:net'
import { randomBytes } from 'node:crypto'

export interface DaemonConfig {
  mode: 'local' | 'remote'
  wsUrl: string // ws(s)://host:port/rpc — passed to renderer
  httpBase: string // http(s)://host:port   — for healthz polling
  token: string
  port?: number // local only
}

export interface LocalIdentity {
  token: string
  port: number
}

// ── pickPort ──────────────────────────────────────────────────────────────────

/**
 * Picks a port for the local daemon to bind.
 *
 * IMPORTANT — this cannot be made truly race-free: `pickPort` only *checks*
 * that a port is bindable (by binding it ourselves and immediately closing
 * it) — it does not, and cannot, hold the port. The daemon process that
 * actually binds the port is spawned separately, after this function
 * resolves. That gap between "we verified it's free" and "the daemon binds
 * it for real" is an inherent TOCTOU (time-of-check to time-of-use) race:
 * some other process on the machine could grab the port in between. There is
 * no cross-process atomic "reserve a port" primitive on POSIX/Windows — the
 * OS only lets a single process hold a bind at a time, so any check-then-use
 * scheme has this gap by construction.
 *
 * Mitigations (this is a "make it rare", not a "make it impossible"):
 *  - Prefer a fixed, well-known port (`preferred`) first, since on a typical
 *    dev machine nothing else contends for it 99% of the time.
 *  - When `preferred` is busy (or racily taken), fall back to an OS-assigned
 *    ephemeral port (`port: 0`), which the OS guarantees was free at bind
 *    time and picks from a range unlikely to collide with another such probe
 *    landing on the exact same number a moment later.
 *  - Retry the ephemeral-port probe up to `attempts` times: if two callers
 *    happen to race on the *same* ephemeral port (astronomically unlikely,
 *    but the retry is cheap insurance), we just ask the OS for another one.
 *  - The daemon itself must still handle EADDRINUSE when it actually binds
 *    (belt-and-braces) — this function only narrows the race window, it
 *    doesn't close it.
 */
export function pickPort(preferred = 7421, attempts = 3): Promise<number> {
  function probe(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer()
      server.once('error', reject)
      server.listen({ host: '127.0.0.1', port }, () => {
        const addr = server.address() as net.AddressInfo
        server.close(() => resolve(addr.port))
      })
    })
  }

  return probe(preferred).catch(async () => {
    // preferred is busy — fall back to an OS-assigned ephemeral port,
    // retrying a couple of times in case of a rare race.
    let lastErr: unknown
    for (let i = 0; i < attempts; i++) {
      try {
        return await probe(0)
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr
  })
}

// ── loadOrCreateLocalIdentity ─────────────────────────────────────────────────

export interface IdentityDeps {
  readFile?(p: string): string | null
  writeFile?(p: string, data: string): void
  mkdir?(p: string): void
  pickPort?(preferred: number): Promise<number>
}

export async function loadOrCreateLocalIdentity(
  dataDir: string,
  env: Record<string, string | undefined>,
  deps?: IdentityDeps,
): Promise<LocalIdentity> {
  const readFile =
    deps?.readFile ??
    ((p: string) => {
      try {
        return fs.readFileSync(p, 'utf8')
      } catch {
        return null
      }
    })
  const writeFile =
    deps?.writeFile ??
    ((p: string, data: string) => {
      fs.writeFileSync(p, data, 'utf8')
    })
  const mkdir =
    deps?.mkdir ??
    ((p: string) => {
      fs.mkdirSync(p, { recursive: true })
    })
  const pick = deps?.pickPort ?? pickPort

  const daemonFile = path.join(dataDir, 'daemon.json')
  const existing = readFile(daemonFile)
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as unknown
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        typeof (parsed as Record<string, unknown>).token === 'string' &&
        typeof (parsed as Record<string, unknown>).port === 'number'
      ) {
        return parsed as LocalIdentity
      }
    } catch {
      // fall through to create
    }
  }

  const token = env.SLIPSTREAM_TOKEN ?? randomBytes(32).toString('hex')
  const port = env.SLIPSTREAM_PORT ? Number(env.SLIPSTREAM_PORT) : await pick(7421)
  const identity: LocalIdentity = { token, port }

  mkdir(dataDir)
  writeFile(daemonFile, JSON.stringify(identity, null, 2))
  return identity
}

// ── resolveDaemonConfig ───────────────────────────────────────────────────────

export interface ResolveDaemonConfigOpts {
  env: Record<string, string | undefined>
  dataDir: string
  loadIdentity?: (
    dataDir: string,
    env: Record<string, string | undefined>,
  ) => Promise<LocalIdentity>
}

export async function resolveDaemonConfig(opts: ResolveDaemonConfigOpts): Promise<DaemonConfig> {
  const { env, dataDir } = opts
  const loadIdentity = opts.loadIdentity ?? loadOrCreateLocalIdentity

  if (env.SLIPSTREAM_DAEMON_URL) {
    const base = env.SLIPSTREAM_DAEMON_URL.replace(/\/$/, '')
    const token = env.SLIPSTREAM_TOKEN
    if (!token) {
      throw new Error(
        'SLIPSTREAM_TOKEN is required when SLIPSTREAM_DAEMON_URL is set (remote mode)',
      )
    }
    // Derive wsUrl: replace http(s) scheme with ws(s)
    const wsUrl = base.replace(/^https?/, (s) => (s === 'https' ? 'wss' : 'ws')) + '/rpc'
    return { mode: 'remote', wsUrl, httpBase: base, token }
  }

  // local mode
  const id = await loadIdentity(dataDir, env)
  return {
    mode: 'local',
    wsUrl: `ws://127.0.0.1:${id.port}/rpc`,
    httpBase: `http://127.0.0.1:${id.port}`,
    token: id.token,
    port: id.port,
  }
}

// ── isHealthy ─────────────────────────────────────────────────────────────────

export function isHealthy(httpBase: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const url = `${httpBase}/healthz`
    const lib = url.startsWith('https') ? https : http
    let settled = false
    const done = (v: boolean) => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    try {
      const req = lib.get(url, { timeout: timeoutMs }, (res) => {
        done(res.statusCode === 200)
        res.resume()
      })
      req.on('error', () => done(false))
      req.on('timeout', () => {
        req.destroy()
        done(false)
      })
      setTimeout(() => done(false), timeoutMs + 100)
    } catch {
      done(false)
    }
  })
}

// ── ensureLocalDaemon ─────────────────────────────────────────────────────────

export interface DaemonHandle {
  child: ChildProcess | null
  reused: boolean
  kill(): void
}

export async function ensureLocalDaemon(
  cfg: DaemonConfig,
  opts: { serverEntry: string; dataDir: string; ephemeral: boolean },
): Promise<DaemonHandle> {
  if (await isHealthy(cfg.httpBase)) {
    return { child: null, reused: true, kill() {} }
  }

  const child = spawn(process.execPath, [opts.serverEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      SLIPSTREAM_TOKEN: cfg.token,
      SLIPSTREAM_PORT: String(cfg.port),
      SLIPSTREAM_BIND: '127.0.0.1',
      SLIPSTREAM_DATA_DIR: opts.dataDir,
    },
    detached: !opts.ephemeral,
    stdio: 'ignore',
  })

  if (!opts.ephemeral) child.unref()

  // Poll until healthy (up to ~15 s)
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150))
    if (await isHealthy(cfg.httpBase)) {
      return {
        child,
        reused: false,
        kill() {
          try {
            child.kill()
          } catch {
            /* already gone */
          }
        },
      }
    }
  }

  // If we get here, the daemon never came up — kill the child and reject
  try {
    child.kill()
  } catch {
    /* ignore */
  }
  throw new Error(`Local daemon at ${cfg.httpBase} did not become healthy within 15 s`)
}

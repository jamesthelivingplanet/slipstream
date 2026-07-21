import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import type { IpcDeps } from '../ipc.js'
import { createRpc } from '../core/rpc.js'
import type { WireReq, WireRes, WirePush, WirePing } from '../shared/wire.js'
import { resolveIdentity, LOCAL_IDENTITY } from '../core/auth.js'
import type { Identity } from '../shared/contract.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Interval for server-side ws-protocol pings that reap dead sockets whose
// close/error events never fired (e.g. a client that vanished without a
// clean TCP close).
const HEARTBEAT_INTERVAL_MS = 30_000

// Optional Origin allowlist for browser clients (defense-in-depth). Only
// browsers attach an `Origin` header to a WebSocket upgrade; header-capable
// clients (the desktop daemon's Bearer connection, e2e drivers) send none, so
// the check never applies to them. When no allowlist is configured the feature
// is off and every origin is accepted, preserving existing behavior.
function originAllowed(origin: string | undefined, allowlist: string[] | undefined): boolean {
  if (!allowlist || allowlist.length === 0) return true
  if (origin === undefined) return true
  return allowlist.includes(origin)
}

export interface ServerOptions {
  token: string
  bind?: string
  port?: number
  /** Optional Origin allowlist enforced only for browser clients that send an Origin header. */
  allowedOrigins?: string[]
}

/**
 * Create and start the HTTP + WebSocket server.
 * Services are passed in so the server is fully testable without native modules.
 * Returns the underlying http.Server (useful for obtaining the bound port in tests).
 */
export function createServer(deps: IpcDeps, opts: ServerOptions): http.Server {
  const { token, bind = '127.0.0.1', port = 7421, allowedOrigins } = opts

  // dist/ is the sibling of dist-electron/ (where this server.js runs from)
  const distDir = path.resolve(__dirname, '..', 'dist')

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

    // Health check
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    // Serve static files from dist/. The URL pathname is still percent-encoded;
    // decode it so assets with encoded characters resolve, then guard that the
    // resolved path cannot escape distDir (e.g. via encoded ../ segments).
    let pathname: string
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Bad request')
      return
    }

    let filePath = path.resolve(path.join(distDir, pathname))
    if (filePath !== distDir && !filePath.startsWith(distDir + path.sep)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not found')
      return
    }

    function serveFile(fp: string): void {
      fs.readFile(fp, (err, data) => {
        if (err) {
          // Only SPA-fallback for routes without a file extension.
          // A missing .js/.css means the browser has a stale index.html
          // referencing chunks from a previous build — serving HTML here
          // causes a MIME mismatch that silently kills the app.
          if (path.extname(pathname)) {
            res.writeHead(404, { 'Content-Type': 'text/plain' })
            res.end('Not found')
            return
          }
          fs.readFile(path.join(distDir, 'index.html'), (err2, html) => {
            if (err2) {
              res.writeHead(404)
              res.end('Not found')
              return
            }
            res.writeHead(200, {
              'Content-Type': 'text/html',
              'Cache-Control': 'no-cache',
            })
            res.end(html)
          })
          return
        }
        const ext = path.extname(fp).slice(1)
        const mime: Record<string, string> = {
          html: 'text/html',
          js: 'application/javascript',
          css: 'text/css',
          svg: 'image/svg+xml',
          png: 'image/png',
          ico: 'image/x-icon',
          json: 'application/json',
          webmanifest: 'application/manifest+json',
          woff2: 'font/woff2',
          woff: 'font/woff',
        }
        // Cache policy:
        //  - index.html and other non-asset files: no-cache (always revalidate)
        //  - /assets/* (content-hashed filenames): immutable, cache for 1 year
        const isHashedAsset = pathname.startsWith('/assets/')
        const cacheControl = isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache'
        res.writeHead(200, {
          'Content-Type': mime[ext] ?? 'application/octet-stream',
          'Cache-Control': cacheControl,
        })
        res.end(data)
      })
    }

    // If path resolves to a directory, try index.html inside it
    try {
      const stat = fs.statSync(filePath)
      if (stat.isDirectory()) filePath = path.join(filePath, 'index.html')
    } catch {
      // file doesn't exist — serveFile handles the SPA fallback
    }

    serveFile(filePath)
  })

  // noServer: true — we drive the upgrade lifecycle manually so we can authenticate first.
  const wss = new WebSocketServer({ noServer: true })

  // ws-protocol heartbeat: reaps sockets that never fired close/error (e.g. the
  // client machine dropped off the network mid-connection). Browsers can't observe
  // ws ping/pong frames directly, which is why there's also an app-level ping/pong
  // below for the renderer to detect a half-dead socket itself.
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const live = client as WebSocket & { isAlive?: boolean }
      if (live.isAlive === false) {
        client.terminate()
        continue
      }
      live.isAlive = false
      client.ping()
    }
  }, HEARTBEAT_INTERVAL_MS)
  heartbeat.unref?.()

  wss.on('close', () => clearInterval(heartbeat))
  httpServer.on('close', () => clearInterval(heartbeat))

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

    if (url.pathname !== '/rpc') {
      socket.destroy()
      return
    }

    // Reject disallowed browser origins BEFORE completing the handshake. This
    // is intentionally placed ahead of handleUpgrade (unlike the token check
    // below): a cross-site / DNS-rebind browser connection is never a
    // legitimate client that needs the clean 4001 signal, and rejecting here
    // avoids opening a socket for it at all, trimming pre-auth churn. Only
    // enforced when an allowlist is configured and the request carries an
    // Origin header (i.e. a browser).
    if (!originAllowed(req.headers.origin, allowedOrigins)) {
      socket.destroy()
      return
    }

    const authHeader = req.headers['authorization']
    const bearerToken = authHeader?.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length)
      : undefined
    const queryToken = url.searchParams.get('token') ?? undefined
    const provided = bearerToken ?? queryToken

    // Complete the WebSocket handshake first, THEN authenticate. A raw HTTP 401
    // during the upgrade surfaces in the browser only as an opaque 1006 close —
    // indistinguishable from a network drop — so the client can't tell a bad
    // token from a flaky connection and just reconnects forever. Closing the
    // opened socket with 4001 gives the client an unambiguous "auth failed"
    // signal it can act on (see wsApi.ts onAuthError → main.ts re-gate).
    wss.handleUpgrade(req, socket, head, (ws) => {
      // resolveIdentity checks the static SLIPSTREAM_TOKEN (→ LOCAL_IDENTITY)
      // first, then falls back to the per-device token store (FLO-143) —
      // undefined means neither matched, so auth is rejected identically
      // whether the credential is wrong, unknown, or revoked.
      const identity = provided
        ? resolveIdentity(provided, { staticToken: token, deviceTokens: deps.deviceTokens })
        : undefined
      if (!identity) {
        ws.close(4001, 'Unauthorized')
        return
      }
      wss.emit('connection', ws, req, identity)
    })
  })

  wss.on(
    'connection',
    (ws: WebSocket, _req: http.IncomingMessage, identity: Identity = LOCAL_IDENTITY) => {
      const clientId = randomUUID()

      const live = ws as WebSocket & { isAlive?: boolean }
      live.isAlive = true
      ws.on('pong', () => {
        live.isAlive = true
      })

      const rpc = createRpc(
        deps,
        (channel, ...args) => {
          if (ws.readyState !== WebSocket.OPEN) return
          ws.send(JSON.stringify({ t: 'push', channel, args } as WirePush))
        },
        { identity, clientId },
      )

      ws.on('message', (raw) => {
        let req: WireReq | WirePing
        try {
          req = JSON.parse(String(raw)) as WireReq | WirePing
        } catch {
          return // ignore malformed frames
        }

        if (req.t === 'ping') {
          ws.send(JSON.stringify({ t: 'pong' }))
          return
        }

        if (req.t !== 'req') return

        rpc.handle(req.channel, req.args).then(
          (result) => {
            const res: WireRes = { t: 'res', id: req.id, ok: true, result }
            ws.send(JSON.stringify(res))
          },
          (err: unknown) => {
            const error = err instanceof Error ? err.message : String(err)
            const res: WireRes = { t: 'res', id: req.id, ok: false, error }
            ws.send(JSON.stringify(res))
          },
        )
      })

      ws.on('close', () => rpc.dispose())
      ws.on('error', () => rpc.dispose())
    },
  )

  httpServer.listen(port, bind, () => {
    console.log(`[slipstream-server] Listening on http://${bind}:${port}`)
    console.log(`[slipstream-server] WebSocket RPC at ws://${bind}:${port}/rpc  (token required)`)
  })

  return httpServer
}

// ── Entry point (run under ELECTRON_RUN_AS_NODE=1 electron) ──────────────────

// Only bootstrap when run as a script, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const token = process.env.SLIPSTREAM_TOKEN
  if (!token) {
    console.error('[slipstream-server] SLIPSTREAM_TOKEN is required but not set. Exiting.')
    process.exit(1)
  }

  // Lazy-import native-module-dependent services only at entry point time
  // so tests can import createServer without loading better-sqlite3/node-pty.
  const { createServices, resolveDataDir } = await import('../core/services.js')
  const deps = createServices(resolveDataDir())
  const logger = deps.logger

  // Process-level error capture: these survive restarts via server.log.
  logger?.server('info', 'server starting', { pid: process.pid, ppid: process.ppid })
  process.on('uncaughtException', (err) => {
    logger?.server('error', 'uncaughtException', err)
    console.error('[slipstream-server] uncaughtException:', err)
  })
  process.on('unhandledRejection', (reason) => {
    logger?.server('error', 'unhandledRejection', reason)
    console.error('[slipstream-server] unhandledRejection:', reason)
  })

  const allowedOrigins = (process.env.SLIPSTREAM_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0)

  createServer(deps, {
    token,
    bind: process.env.SLIPSTREAM_BIND ?? '127.0.0.1',
    port: process.env.SLIPSTREAM_PORT ? Number(process.env.SLIPSTREAM_PORT) : 7421,
    allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : undefined,
  })
  logger?.server('info', 'server listening', {
    bind: process.env.SLIPSTREAM_BIND ?? '127.0.0.1',
    port: process.env.SLIPSTREAM_PORT ?? 7421,
  })
}

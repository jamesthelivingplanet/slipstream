import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import type { IpcDeps } from '../ipc.js'
import { createRpc } from '../core/rpc.js'
import type { WireReq, WireRes, WirePush } from '../shared/wire.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export interface ServerOptions {
  token: string
  bind?: string
  port?: number
}

/**
 * Create and start the HTTP + WebSocket server.
 * Services are passed in so the server is fully testable without native modules.
 * Returns the underlying http.Server (useful for obtaining the bound port in tests).
 */
export function createServer(deps: IpcDeps, opts: ServerOptions): http.Server {
  const { token, bind = '127.0.0.1', port = 7421 } = opts

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

    // Serve static files from dist/
    let filePath = path.join(distDir, url.pathname)

    function serveFile(fp: string): void {
      fs.readFile(fp, (err, data) => {
        if (err) {
          // SPA fallback
          fs.readFile(path.join(distDir, 'index.html'), (err2, html) => {
            if (err2) {
              res.writeHead(404)
              res.end('Not found')
              return
            }
            res.writeHead(200, { 'Content-Type': 'text/html' })
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
          woff2: 'font/woff2',
          woff: 'font/woff',
        }
        res.writeHead(200, { 'Content-Type': mime[ext] ?? 'application/octet-stream' })
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

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

    if (url.pathname !== '/rpc') {
      socket.destroy()
      return
    }

    const authHeader = req.headers['authorization']
    const bearerToken = authHeader?.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length)
      : undefined
    const queryToken = url.searchParams.get('token') ?? undefined
    const provided = bearerToken ?? queryToken

    if (provided !== token) {
      const body = 'Unauthorized'
      socket.write(
        `HTTP/1.1 401 Unauthorized\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
      )
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })

  wss.on('connection', (ws: WebSocket) => {
    const rpc = createRpc(deps, (channel, ...args) => {
      if (ws.readyState !== WebSocket.OPEN) return
      const push: WirePush = { t: 'push', channel, args }
      ws.send(JSON.stringify(push))
    })

    ws.on('message', (raw) => {
      let req: WireReq
      try {
        req = JSON.parse(String(raw)) as WireReq
      } catch {
        return // ignore malformed frames
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
  })

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

  createServer(deps, {
    token,
    bind: process.env.SLIPSTREAM_BIND ?? '127.0.0.1',
    port: process.env.SLIPSTREAM_PORT ? Number(process.env.SLIPSTREAM_PORT) : 7421,
  })
}

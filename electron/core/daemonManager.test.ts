import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveDaemonConfig, loadOrCreateLocalIdentity, pickPort } from './daemonManager.js'

// ── resolveDaemonConfig — remote mode ─────────────────────────────────────────

describe('resolveDaemonConfig — remote mode', () => {
  it('derives wsUrl and httpBase from SLIPSTREAM_DAEMON_URL (http)', async () => {
    const cfg = await resolveDaemonConfig({
      env: {
        SLIPSTREAM_DAEMON_URL: 'http://pod.tailnet.ts.net:7421',
        SLIPSTREAM_TOKEN: 'mytoken',
      },
      dataDir: '/unused',
    })
    expect(cfg.mode).toBe('remote')
    expect(cfg.httpBase).toBe('http://pod.tailnet.ts.net:7421')
    expect(cfg.wsUrl).toBe('ws://pod.tailnet.ts.net:7421/rpc')
    expect(cfg.token).toBe('mytoken')
    expect(cfg.port).toBeUndefined()
  })

  it('uses wss for https base URLs', async () => {
    const cfg = await resolveDaemonConfig({
      env: {
        SLIPSTREAM_DAEMON_URL: 'https://pod.tailnet.ts.net:7421',
        SLIPSTREAM_TOKEN: 'tok',
      },
      dataDir: '/unused',
    })
    expect(cfg.wsUrl).toBe('wss://pod.tailnet.ts.net:7421/rpc')
  })

  it('throws a clear error when SLIPSTREAM_TOKEN is unset in remote mode', async () => {
    await expect(
      resolveDaemonConfig({
        env: { SLIPSTREAM_DAEMON_URL: 'http://example.com:7421' },
        dataDir: '/unused',
      }),
    ).rejects.toThrow(/SLIPSTREAM_TOKEN.*required/)
  })
})

// ── resolveDaemonConfig — local mode ──────────────────────────────────────────

describe('resolveDaemonConfig — local mode', () => {
  it('returns correct wsUrl/httpBase from injected identity', async () => {
    const cfg = await resolveDaemonConfig({
      env: {},
      dataDir: '/unused',
      loadIdentity: async () => ({ token: 'localtoken', port: 8888 }),
    })
    expect(cfg.mode).toBe('local')
    expect(cfg.httpBase).toBe('http://127.0.0.1:8888')
    expect(cfg.wsUrl).toBe('ws://127.0.0.1:8888/rpc')
    expect(cfg.token).toBe('localtoken')
    expect(cfg.port).toBe(8888)
  })
})

// ── loadOrCreateLocalIdentity ─────────────────────────────────────────────────

describe('loadOrCreateLocalIdentity', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-daemon-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates daemon.json when absent and returns consistent identity', async () => {
    const id = await loadOrCreateLocalIdentity(
      tmpDir,
      {},
      {
        pickPort: async () => 9999,
      },
    )
    expect(id.port).toBe(9999)
    expect(typeof id.token).toBe('string')
    expect(id.token.length).toBeGreaterThan(0)

    // File was written
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'daemon.json'), 'utf8'))
    expect(raw.port).toBe(9999)
    expect(raw.token).toBe(id.token)
  })

  it('reads existing daemon.json unchanged', async () => {
    const fixed = { token: 'fixedtoken', port: 12345 }
    fs.writeFileSync(path.join(tmpDir, 'daemon.json'), JSON.stringify(fixed))

    const id = await loadOrCreateLocalIdentity(tmpDir, {})
    expect(id.token).toBe('fixedtoken')
    expect(id.port).toBe(12345)
  })

  it('uses SLIPSTREAM_TOKEN env var when creating', async () => {
    const id = await loadOrCreateLocalIdentity(
      tmpDir,
      { SLIPSTREAM_TOKEN: 'envtoken' },
      {
        pickPort: async () => 7777,
      },
    )
    expect(id.token).toBe('envtoken')
  })

  it('writes daemon.json with mode 0600 (hygiene for a bearer-token file)', async () => {
    // Same-uid agents can still read it — this is hygiene, not containment
    // (the 0700 data dir already gated same-uid readers; only a separate
    // uid/sandbox would actually close the hole). See docs/SECURITY.md §7.
    await loadOrCreateLocalIdentity(tmpDir, {}, { pickPort: async () => 9999 })
    const mode = fs.statSync(path.join(tmpDir, 'daemon.json')).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('creates a fresh data dir with mode 0700 (FLO-130)', async () => {
    // beforeEach pre-creates tmpDir, so use a not-yet-existing subdirectory to
    // actually exercise the mkdir path. Locking the dir to 0700 in the same
    // call that creates it closes the first-boot window where the dir would
    // otherwise sit at default (umask-dependent) perms until the spawned
    // daemon child's own chmod in services.ts runs. See docs/SECURITY.md §7.
    const freshDir = path.join(tmpDir, 'sub')
    await loadOrCreateLocalIdentity(freshDir, {}, { pickPort: async () => 9999 })
    const mode = fs.statSync(freshDir).mode & 0o777
    expect(mode).toBe(0o700)
  })
})

// ── pickPort ──────────────────────────────────────────────────────────────────

describe('pickPort', () => {
  it('returns a free port that can be bound', async () => {
    const port = await pickPort()
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThanOrEqual(65535)

    // Verify we can actually bind it
    const net = await import('node:net')
    await new Promise<void>((resolve, reject) => {
      const srv = net.createServer()
      srv.listen({ host: '127.0.0.1', port }, () => {
        srv.close((err) => (err ? reject(err) : resolve()))
      })
      srv.on('error', reject)
    })
  })

  it('falls back when preferred port is busy', async () => {
    const net = await import('node:net')
    // Bind the preferred port
    const blocker = net.createServer()
    const busyPort = await new Promise<number>((resolve, reject) => {
      blocker.listen({ host: '127.0.0.1', port: 0 }, () => {
        resolve((blocker.address() as import('node:net').AddressInfo).port)
      })
      blocker.on('error', reject)
    })

    try {
      const port = await pickPort(busyPort)
      expect(port).not.toBe(busyPort)
      expect(port).toBeGreaterThan(0)
    } finally {
      await new Promise<void>((resolve, reject) =>
        blocker.close((err) => (err ? reject(err) : resolve())),
      )
    }
  })
})

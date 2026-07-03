import { describe, it, expect, vi } from 'vitest'
import { runBootstrap, renderDaemonErrorPage, daemonErrorMessage } from './bootstrap.js'
import type { DaemonConfig, DaemonHandle } from './daemonManager.js'

const localCfg: DaemonConfig = {
  mode: 'local',
  wsUrl: 'ws://127.0.0.1:7421/rpc',
  httpBase: 'http://127.0.0.1:7421',
  token: 'tok',
  port: 7421,
}

const remoteCfg: DaemonConfig = {
  mode: 'remote',
  wsUrl: 'wss://pod.tailnet.ts.net:7421/rpc',
  httpBase: 'https://pod.tailnet.ts.net:7421',
  token: 'remotetok',
}

const okHandle: DaemonHandle = { child: null, reused: true, kill() {} }

// ── runBootstrap ────────────────────────────────────────────────────────────

describe('runBootstrap', () => {
  it('surfaces resolve-config failures without booting the app', async () => {
    const err = new Error('boom: could not resolve config')
    const showApp = vi.fn()
    const showError = vi.fn()

    const outcome = await runBootstrap({
      resolveConfig: async () => {
        throw err
      },
      ensureDaemon: async () => okHandle,
      showApp,
      showError,
    })

    expect(outcome.ok).toBe(false)
    expect(outcome).toMatchObject({ ok: false, stage: 'resolve-config' })
    expect(showError).toHaveBeenCalledTimes(1)
    expect(showError).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, stage: 'resolve-config', error: err }),
    )
    expect(showApp).not.toHaveBeenCalled()
  })

  it('surfaces ensure-daemon failures without booting the app', async () => {
    const err = new Error('daemon never came up')
    const showApp = vi.fn()
    const showError = vi.fn()

    const outcome = await runBootstrap({
      resolveConfig: async () => localCfg,
      ensureDaemon: async () => {
        throw err
      },
      showApp,
      showError,
    })

    expect(outcome).toMatchObject({ ok: false, stage: 'ensure-daemon' })
    expect(showError).toHaveBeenCalledTimes(1)
    expect(showError).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, stage: 'ensure-daemon', error: err }),
    )
    expect(showApp).not.toHaveBeenCalled()
  })

  it('boots the app on success (local mode)', async () => {
    const showApp = vi.fn()
    const showError = vi.fn()
    const ensureDaemon = vi.fn(async () => okHandle)

    const outcome = await runBootstrap({
      resolveConfig: async () => localCfg,
      ensureDaemon,
      showApp,
      showError,
    })

    expect(outcome).toEqual({ ok: true, config: localCfg })
    expect(ensureDaemon).toHaveBeenCalledTimes(1)
    expect(ensureDaemon).toHaveBeenCalledWith(localCfg)
    expect(showApp).toHaveBeenCalledTimes(1)
    expect(showApp).toHaveBeenCalledWith(localCfg)
    expect(showError).not.toHaveBeenCalled()
  })

  it('skips ensureDaemon for remote-mode config and boots the app', async () => {
    const showApp = vi.fn()
    const showError = vi.fn()
    const ensureDaemon = vi.fn(async () => okHandle)

    const outcome = await runBootstrap({
      resolveConfig: async () => remoteCfg,
      ensureDaemon,
      showApp,
      showError,
    })

    expect(outcome).toEqual({ ok: true, config: remoteCfg })
    expect(ensureDaemon).not.toHaveBeenCalled()
    expect(showApp).toHaveBeenCalledTimes(1)
    expect(showApp).toHaveBeenCalledWith(remoteCfg)
    expect(showError).not.toHaveBeenCalled()
  })
})

// ── daemonErrorMessage ────────────────────────────────────────────────────────

describe('daemonErrorMessage', () => {
  it('returns distinct messages per stage', () => {
    const resolveMsg = daemonErrorMessage('resolve-config')
    const ensureMsg = daemonErrorMessage('ensure-daemon')
    expect(resolveMsg).not.toBe(ensureMsg)
    expect(resolveMsg.length).toBeGreaterThan(0)
    expect(ensureMsg.length).toBeGreaterThan(0)
  })
})

// ── renderDaemonErrorPage ──────────────────────────────────────────────────────

describe('renderDaemonErrorPage', () => {
  it('includes stage message, error text, and actionable guidance', () => {
    const html = renderDaemonErrorPage({
      ok: false,
      stage: 'ensure-daemon',
      error: new Error('daemon did not become healthy'),
    })

    expect(html).toContain(daemonErrorMessage('ensure-daemon'))
    expect(html).toContain('daemon did not become healthy')
    expect(html).toContain('CLAUDE.md')
    expect(html).toContain('scripts/setup.sh')
    expect(html).toContain('server.log')
  })

  it('HTML-escapes the error message', () => {
    const html = renderDaemonErrorPage({
      ok: false,
      stage: 'resolve-config',
      error: new Error('<script>alert(1)</script>'),
    })

    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('stringifies non-Error error values', () => {
    const html = renderDaemonErrorPage({
      ok: false,
      stage: 'resolve-config',
      error: 'plain string failure',
    })

    expect(html).toContain('plain string failure')
  })
})

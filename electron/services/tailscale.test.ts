import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTailscaleExposer, type ExecFn } from './tailscale.js'

const RUNNING_STATUS = JSON.stringify({
  BackendState: 'Running',
  Self: { DNSName: 'devbox.tail1234.ts.net.' },
})

function makeExec(overrides?: {
  status?: () => Promise<{ stdout: string; stderr: string }>
  serve?: () => Promise<{ stdout: string; stderr: string }>
}) {
  const calls: string[][] = []
  const exec: ExecFn = async (file, args) => {
    calls.push([file, ...args])
    if (args[0] === 'status') {
      return overrides?.status ? overrides.status() : { stdout: RUNNING_STATUS, stderr: '' }
    }
    if (args[0] === 'serve') {
      return overrides?.serve ? overrides.serve() : { stdout: '', stderr: '' }
    }
    throw new Error(`unexpected command: ${file} ${args.join(' ')}`)
  }
  return { exec, calls }
}

describe('createTailscaleExposer', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('exposes the port via tailscale serve and returns the tailnet URL', async () => {
    const { exec, calls } = makeExec()
    const ts = createTailscaleExposer(exec)

    const url = await ts.expose('r1 main', 3001)

    expect(url).toBe('https://devbox.tail1234.ts.net:3001')
    expect(calls).toContainEqual([
      'tailscale',
      'serve',
      '--bg',
      '--https=3001',
      'http://127.0.0.1:3001',
    ])
    expect(ts.urlFor('r1 main')).toBe('https://devbox.tail1234.ts.net:3001')
  })

  it('returns null when the tailscale CLI is missing', async () => {
    const exec: ExecFn = async () => {
      throw new Error('ENOENT')
    }
    const ts = createTailscaleExposer(exec)

    expect(await ts.expose('r1 main', 3001)).toBeNull()
    expect(ts.urlFor('r1 main')).toBeNull()
  })

  it('returns null when tailscaled is not running', async () => {
    const { exec, calls } = makeExec({
      status: async () => ({
        stdout: JSON.stringify({ BackendState: 'Stopped', Self: { DNSName: 'x.ts.net.' } }),
        stderr: '',
      }),
    })
    const ts = createTailscaleExposer(exec)

    expect(await ts.expose('r1 main', 3001)).toBeNull()
    // No serve attempt when the backend is down.
    expect(calls.some((c) => c[1] === 'serve')).toBe(false)
  })

  it('returns null when tailscale serve fails (e.g. no operator permissions)', async () => {
    const { exec } = makeExec({
      serve: async () => {
        throw new Error('Access denied: serve config denied')
      },
    })
    const ts = createTailscaleExposer(exec)

    expect(await ts.expose('r1 main', 3001)).toBeNull()
    expect(ts.urlFor('r1 main')).toBeNull()
  })

  it('is idempotent for the same key+port without re-running serve', async () => {
    const { exec, calls } = makeExec()
    const ts = createTailscaleExposer(exec)

    const a = await ts.expose('r1 main', 3001)
    const b = await ts.expose('r1 main', 3001)

    expect(b).toBe(a)
    expect(calls.filter((c) => c[1] === 'serve')).toHaveLength(1)
  })

  it('unexpose turns the serve mount off and forgets the URL', async () => {
    const { exec, calls } = makeExec()
    const ts = createTailscaleExposer(exec)

    await ts.expose('r1 main', 3001)
    await ts.unexpose('r1 main')

    expect(calls).toContainEqual(['tailscale', 'serve', '--https=3001', 'off'])
    expect(ts.urlFor('r1 main')).toBeNull()
  })

  it('unexpose is a no-op for keys that were never exposed', async () => {
    const { exec, calls } = makeExec()
    const ts = createTailscaleExposer(exec)

    await ts.unexpose('never seen')

    expect(calls).toHaveLength(0)
  })
})

import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSandboxMode, buildBwrapArgs, sandboxSpawnSpec } from './agentSandbox.js'

/**
 * Unit-tests the pure bwrap-arg builder and the spawn-decision logic against
 * injected deps, then (guarded, real bwrap only) exercises the actual
 * containment recipe end-to-end — see agentSandbox.ts header for the recipe.
 */

describe('resolveSandboxMode', () => {
  it('is bwrap when SLIPSTREAM_SANDBOX=bwrap', () => {
    expect(resolveSandboxMode({ SLIPSTREAM_SANDBOX: 'bwrap' })).toBe('bwrap')
  })

  it('is none when unset', () => {
    expect(resolveSandboxMode({})).toBe('none')
  })

  it('is none for other values', () => {
    expect(resolveSandboxMode({ SLIPSTREAM_SANDBOX: 'firejail' })).toBe('none')
    expect(resolveSandboxMode({ SLIPSTREAM_SANDBOX: '' })).toBe('none')
  })
})

describe('buildBwrapArgs', () => {
  const args = buildBwrapArgs({
    dataDir: '/data',
    sessionId: 'sid1',
    cmd: 'claude',
    args: ['--foo', 'bar'],
  })

  it('starts with the shared-root dev-bind', () => {
    expect(args.slice(0, 3)).toEqual(['--dev-bind', '/', '/'])
  })

  it('tmpfs-overmounts the data dir', () => {
    const i = args.indexOf('--tmpfs')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(args[i + 1]).toBe('/data')
  })

  it('re-binds the session dir rw', () => {
    const i = args.indexOf('--bind-try')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(args[i + 1]).toBe('/data/sessions/sid1')
    expect(args[i + 2]).toBe('/data/sessions/sid1')
  })

  it('re-binds the bin dir ro', () => {
    const i = args.indexOf('--ro-bind-try')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(args[i + 1]).toBe('/data/bin')
    expect(args[i + 2]).toBe('/data/bin')
  })

  it('does not expose secrets or dangerous flags', () => {
    const joined = args.join(' ')
    expect(joined).not.toContain('daemon.json')
    expect(joined).not.toContain('slipstream.db')
    expect(joined).not.toContain('secret.key')
    expect(joined).not.toContain('new-session')
    expect(args).not.toContain('--unshare-net')
  })

  it('ends with the -- separator and the wrapped command', () => {
    expect(args.slice(-4)).toEqual(['--', 'claude', '--foo', 'bar'])
  })
})

describe('sandboxSpawnSpec', () => {
  it('passes through unchanged when mode is none', () => {
    const spec = sandboxSpawnSpec({ cmd: 'claude', args: ['--x'], env: {} }, { mode: 'none' })
    expect(spec).toEqual({ cmd: 'claude', args: ['--x'], sandboxed: false })
  })

  it('wraps with bwrap when mode is bwrap and bwrap is available', () => {
    const ensured: string[] = []
    const spec = sandboxSpawnSpec(
      {
        cmd: 'claude',
        args: ['--x'],
        env: { SLIPSTREAM_DATA_DIR: '/data', SLIPSTREAM_SESSION_ID: 'sid1' },
      },
      { mode: 'bwrap', available: true, ensureSessionDir: (d) => ensured.push(d) },
    )
    expect(spec.cmd).toBe('bwrap')
    expect(spec.sandboxed).toBe(true)
    expect(spec.args).toEqual(
      buildBwrapArgs({ dataDir: '/data', sessionId: 'sid1', cmd: 'claude', args: ['--x'] }),
    )
    expect(ensured).toEqual(['/data/sessions/sid1'])
  })

  it('passes through and warns once when bwrap is unavailable', () => {
    const warnings: string[] = []
    const spec = sandboxSpawnSpec(
      {
        cmd: 'claude',
        args: ['--x'],
        env: { SLIPSTREAM_DATA_DIR: '/data', SLIPSTREAM_SESSION_ID: 'sid1' },
      },
      { mode: 'bwrap', available: false, warn: (m) => warnings.push(m) },
    )
    expect(spec).toEqual({ cmd: 'claude', args: ['--x'], sandboxed: false })
    expect(warnings).toHaveLength(1)
  })

  it('passes through and warns when SLIPSTREAM_DATA_DIR is missing', () => {
    const warnings: string[] = []
    const spec = sandboxSpawnSpec(
      { cmd: 'claude', args: ['--x'], env: { SLIPSTREAM_SESSION_ID: 'sid1' } },
      { mode: 'bwrap', available: true, warn: (m) => warnings.push(m) },
    )
    expect(spec).toEqual({ cmd: 'claude', args: ['--x'], sandboxed: false })
    expect(warnings).toHaveLength(1)
  })
})

let realBwrap = false
try {
  execFileSync('bwrap', ['--version'], { stdio: 'ignore' })
  realBwrap = true
} catch {
  realBwrap = false
}

describe.skipIf(!realBwrap)('bwrap containment (real)', () => {
  let dataDir: string

  afterAll(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true })
  })

  it('hides daemon.json/slipstream.db, exposes the session dir rw', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'slipstream-sandbox-'))
    writeFileSync(join(dataDir, 'daemon.json'), 'DAEMON_SECRET_TOKEN')
    writeFileSync(join(dataDir, 'slipstream.db'), 'DB_SECRET_CONTENTS')
    mkdirSync(join(dataDir, 'sessions', 'sid1'), { recursive: true })
    writeFileSync(join(dataDir, 'sessions', 'sid1', 'status.json'), 'hello')
    mkdirSync(join(dataDir, 'bin'), { recursive: true })
    mkdirSync(join(dataDir, 'clipboard'), { recursive: true })

    const written = join(dataDir, 'sessions', 'sid1', 'written-by-sandbox.txt')
    const script = [
      `cat ${JSON.stringify(join(dataDir, 'daemon.json'))} 2>/dev/null`,
      `cat ${JSON.stringify(join(dataDir, 'slipstream.db'))} 2>/dev/null`,
      `cat ${JSON.stringify(join(dataDir, 'sessions', 'sid1', 'status.json'))} 2>/dev/null`,
      `echo written > ${JSON.stringify(written)}`,
    ].join('\n')

    const args = buildBwrapArgs({
      dataDir,
      sessionId: 'sid1',
      cmd: '/bin/sh',
      args: ['-c', script],
    })
    const output = execFileSync('bwrap', args, { encoding: 'utf8' })

    expect(output).not.toContain('DAEMON_SECRET_TOKEN')
    expect(output).not.toContain('DB_SECRET_CONTENTS')
    expect(output).toContain('hello')

    expect(existsSync(written)).toBe(true)
    expect(readFileSync(written, 'utf8')).toContain('written')
  })
})

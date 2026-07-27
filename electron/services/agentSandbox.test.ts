import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveSandboxMode,
  buildBwrapArgs,
  sandboxSpawnSpec,
  resolveProdPaths,
} from './agentSandbox.js'

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

  it("is byte-identical to today's output when no prod params are set", () => {
    expect(args).toEqual([
      '--dev-bind',
      '/',
      '/',
      '--tmpfs',
      '/data',
      '--ro-bind-try',
      '/data/bin',
      '/data/bin',
      '--bind-try',
      '/data/sessions/sid1',
      '/data/sessions/sid1',
      '--ro-bind-try',
      '/data/clipboard',
      '/data/clipboard',
      '--die-with-parent',
      '--',
      'claude',
      '--foo',
      'bar',
    ])
  })
})

describe('buildBwrapArgs — production containment (per-worktree dev instances)', () => {
  it('tmpfs-overmounts prodDataDir when it differs from dataDir', () => {
    const args = buildBwrapArgs({
      dataDir: '/dev/data',
      sessionId: 'sid1',
      cmd: 'claude',
      args: [],
      prodDataDir: '/home/user/.config/slipstream',
    })
    const i = args.indexOf('--tmpfs')
    const j = args.lastIndexOf('--tmpfs')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(args[i + 1]).toBe('/dev/data')
    expect(j).not.toBe(i)
    expect(args[j + 1]).toBe('/home/user/.config/slipstream')
  })

  it('does not duplicate the tmpfs when prodDataDir equals dataDir', () => {
    const args = buildBwrapArgs({
      dataDir: '/data',
      sessionId: 'sid1',
      cmd: 'claude',
      args: [],
      prodDataDir: '/data',
    })
    expect(args.filter((a) => a === '--tmpfs')).toHaveLength(1)
  })

  it('does not tmpfs prodDataDir when it is a PARENT of dataDir', () => {
    // Mounting a tmpfs over an ancestor of dataDir would shadow dataDir
    // itself (and the session-dir bind mount below it) — the dev data dir
    // must never be nested inside the prod data dir in the first place, but
    // this guards the sandbox layer too in case it ever is.
    const args = buildBwrapArgs({
      dataDir: '/home/u/.config/slipstream/dev-slots/x',
      sessionId: 'sid1',
      cmd: 'claude',
      args: [],
      prodDataDir: '/home/u/.config/slipstream',
    })
    expect(args.filter((a) => a === '--tmpfs')).toHaveLength(1)
    const i = args.indexOf('--tmpfs')
    expect(args[i + 1]).toBe('/home/u/.config/slipstream/dev-slots/x')
    expect(args).not.toContain('/home/u/.config/slipstream')
  })

  it('does not duplicate the tmpfs when prodDataDir equals dataDir via a non-normalized path', () => {
    const args = buildBwrapArgs({
      dataDir: '/data',
      sessionId: 'sid1',
      cmd: 'claude',
      args: [],
      prodDataDir: '/data/',
    })
    expect(args.filter((a) => a === '--tmpfs')).toHaveLength(1)
  })

  it('ro-binds prodRepoRoot when cwd is outside it', () => {
    const args = buildBwrapArgs({
      dataDir: '/data',
      sessionId: 'sid1',
      cmd: 'claude',
      args: [],
      prodRepoRoot: '/home/user/.repositories/slipstream',
      cwd: '/home/user/.worktrees/other/TASK-XXX',
    })
    // there are two other --ro-bind-try pairs (bin dir, clipboard dir);
    // find the one whose target is the prod repo root
    const idx = args.findIndex(
      (a, k) => a === '--ro-bind-try' && args[k + 1] === '/home/user/.repositories/slipstream',
    )
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('/home/user/.repositories/slipstream')
    expect(args[idx + 2]).toBe('/home/user/.repositories/slipstream')
  })

  it('does not ro-bind prodRepoRoot when cwd is inside it', () => {
    const args = buildBwrapArgs({
      dataDir: '/data',
      sessionId: 'sid1',
      cmd: 'claude',
      args: [],
      prodRepoRoot: '/home/user/.repositories/slipstream',
      cwd: '/home/user/.repositories/slipstream/electron',
    })
    expect(args).not.toContain('/home/user/.repositories/slipstream')
  })

  it('does not ro-bind prodRepoRoot when cwd equals it exactly', () => {
    const args = buildBwrapArgs({
      dataDir: '/data',
      sessionId: 'sid1',
      cmd: 'claude',
      args: [],
      prodRepoRoot: '/home/user/.repositories/slipstream',
      cwd: '/home/user/.repositories/slipstream',
    })
    expect(args).not.toContain('/home/user/.repositories/slipstream')
  })

  it('omits both prod mounts when prod params are unset (matches the byte-identical case)', () => {
    const args = buildBwrapArgs({
      dataDir: '/data',
      sessionId: 'sid1',
      cmd: 'claude',
      args: ['--foo', 'bar'],
    })
    expect(args.filter((a) => a === '--tmpfs')).toHaveLength(1)
    expect(args.filter((a) => a === '--ro-bind-try')).toHaveLength(2)
  })
})

describe('resolveProdPaths', () => {
  it('returns undefined for both when unset', () => {
    expect(resolveProdPaths({})).toEqual({ prodDataDir: undefined, prodRepoRoot: undefined })
  })

  it('returns the values when set', () => {
    expect(
      resolveProdPaths({
        SLIPSTREAM_PROD_DATA_DIR: '/home/user/.config/slipstream',
        SLIPSTREAM_PROD_REPO_ROOT: '/home/user/.repositories/slipstream',
      }),
    ).toEqual({
      prodDataDir: '/home/user/.config/slipstream',
      prodRepoRoot: '/home/user/.repositories/slipstream',
    })
  })

  it('treats empty string as unset', () => {
    expect(
      resolveProdPaths({ SLIPSTREAM_PROD_DATA_DIR: '', SLIPSTREAM_PROD_REPO_ROOT: '' }),
    ).toEqual({ prodDataDir: undefined, prodRepoRoot: undefined })
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

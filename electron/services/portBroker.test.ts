import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ExecFileException } from 'node:child_process'
import { promisify } from 'node:util'

// execFile is promisify'd in portBroker.ts. The real node execFile carries a
// `[util.promisify.custom]` that turns the callback into `{ stdout, stderr }`;
// a bare vi.fn() has no such symbol, so promisify would default to returning
// the raw callback args and `result.stdout` would be undefined. We re-attach
// the custom symbol so the mock mirrors the real execFile contract: the impl
// receives the callback-style (err, stdout, stderr) and promisify yields an
// object with `.stdout`.
const execFileImpl = vi.fn()
const execFileMock = vi.fn((...args: unknown[]) => execFileImpl(...args))
// @ts-expect-error — attaching the runtime promisify symbol to the mock
execFileMock[promisify.custom] = function (
  ...args: unknown[]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileImpl(...args, (err: unknown, stdout: string, stderr: string) => {
      if (err) reject(err)
      else resolve({ stdout, stderr })
    })
  })
}

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}))

// Imported after the mock so createPortBroker picks up the mocked execFile.
const { createPortBroker } = await import('./portBroker.js')

describe('createPortBroker / claim', () => {
  beforeEach(() => {
    execFileImpl.mockReset()
  })

  it('calls `floo claim <service>` in the given cwd', async () => {
    execFileImpl.mockImplementation((_f, _a, _o, cb) => cb(null, '3742\n', ''))
    const broker = createPortBroker()
    const port = await broker.claim('/repo/.worktrees/x', 'web')
    expect(port).toBe(3742)
    expect(execFileImpl).toHaveBeenCalledOnce()
    const [file, args, opts] = execFileImpl.mock.calls[0]
    expect(file).toBe('floo')
    expect(args).toEqual(['claim', 'web'])
    expect(opts).toMatchObject({ cwd: '/repo/.worktrees/x' })
  })

  it('parses the first integer out of a verbose "port 3742" line', async () => {
    execFileImpl.mockImplementation((_f, _a, _o, cb) =>
      cb(null, 'claiming web... port 3742 ready\n', ''),
    )
    const broker = createPortBroker()
    expect(await broker.claim('/cwd', 'web')).toBe(3742)
  })

  it('parses a bare integer stdout', async () => {
    execFileImpl.mockImplementation((_f, _a, _o, cb) => cb(null, '8080', ''))
    const broker = createPortBroker()
    expect(await broker.claim('/cwd', 'srv')).toBe(8080)
  })

  it('throws a descriptive error when floo stdout has no integer', async () => {
    execFileImpl.mockImplementation((_f, _a, _o, cb) => cb(null, 'nothing here', ''))
    const broker = createPortBroker()
    await expect(broker.claim('/cwd', 'web')).rejects.toThrow(
      /could not parse a port number from floo output/,
    )
  })

  it('throws a descriptive error when floo is missing (ENOENT)', async () => {
    // The "swallow-if-absent" path: floo not installed. portBroker itself
    // never silently returns — it throws a clear, caller-actionable Error
    // (sessionLauncher is the one that swallows it into `port = undefined`).
    const enoent = Object.assign(new Error('spawn floo ENOENT'), {
      code: 'ENOENT',
      errno: -2,
      syscall: 'spawn',
      path: 'floo',
    }) as ExecFileException
    execFileImpl.mockImplementation((_f, _a, _o, cb) => cb(enoent, '', ''))
    const broker = createPortBroker()
    await expect(broker.claim('/cwd', 'web')).rejects.toThrow(
      /portBroker: floo claim failed for service "web" in \/cwd/,
    )
  })

  it('throws a descriptive error when floo exits non-zero', async () => {
    const err = Object.assign(new Error('Command failed: floo claim web'), {
      code: 1,
      stderr: 'no ports available',
    }) as ExecFileException
    execFileImpl.mockImplementation((_f, _a, _o, cb) => cb(err, '', 'no ports available'))
    const broker = createPortBroker()
    await expect(broker.claim('/cwd', 'web')).rejects.toThrow(/floo claim failed for service "web"/)
  })

  it('preserves the underlying error as `cause`', async () => {
    const err = new Error('spawn floo ENOENT')
    execFileImpl.mockImplementation((_f, _a, _o, cb) => cb(err, '', ''))
    const broker = createPortBroker()
    try {
      await broker.claim('/cwd', 'web')
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as Error).cause).toBe(err)
    }
  })
})

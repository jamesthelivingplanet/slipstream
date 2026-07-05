import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest'

type ExitCb = (code: number | null, signal: NodeJS.Signals | null) => void

function makeFakeChild(pid: number) {
  const listeners: Record<string, ExitCb[]> = {}
  const child = {
    pid,
    killed: false,
    unref: vi.fn(),
    kill: vi.fn(function (this: typeof child) {
      this.killed = true
      return true
    }),
    on: vi.fn((event: string, cb: ExitCb) => {
      listeners[event] ??= []
      listeners[event].push(cb)
      return child
    }),
    // Test helper — not part of the real ChildProcess API.
    _emitExit(code: number | null = 0, signal: NodeJS.Signals | null = null) {
      for (const cb of listeners['exit'] ?? []) cb(code, signal)
    },
  }
  return child
}

const spawnMock = vi.fn()

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}))

// Imported after the mock so createAppRunner picks up the mocked spawn.
const { createAppRunner } = await import('./appRunner.js')

describe('createAppRunner', () => {
  let killSpy: MockInstance<typeof process.kill>

  beforeEach(() => {
    spawnMock.mockReset()
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
  })

  it('dedups repeated run() calls for the same key — spawns only once', async () => {
    const child1 = makeFakeChild(1111)
    spawnMock.mockReturnValueOnce(child1)

    const appRunner = createAppRunner()

    const first = await appRunner.run('r1 main', '/wt/a', 'pnpm dev')
    expect(first).toEqual({ pid: 1111, reused: false })
    expect(spawnMock).toHaveBeenCalledTimes(1)

    const second = await appRunner.run('r1 main', '/wt/a', 'pnpm dev')
    expect(second).toEqual({ pid: 1111, reused: true })
    expect(spawnMock).toHaveBeenCalledTimes(1)

    killSpy.mockRestore()
  })

  it('spawns a second process for a different key', async () => {
    const child1 = makeFakeChild(1111)
    const child2 = makeFakeChild(2222)
    spawnMock.mockReturnValueOnce(child1).mockReturnValueOnce(child2)

    const appRunner = createAppRunner()

    const a = await appRunner.run('r1 main', '/wt/a', 'pnpm dev')
    const b = await appRunner.run('r1 feature', '/wt/b', 'pnpm dev')

    expect(a).toEqual({ pid: 1111, reused: false })
    expect(b).toEqual({ pid: 2222, reused: false })
    expect(spawnMock).toHaveBeenCalledTimes(2)

    killSpy.mockRestore()
  })

  it('stop() kills the tracked process group and clears isRunning', async () => {
    const child = makeFakeChild(3333)
    spawnMock.mockReturnValueOnce(child)

    const appRunner = createAppRunner()
    await appRunner.run('r1 main', '/wt/a', 'pnpm dev')
    expect(appRunner.isRunning('r1 main')).toBe(true)

    const stopped = await appRunner.stop('r1 main')
    expect(stopped).toBe(true)
    expect(killSpy).toHaveBeenCalledWith(-3333, 'SIGTERM')

    expect(appRunner.isRunning('r1 main')).toBe(false)

    killSpy.mockRestore()
  })

  it('stop() returns false when nothing is tracked for the key', async () => {
    const appRunner = createAppRunner()
    const stopped = await appRunner.stop('nope')
    expect(stopped).toBe(false)
  })

  it('isRunning() becomes false once the child process exits on its own', async () => {
    const child = makeFakeChild(4444)
    spawnMock.mockReturnValueOnce(child)

    const appRunner = createAppRunner()
    await appRunner.run('r1 main', '/wt/a', 'pnpm dev')
    expect(appRunner.isRunning('r1 main')).toBe(true)

    child._emitExit(0, null)
    expect(appRunner.isRunning('r1 main')).toBe(false)

    killSpy.mockRestore()
  })
})

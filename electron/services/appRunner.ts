import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { IAppRunner } from '../shared/contract.js'

export function createAppRunner(): IAppRunner {
  const running = new Map<string, ChildProcess>()

  function isLive(key: string): boolean {
    const child = running.get(key)
    return !!child && !child.killed && child.pid !== undefined
  }

  return {
    run(
      key: string,
      cwd: string,
      command: string,
      env?: Record<string, string>,
    ): Promise<{ pid: number; reused: boolean }> {
      return new Promise((resolve, reject) => {
        if (isLive(key)) {
          const child = running.get(key)!
          resolve({ pid: child.pid!, reused: true })
          return
        }

        let child: ChildProcess
        try {
          child = spawn(command, {
            cwd,
            env: { ...process.env, ...env },
            shell: true,
            detached: true,
            stdio: 'ignore',
          })
        } catch (err) {
          return reject(err instanceof Error ? err : new Error(String(err)))
        }
        if (child.pid === undefined) {
          return reject(new Error(`Failed to spawn process for command: ${command}`))
        }
        child.unref()
        running.set(key, child)
        child.on('exit', () => {
          // Only clear the entry if a later run() hasn't already replaced it.
          if (running.get(key) === child) {
            running.delete(key)
          }
        })
        resolve({ pid: child.pid, reused: false })
      })
    },

    stop(key: string): Promise<boolean> {
      const child = running.get(key)
      if (!child || child.pid === undefined) return Promise.resolve(false)
      try {
        // detached: true makes the child a process-group leader — kill the
        // whole group so the actual dev server dies rather than being orphaned.
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        try {
          child.kill()
        } catch {
          // best effort — process may already be gone
        }
      }
      running.delete(key)
      return Promise.resolve(true)
    },

    isRunning(key: string): boolean {
      return isLive(key)
    },
  }
}

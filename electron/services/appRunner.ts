import { spawn } from 'node:child_process'
import type { IAppRunner } from '../shared/contract.js'

export function createAppRunner(): IAppRunner {
  return {
    run(cwd: string, command: string, env?: Record<string, string>): Promise<{ pid: number }> {
      return new Promise((resolve, reject) => {
        let child
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
        resolve({ pid: child.pid })
      })
    },
  }
}

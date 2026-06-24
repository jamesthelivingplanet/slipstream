import { spawn } from 'node:child_process'

export interface IEditorLauncher {
  /** Spawns `command` (which may include args) with the worktree path appended, detached. Rejects on spawn failure (e.g. binary not found). */
  open(command: string, worktreePath: string): Promise<void>
}

/** Split a configured editor command into bin + args and append the worktree path. Throws when command is blank. */
export function parseEditorCommand(command: string, worktreePath: string): { bin: string; args: string[] } {
  const tokens = command.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) throw new Error('No editor command configured')
  const [bin, ...args] = tokens
  return { bin, args: [...args, worktreePath] }
}

export function createEditorLauncher(): IEditorLauncher {
  return {
    open(command, worktreePath) {
      return new Promise((resolve, reject) => {
        let bin: string, args: string[]
        try { ({ bin, args } = parseEditorCommand(command, worktreePath)) }
        catch (e) { reject(e instanceof Error ? e : new Error(String(e))); return }
        const child = spawn(bin, args, { detached: true, stdio: 'ignore' })
        let settled = false
        child.on('error', (err) => {
          if (settled) return
          settled = true
          reject(new Error(`Failed to launch editor "${bin}": ${err.message}`))
        })
        child.on('spawn', () => {
          if (settled) return
          settled = true
          child.unref()
          resolve()
        })
      })
    },
  }
}

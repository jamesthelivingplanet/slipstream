/**
 * cliProbe — resolves whether an agent's CLI binary is on PATH (FLO-85).
 *
 * Pure and dependency-free (no natives) so it's importable from plain node
 * vitest, unlike db.ts/sessionManager.ts (see CLAUDE.md native-module note).
 */

import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { CLAUDE_BIN, OPENCODE_BIN_NAME } from '../shared/agentCli.js'
import type { BackendKind } from '../shared/contract.js'

/** Binary name for pi. Mirrors the fallback in agentBackend.ts's PI_BIN
 *  (which prefers a local node_modules/.bin/pi, but that's a spawn-path
 *  concern — for a PATH preflight check we only care about the bare name). */
export const PI_BIN_NAME = 'pi'

/** Map a BackendKind to the CLI binary name a preflight check should look for. */
export function binForKind(kind: BackendKind): string {
  switch (kind) {
    case 'claude-code':
      return CLAUDE_BIN
    case 'opencode':
      return OPENCODE_BIN_NAME
    case 'pi':
      return PI_BIN_NAME
  }
}

/**
 * Scan `env.PATH` for `bin`, returning the first absolute match or null.
 * On win32, also tries `bin` + each extension in `PATHEXT` (e.g. `.exe`, `.cmd`).
 */
export function findOnPath(bin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const pathVar = env.PATH ?? env.Path ?? ''
  const dirs = pathVar.split(path.delimiter).filter(Boolean)

  const candidates =
    process.platform === 'win32'
      ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter(Boolean)
          .map((ext) => bin + ext)
      : [bin]

  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = path.join(dir, candidate)
      try {
        if (existsSync(full) && statSync(full).isFile()) return full
      } catch {
        // Unreadable/broken path entry — skip it.
      }
    }
  }
  return null
}

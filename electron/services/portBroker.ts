/**
 * PortBroker — delegates sticky port assignment to the `floo` CLI.
 *
 * `floo claim <service>` prints a line containing the assigned port number.
 * We parse the first integer out of stdout and resolve it.
 *
 * If `floo` is not installed or the command fails, we reject with a descriptive
 * Error so the caller can decide on a fallback strategy.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { IPortBroker } from '../shared/contract.js'

const execFileAsync = promisify(execFile)

export function createPortBroker(): IPortBroker {
  async function claim(cwd: string, service: string): Promise<number> {
    let stdout: string

    try {
      const result = await execFileAsync('floo', ['claim', service], { cwd })
      stdout = result.stdout
    } catch (err: unknown) {
      // execFile rejects when the binary is missing (ENOENT) or exits non-zero.
      const msg =
        err instanceof Error ? err.message : String(err)
      throw new Error(
        `portBroker: floo claim failed for service "${service}" in ${cwd}: ${msg}`
      )
    }

    // Parse the first integer from floo's output (e.g. "port 3742\n" or "3742").
    const match = stdout.match(/\d+/)
    if (!match) {
      throw new Error(
        `portBroker: could not parse a port number from floo output: ${JSON.stringify(stdout)}`
      )
    }

    return parseInt(match[0], 10)
  }

  return { claim }
}

/**
 * TailscaleExposer — publishes a locally-running dev server on the tailnet.
 *
 * Slipstream itself is typically reached over Tailscale in web/headless mode,
 * so a dev server bound to 127.0.0.1 on the daemon machine is invisible to the
 * user's browser. When tailscaled is up we mirror each launched app onto the
 * tailnet with `tailscale serve --bg --https=<port> http://127.0.0.1:<port>`,
 * i.e. the same port number the app got from floo, and hand the resulting
 * https://<magicdns-name>:<port> URL back to the UI.
 *
 * No tailscale (CLI missing, daemon stopped, logged out) is the normal desktop
 * case, not an error: expose() resolves null and the run proceeds untouched.
 * `tailscale serve` needs operator permissions (`tailscale set --operator=$USER`)
 * — without them expose() also degrades to null rather than failing the run.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ITailscaleExposer } from '../shared/contract.js'

const execFileAsync = promisify(execFile)

export type ExecFn = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>

/** How long a "tailscaled is (not) running" answer stays fresh. */
const STATUS_TTL_MS = 30_000

export function createTailscaleExposer(
  exec: ExecFn = (file, args) => execFileAsync(file, args),
): ITailscaleExposer {
  // key -> { port, url } for mounts we created and must tear down on stop.
  const exposed = new Map<string, { port: number; url: string }>()

  let cached: { dnsName: string | null; at: number } | null = null

  /** MagicDNS name of this node when tailscaled is Running, else null. */
  async function selfDnsName(): Promise<string | null> {
    if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.dnsName
    let dnsName: string | null = null
    try {
      const { stdout } = await exec('tailscale', ['status', '--json'])
      const status = JSON.parse(stdout) as {
        BackendState?: string
        Self?: { DNSName?: string }
      }
      const raw = status.Self?.DNSName ?? ''
      if (status.BackendState === 'Running' && raw) {
        dnsName = raw.replace(/\.$/, '')
      }
    } catch {
      // CLI missing / daemon down / unparsable output — treat as "no tailscale".
    }
    cached = { dnsName, at: Date.now() }
    return dnsName
  }

  return {
    async expose(key: string, port: number): Promise<string | null> {
      const prior = exposed.get(key)
      if (prior && prior.port === port) return prior.url

      const dnsName = await selfDnsName()
      if (!dnsName) return null

      try {
        await exec('tailscale', ['serve', '--bg', `--https=${port}`, `http://127.0.0.1:${port}`])
      } catch {
        // Most likely missing operator permissions; don't fail the app run.
        return null
      }

      if (prior) {
        // Port changed under the same key — drop the stale mount.
        await this.unexpose(key)
      }
      const url = `https://${dnsName}:${port}`
      exposed.set(key, { port, url })
      return url
    },

    async unexpose(key: string): Promise<void> {
      const entry = exposed.get(key)
      if (!entry) return
      exposed.delete(key)
      try {
        await exec('tailscale', ['serve', `--https=${entry.port}`, 'off'])
      } catch {
        // best effort — mount may already be gone or permissions revoked
      }
    },

    urlFor(key: string): string | null {
      return exposed.get(key)?.url ?? null
    },
  }
}

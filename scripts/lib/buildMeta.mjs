import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url))

/**
 * Resolve the version + git SHA to stamp into built artifacts (renderer,
 * daemon/pod, and test runs) — see docs/VERSIONING.md. `GIT_SHA` env var
 * (set by CI / the Dockerfile build arg) takes priority since `.git` is
 * excluded from the Docker build context and `git rev-parse` would otherwise
 * silently fall back to 'unknown' inside the image build.
 */
export function getBuildMeta() {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  let gitSha = process.env.GIT_SHA || ''
  if (!gitSha) {
    try {
      gitSha = execSync('git rev-parse --short HEAD').toString().trim()
    } catch {
      gitSha = 'unknown'
    }
  }
  return { version: pkg.version, gitSha }
}

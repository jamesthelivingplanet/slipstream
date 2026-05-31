import { describe, it, expect, beforeAll } from 'vitest'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const preloadPath = path.join(root, 'dist-electron', 'preload.mjs')

/**
 * The preload is emitted as preload.mjs and loaded by Electron as ESM. If the
 * bundler emits CommonJS `require(...)` into it, Electron fails with
 * "require is not defined in ES module scope" and window.flotilla never loads.
 * This guards against that regression.
 */
describe('preload build output', () => {
  beforeAll(() => {
    execSync('pnpm build', { cwd: root, stdio: 'ignore' })
  }, 180000)

  it('is valid ESM — no bare require() calls', () => {
    const src = readFileSync(preloadPath, 'utf8')
    expect(src).not.toMatch(/\brequire\s*\(/)
  })
})

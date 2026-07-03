#!/usr/bin/env node
/**
 * Post-build check: assert dist-electron/preload.mjs is valid ESM.
 *
 * The preload is emitted as preload.mjs and loaded by Electron as ESM
 * (sandbox: false in main.ts + vite.config.ts forcing output.format 'es' for
 * the preload build). If the bundler emits a CommonJS `require(...)` call
 * into it, Electron fails with "require is not defined in ES module scope"
 * and window.slipstream never loads — Add repo/everything silently no-ops.
 *
 * This invariant used to live in electron/preload-esm.test.ts, which shelled
 * out to `pnpm build` inside a vitest beforeAll (180s timeout). That's the
 * wrong layer for a build invariant — it slowed down `pnpm test` and coupled
 * the test suite to a full build. Moved out per FLO-80: this script now runs
 * as a post-build check, right after `pnpm build`, in CI (.gitlab-ci.yml
 * `build` job) and in scripts/deploy.sh (Phase 2).
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const preloadPath = path.join(root, 'dist-electron', 'preload.mjs')

if (!existsSync(preloadPath)) {
  console.error(
    `✗ ${path.relative(root, preloadPath)} does not exist.\n` +
      '  Run `pnpm build` before this check — it verifies the build output, not source.',
  )
  process.exit(1)
}

const src = readFileSync(preloadPath, 'utf8')

if (/\brequire\s*\(/.test(src)) {
  console.error(
    '✗ dist-electron/preload.mjs contains a bare require() call.\n' +
      '  Electron loads preload.mjs as ESM (sandbox: false + output.format "es" in\n' +
      '  vite.config.ts). A CommonJS require() in the output makes Electron fail with\n' +
      '  "require is not defined in ES module scope", so window.slipstream never loads\n' +
      '  and every backend call silently no-ops. Check vite.config.ts preload build\n' +
      '  config and any newly added preload dependency that might force a CJS emit.',
  )
  process.exit(1)
}

console.log('✔ dist-electron/preload.mjs is valid ESM (no bare require() calls)')

#!/usr/bin/env node
/**
 * Post-build check: assert dist-electron/preload.cjs is valid CommonJS.
 *
 * The preload is emitted as preload.cjs and loaded by Electron under
 * sandbox: true (main.ts + vite.config.ts forcing output.format 'cjs' /
 * entryFileNames '[name].cjs' for the preload build — package.json has
 * "type": "module", so the .cjs extension is what forces CJS loading despite
 * that). Electron's sandboxed preload loader requires CommonJS; if the
 * bundler ever emits a top-level ESM `import`/`export` into it, Electron
 * fails to load the preload and window.slipstream never loads — Add repo/
 * everything silently no-ops.
 *
 * This invariant used to guard ESM output (preload.mjs, sandbox: false,
 * check-preload-esm.mjs). FLO-84 flipped it: the preload was trimmed down to
 * just the --slipstream-daemon arg parse + folder-picker bridge, so it was
 * compiled to CJS instead to restore the Chromium sandbox. This script now
 * asserts the opposite invariant — CJS, not ESM — same post-build slot (run
 * in the GitLab CI `build` job and in scripts/deploy.sh Phase 2).
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const preloadPath = path.join(root, 'dist-electron', 'preload.cjs')

if (!existsSync(preloadPath)) {
  console.error(
    `✗ ${path.relative(root, preloadPath)} does not exist.\n` +
      '  Run `pnpm build` before this check — it verifies the build output, not source.',
  )
  process.exit(1)
}

const src = readFileSync(preloadPath, 'utf8')

// Top-level ESM import/export would make Electron fail to load the preload as
// CommonJS. require('electron') in the output is expected/fine — sandboxed
// preloads whitelist it — so we only reject on import/export syntax.
if (/^\s*(import|export)[\s{*]/m.test(src)) {
  console.error(
    '✗ dist-electron/preload.cjs contains a top-level ESM import/export statement.\n' +
      '  Electron loads preload.cjs as CommonJS (sandbox: true + output.format "cjs" +\n' +
      '  entryFileNames "[name].cjs" in vite.config.ts). Top-level import/export in the\n' +
      '  output makes Electron fail to load the preload, so window.slipstream never\n' +
      '  loads and every backend call silently no-ops. Check vite.config.ts preload\n' +
      '  build config and any newly added preload dependency that might force an ESM\n' +
      '  emit.',
  )
  process.exit(1)
}

console.log('✔ dist-electron/preload.cjs is valid CommonJS (no top-level import/export)')

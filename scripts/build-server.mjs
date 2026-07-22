#!/usr/bin/env node
/**
 * Build electron/server/server.ts → dist-electron/server.js using esbuild.
 * Mirrors the externals used for the Electron main process build in vite.config.ts.
 */
import { build } from 'esbuild'
import { builtinModules } from 'node:module'
import { getBuildMeta } from './lib/buildMeta.mjs'

const external = [
  'electron',
  'better-sqlite3',
  'node-pty',
  'ws',
  'web-push',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]

const { version, gitSha } = getBuildMeta()
// Stamps __APP_VERSION__/__APP_GIT_HASH__ into the daemon bundle — this is
// the same server.js the Electron app spawns as a child process AND what the
// pod Docker image runs directly, so this one define covers both surfaces.
// See docs/VERSIONING.md.
const define = {
  __APP_VERSION__: JSON.stringify(version),
  __APP_GIT_HASH__: JSON.stringify(gitSha),
}

await build({
  entryPoints: ['electron/server/server.ts'],
  outfile: 'dist-electron/server.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  external,
  define,
  sourcemap: true,
})

console.log('Built dist-electron/server.js')

await build({
  entryPoints: ['electron/cli/slipstream.ts'],
  outfile: 'dist-electron/slipstream-cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  external,
  sourcemap: true,
})

console.log('Built dist-electron/slipstream-cli.js')

await build({
  entryPoints: ['electron/cli/manageTokens.ts'],
  outfile: 'dist-electron/manage-tokens.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  external,
  sourcemap: true,
})

console.log('Built dist-electron/manage-tokens.js')

#!/usr/bin/env node
/**
 * Build electron/server/server.ts → dist-electron/server.js using esbuild.
 * Mirrors the externals used for the Electron main process build in vite.config.ts.
 */
import { build } from 'esbuild'
import { builtinModules } from 'node:module'

const external = [
  'electron',
  'better-sqlite3',
  'node-pty',
  'ws',
  'web-push',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]

await build({
  entryPoints: ['electron/server/server.ts'],
  outfile: 'dist-electron/server.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  external,
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

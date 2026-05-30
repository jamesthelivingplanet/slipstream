import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import electron from 'vite-plugin-electron/simple'
import { builtinModules } from 'node:module'

// Native / node modules must NOT be bundled into the main process — node-pty and
// better-sqlite3 dynamically require their .node binaries at runtime, which a
// bundler can't resolve. Externalize them (and node built-ins) so main.js
// `require`s them from node_modules instead.
const external = [
  'electron',
  'better-sqlite3',
  'node-pty',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]

export default defineConfig({
  plugins: [
    svelte(),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: { build: { rollupOptions: { external } } },
      },
      preload: {
        input: 'electron/preload.ts',
        vite: { build: { rollupOptions: { external } } },
      },
      renderer: {},
    }),
  ],
})

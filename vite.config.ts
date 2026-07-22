import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import electron from 'vite-plugin-electron/simple'
import { builtinModules } from 'node:module'
import { getBuildMeta } from './scripts/lib/buildMeta.mjs'

const { version, gitSha } = getBuildMeta()

// Native / node modules must NOT be bundled into the main process — node-pty and
// better-sqlite3 dynamically require their .node binaries at runtime, which a
// bundler can't resolve. Externalize them (and node built-ins) so main.js
// `require`s them from node_modules instead.
const external = [
  'electron',
  'better-sqlite3',
  'node-pty',
  'web-push',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __APP_GIT_HASH__: JSON.stringify(gitSha),
  },
  plugins: [
    svelte(),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: { build: { rollupOptions: { external, output: { format: 'es' } } } },
      },
      preload: {
        input: 'electron/preload.ts',
        vite: {
          build: {
            rollupOptions: {
              external,
              // CJS (not ESM) so the preload can load with sandbox: true — Electron's
              // sandboxed preload loader requires CommonJS. package.json has
              // "type": "module", so the .cjs extension is required to force Node/
              // Electron to treat this one file as CommonJS despite that.
              output: { format: 'cjs', entryFileNames: '[name].cjs' },
            },
          },
        },
      },
      renderer: {},
    }),
  ],
})

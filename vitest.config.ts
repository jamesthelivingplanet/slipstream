import { defineConfig } from 'vitest/config'
import { getBuildMeta } from './scripts/lib/buildMeta.mjs'

const { version, gitSha } = getBuildMeta()

// Standalone config so unit tests don't run through the Electron Vite plugins
// (which rewrite node built-ins like child_process into require-based shims).
// `define` mirrors vite.config.ts/scripts/build-server.mjs so code under test
// that references __APP_VERSION__/__APP_GIT_HASH__ (see electron/shared/version.ts)
// sees real values instead of throwing.
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __APP_GIT_HASH__: JSON.stringify(gitSha),
  },
  test: {
    environment: 'node',
    include: ['electron/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary', 'cobertura'],
      reportsDirectory: 'coverage',
      include: ['electron/**', 'src/**'],
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
        'scripts/**',
        '**/*.config.*',
        'dist/**',
        'dist-electron/**',
        'node_modules/**',
        'release/**',
        'out/**',
      ],
    },
  },
})

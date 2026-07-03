import { defineConfig } from 'vitest/config'

// Standalone config so unit tests don't run through the Electron Vite plugins
// (which rewrite node built-ins like child_process into require-based shims).
export default defineConfig({
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

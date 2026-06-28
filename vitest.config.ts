import { defineConfig } from 'vitest/config'

// Standalone config so unit tests don't run through the Electron Vite plugins
// (which rewrite node built-ins like child_process into require-based shims).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['electron/**/*.test.ts', 'src/**/*.test.ts'],
    reporters: [
      'default',
      ['tdd-guard-vitest', { projectRoot: '/home/jamesthelivingplanet/.repositories/slipstream' }],
    ],
  },
})

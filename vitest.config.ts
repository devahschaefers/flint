import { defineConfig } from 'vitest/config'

/**
 * Main-process unit tests. They run under plain Node: better-sqlite3 ships
 * Node-API prebuilds, so the same binary serves Electron and the test run.
 * Electron's own modules are replaced in the setup file.
 */
export default defineConfig({
  test: {
    include: ['src/main/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['src/main/__tests__/setup.ts']
  }
})

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The SQLite driver is loaded inside a worker; keep test files isolated in forks.
    pool: 'forks'
  }
})

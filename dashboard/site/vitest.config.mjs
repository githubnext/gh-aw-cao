import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    pool: 'vmThreads',
    setupFiles: ['./test/setup.js'],
    projects: [
      {
        extends: true,
        test: {
          name: 'dashboard',
          environment: 'jsdom',
          include: ['test/unit/**/*.test.js'],
          exclude: ['test/unit/audit-curation.test.js']
        }
      },
      {
        extends: true,
        test: {
          name: 'audit-curation',
          include: ['test/unit/audit-curation.test.js'],
          // Large fake-indexeddb cursor scans are substantially slower in VM workers.
          pool: 'forks'
        }
      }
    ]
  }
});

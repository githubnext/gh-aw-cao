import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.js'],
    environment: 'node',
    pool: 'vmThreads',
    setupFiles: ['./test/setup.js']
  }
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.js', 'test/**/*.test.js'],
    // The ILP solver can take several seconds per multi-lineup run
    testTimeout: 60000,
  },
});

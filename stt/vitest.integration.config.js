import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.js'],
    testTimeout: 60_000,
  },
});

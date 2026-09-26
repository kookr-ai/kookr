import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: { KOOKR_STT_CORPUS: 'false' },
    include: ['src/**/*.integration.test.js'],
    testTimeout: 60_000,
  },
});

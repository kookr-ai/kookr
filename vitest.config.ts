import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts', 'src/**/*-e2e.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/frontend/**', 'src/server/start.ts'],
      reporter: ['text', 'text-summary', 'html', 'lcov', 'json-summary'],
      reportOnFailure: true,
      reportsDirectory: 'coverage',
    },
  },
});

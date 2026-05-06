import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testIgnore: process.env.CANARY ? [] : ['**/canary.spec.ts'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  reporter: process.env.CI ? 'html' : 'list',
  timeout: 15_000,
  // 10s expect timeout (default 5s) — covers cold-render polls on 2-vCPU CI runners
  // for `.finding-card` toHaveCount assertions injected via /api/test/inject-event.
  // See issue #30: GH Actions ubuntu-latest hits the 5s budget on slow renders while
  // local multi-core machines pass comfortably.
  expect: { timeout: 10_000 },
  use: {
    // baseURL is set per-worker by e2e/fixtures.ts (ephemeral port)
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: process.env.CI ? ['--disable-dev-shm-usage'] : [],
        },
      },
    },
  ],
  // No webServer — each worker spawns its own server via the fixture in e2e/fixtures.ts
});

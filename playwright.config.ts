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
    //
    // Locally `retries` is 0, so `on-first-retry` never fires and a contributor
    // reproducing a failure gets no trace. Opt in with `KOOKR_E2E_TRACE=1` to
    // retain a `trace.zip` (and screenshots) under `test-results/` on any
    // failure — inspect with `pnpm exec playwright show-trace <trace.zip>`.
    // The env is unset by default, so default local behavior (no trace) and
    // default CI behavior/cost (`on-first-retry`, one retry) are unchanged.
    trace: process.env.KOOKR_E2E_TRACE ? 'retain-on-failure' : 'on-first-retry',
    screenshot: process.env.KOOKR_E2E_TRACE ? 'only-on-failure' : 'off',
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

import { defineConfig } from '@playwright/test';

/**
 * POC-local Playwright config. Independent from the repo's main e2e config
 * so this spike can be run standalone (`pnpm test:poc-mouse`).
 */
export default defineConfig({
  testDir: '.',
  testMatch: /(mouse-forwarding|kookr-scroll)\.spec\.ts$/,
  timeout: 30_000,
  retries: 0,
  workers: 1, // each test spawns its own backend on a shared port — serialize
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    headless: true,
    viewport: { width: 1200, height: 800 },
    ignoreHTTPSErrors: true,
    actionTimeout: 5_000,
  },
});

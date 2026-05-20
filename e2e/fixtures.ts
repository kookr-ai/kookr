/**
 * Per-worker server fixture for parallel E2E tests.
 *
 * Each Playwright worker spawns its own test-server on an ephemeral port (E2E_PORT=0).
 * The fixture reads the actual port from stdout and overrides `baseURL` so that
 * `page.goto('/')` and `request.post('/api/...')` hit the right server.
 *
 * Spec files import `{ test, expect }` from this module instead of `@playwright/test`.
 */
import { test as base, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { STORAGE_KEY as ONBOARDING_STORAGE_KEY } from '../src/frontend/store/onboarding-status.js';

export const test = base.extend<{ suppressOnboarding: boolean }, { serverURL: string }>({
  // Test-level option: when true (default), the fixture pre-marks the
  // onboarding tour as seen so its overlay does not intercept clicks meant
  // for other dialogs. The tour's own spec sets this to false.
  suppressOnboarding: [true, { option: true }],

  // Worker-scoped: one server per Playwright worker process
  serverURL: [async ({}, use) => {
    const proc: ChildProcess = spawn(
      'node',
      ['--import', 'tsx', join(__dirname, 'test-server.ts')],
      {
        env: { ...process.env, E2E_PORT: '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    // Wait for the server to print `E2E_PORT=<number>` on stdout.
    const port = await new Promise<number>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error(
          `Test server did not start within 15 s.\nstdout: ${stdout}\nstderr: ${stderr}`,
        ));
      }, 15_000);

      proc.stdout!.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        const match = stdout.match(/E2E_PORT=(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(Number(match[1]));
        }
      });

      proc.stderr!.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      proc.on('exit', (code) => {
        if (!stdout.includes('E2E_PORT=')) {
          clearTimeout(timeout);
          reject(new Error(
            `Test server exited (code ${code}) before ready.\nstdout: ${stdout}\nstderr: ${stderr}`,
          ));
        }
      });
    });

    await use(`http://127.0.0.1:${port}`);

    // Teardown: graceful stop then force-kill
    proc.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, 5_000);
      proc.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }, { scope: 'worker' }],

  // Override Playwright's built-in baseURL so page/request use the per-worker server
  baseURL: async ({ serverURL }, use) => {
    await use(serverURL);
  },

  // Default: pre-mark the onboarding tour as seen so its overlay does not
  // intercept clicks in other tests' flows. The tour's own spec opts out via
  // `test.use({ suppressOnboarding: false })`.
  page: async ({ page, suppressOnboarding }, use) => {
    if (suppressOnboarding) {
      await page.addInitScript((storageKey) => {
        try {
          window.localStorage.removeItem('kookr:projectSidebarCatalog');
          window.localStorage.removeItem('kookr:projectSidebarPrefs');
          window.localStorage.setItem(storageKey, 'true');
        }
        catch { /* ignore */ }
      }, ONBOARDING_STORAGE_KEY);
    }
    await use(page);
  },
});

export { expect };

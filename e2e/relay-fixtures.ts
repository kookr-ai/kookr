import { test as base, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { STORAGE_KEY as ONBOARDING_STORAGE_KEY } from '../src/frontend/store/onboarding-status.js';

export const test = base.extend<{ suppressOnboarding: boolean }, { serverURL: string }>({
  suppressOnboarding: [true, { option: true }],

  serverURL: [async ({}, use) => {
    const proc: ChildProcess = spawn(
      'node',
      ['--import', 'tsx', join(__dirname, 'test-server.ts')],
      {
        env: {
          ...process.env,
          E2E_PORT: '0',
          E2E_WITH_RELAY: '1',
          KOOKR_RELAY_TRUSTED: 'true',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    const port = await new Promise<number>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error(
          `Relay test server did not start within 15 s.\nstdout: ${stdout}\nstderr: ${stderr}`,
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
            `Relay test server exited (code ${code}) before ready.\nstdout: ${stdout}\nstderr: ${stderr}`,
          ));
        }
      });
    });

    await use(`http://127.0.0.1:${port}`);

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

  baseURL: async ({ serverURL }, use) => {
    await use(serverURL);
  },

  page: async ({ page, suppressOnboarding }, use) => {
    if (suppressOnboarding) {
      await page.addInitScript((onboardingStorageKey) => {
        try {
          window.localStorage.removeItem('kookr:projectSidebarCatalog');
          window.localStorage.removeItem('kookr:projectSidebarPrefs');
          window.localStorage.setItem(onboardingStorageKey, 'true');
        } catch { /* ignore */ }
      }, ONBOARDING_STORAGE_KEY);
    }
    await use(page);
  },
});

export { expect };

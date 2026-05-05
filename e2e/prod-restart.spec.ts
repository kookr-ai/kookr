/**
 * E2E tests for build version info display and server restart mechanics.
 *
 * - Build info UI: verifies the TopBar badge and popover show real commit data
 * - Restart: verifies the `kill $(lsof -ti:PORT)` approach works to restart
 *   the server, preserving build info with a new serverStartedAt
 */
import { test, expect } from './fixtures.js';
import type { APIRequestContext } from '@playwright/test';
import { execSync, spawn, type ChildProcess } from 'node:child_process';


async function resetServer(request: APIRequestContext) {
  await request.post('/api/test/reset');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Build version info (API + UI) ─────────────────────────────────────

test.describe('Build version info', () => {
  test.beforeEach(async ({ request }) => {
    await resetServer(request);
  });

  test('health endpoint returns build metadata and serverStartedAt', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.ok()).toBe(true);
    const data = await res.json();

    expect(data.build).toBeDefined();
    expect(data.build.commitHash).toMatch(/^[0-9a-f]{40}$/);
    expect(data.build.commitShort).toMatch(/^[0-9a-f]{7,}$/);
    expect(data.build.commitShort).not.toBe('dev');
    expect(data.build.buildTimestamp).toBeTruthy();
    expect(data.build.version).toBeTruthy();

    expect(data.serverStartedAt).toBeTruthy();
    expect(new Date(data.serverStartedAt).getTime()).not.toBeNaN();
  });

  test('TopBar badge shows commit hash, not DEV', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');

    const badge = page.locator('.version-badge');
    await expect(badge).toBeVisible();
    await expect(badge).not.toHaveClass(/\bdev\b/);

    const text = await badge.textContent();
    expect(text).toMatch(/[0-9a-f]{7}/);
    expect(text).not.toContain('DEV');
  });

  test('clicking badge opens popover with full build details', async ({ page }) => {
    await page.goto('/');
    await page.locator('.version-badge').click();

    const popover = page.locator('.version-popover');
    await expect(popover).toBeVisible();
    await expect(popover.locator('.version-label').filter({ hasText: 'Commit' })).toBeVisible();
    await expect(popover.locator('.version-label').filter({ hasText: 'Branch' })).toBeVisible();
    await expect(popover.locator('.version-label').filter({ hasText: 'Built' })).toBeVisible();
    await expect(popover.locator('.version-label').filter({ hasText: 'Version' })).toBeVisible();
    // Must not show the dev-mode fallback
    await expect(popover.getByText('dev mode')).not.toBeVisible();
  });

  test('popover closes on outside click', async ({ page }) => {
    await page.goto('/');
    await page.locator('.version-badge').click();
    await expect(page.locator('.version-popover')).toBeVisible();

    await page.locator('.topbar-right').click();
    await expect(page.locator('.version-popover')).not.toBeVisible();
  });
});

// ─── Server restart via lsof kill ───────────────────────────────────────

test.describe('Server restart via lsof kill', () => {
  // Dedicated port — separate from the Playwright webServer (4802)
  const PORT = 4803;
  const URL = `http://127.0.0.1:${PORT}`;
  let proc: ChildProcess | null = null;

  function killPort() {
    try {
      execSync(`kill $(lsof -ti:${PORT}) 2>/dev/null`, { stdio: 'pipe' });
    } catch {
      // nothing listening — fine
    }
  }

  function startServer(): ChildProcess {
    return spawn('node', ['--import', 'tsx', 'e2e/test-server.ts'], {
      env: { ...process.env, E2E_PORT: String(PORT) },
      stdio: 'pipe',
    });
  }

  async function waitForUp(timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${URL}/api/health`);
        if (r.ok) return;
      } catch {}
      await sleep(250);
    }
    throw new Error(`Server on port ${PORT} not healthy within ${timeoutMs}ms`);
  }

  async function waitForDown(timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await fetch(`${URL}/api/health`);
      } catch {
        return; // connection refused → server is down
      }
      await sleep(250);
    }
    throw new Error(`Server on port ${PORT} still alive after ${timeoutMs}ms`);
  }

  test.afterEach(() => {
    if (proc && !proc.killed) proc.kill('SIGTERM');
    killPort();
  });

  test('kill + restart yields healthy server with new serverStartedAt', async () => {
    test.setTimeout(30_000);

    // Ensure port is free from any prior failed run
    killPort();
    await sleep(500);

    // Start initial server
    proc = startServer();
    await waitForUp();

    // Capture initial state
    const before = await fetch(`${URL}/api/health`).then((r) => r.json()) as {
      build: { commitHash: string; commitShort: string };
      serverStartedAt: string;
    };
    expect(before.build).toBeDefined();
    expect(before.build.commitShort).not.toBe('dev');
    expect(before.serverStartedAt).toBeTruthy();

    // Kill using the exact same approach as prod:restart
    execSync(`kill $(lsof -ti:${PORT})`, { stdio: 'pipe' });
    await waitForDown();

    // Restart on same port
    proc = startServer();
    await waitForUp();

    // Verify: same build info, new serverStartedAt
    const after = await fetch(`${URL}/api/health`).then((r) => r.json()) as typeof before;
    expect(after.build.commitHash).toBe(before.build.commitHash);
    expect(after.build.commitShort).toBe(before.build.commitShort);
    expect(after.serverStartedAt).not.toBe(before.serverStartedAt);
    expect(new Date(after.serverStartedAt).getTime()).toBeGreaterThan(
      new Date(before.serverStartedAt).getTime(),
    );
  });
});

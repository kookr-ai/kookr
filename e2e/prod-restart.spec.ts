/**
 * E2E tests for build version info display and server restart mechanics.
 *
 * - Build info UI: verifies the TopBar badge and popover show real commit data
 * - Restart: verifies the `kill $(lsof -tiTCP:PORT -sTCP:LISTEN)` approach works to restart
 *   the server, preserving build info with a new serverStartedAt
 */
import { test, expect } from './fixtures.js';
import { resetServer } from './reset-server.js';
import { sanitizedChildServerEnv } from './child-server-env.js';
import { execSync, spawn, type ChildProcess } from 'node:child_process';

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

    await page.mouse.click(10, 10);
    await expect(page.locator('.version-popover')).not.toBeVisible();
  });
});

// ─── Server restart via lsof kill ───────────────────────────────────────

test.describe('Server restart via lsof kill', () => {
  let proc: ChildProcess | null = null;
  let currentPort: number | null = null;

  function killPort() {
    if (currentPort === null) return;
    try {
      execSync(`kill $(lsof -tiTCP:${currentPort} -sTCP:LISTEN) 2>/dev/null`, { stdio: 'pipe' });
    } catch {
      // nothing listening — fine
    }
  }

  function startServer(port: number | '0'): ChildProcess {
    return spawn('node', ['--import', 'tsx', 'e2e/test-server.ts'], {
      env: sanitizedChildServerEnv({ E2E_PORT: String(port) }),
      stdio: 'pipe',
    });
  }

  async function waitForStartedPort(child: ChildProcess, timeoutMs = 15_000): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(
          `Test server did not start within ${timeoutMs}ms.\nstdout: ${stdout}\nstderr: ${stderr}`,
        ));
      }, timeoutMs);

      child.stdout!.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        const match = stdout.match(/E2E_PORT=(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(Number(match[1]));
        }
      });

      child.stderr!.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('exit', (code) => {
        if (!stdout.includes('E2E_PORT=')) {
          clearTimeout(timeout);
          reject(new Error(
            `Test server exited with code ${code} before ready.\nstdout: ${stdout}\nstderr: ${stderr}`,
          ));
        }
      });
    });
  }

  async function waitForUp(port: number, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    const url = `http://127.0.0.1:${port}`;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${url}/api/health`);
        if (r.ok) return;
      } catch {}
      await sleep(250);
    }
    throw new Error(`Server on port ${port} not healthy within ${timeoutMs}ms`);
  }

  async function waitForDown(port: number, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    const url = `http://127.0.0.1:${port}`;
    while (Date.now() < deadline) {
      try {
        await fetch(`${url}/api/health`);
      } catch {
        return; // connection refused → server is down
      }
      await sleep(250);
    }
    throw new Error(`Server on port ${port} still alive after ${timeoutMs}ms`);
  }

  test.afterEach(() => {
    if (proc && !proc.killed) proc.kill('SIGTERM');
    killPort();
  });

  test('kill + restart yields healthy server with new serverStartedAt', async () => {
    test.setTimeout(30_000);

    // Ensure the previous dynamic port is free from any prior failed run
    killPort();

    // Start initial server on an OS-assigned port so this test cannot collide
    // with the per-worker fixture server.
    proc = startServer('0');
    currentPort = await waitForStartedPort(proc);
    await waitForUp(currentPort);
    const url = `http://127.0.0.1:${currentPort}`;

    // Capture initial state
    const before = await fetch(`${url}/api/health`).then((r) => r.json()) as {
      build: { commitHash: string; commitShort: string };
      serverStartedAt: string;
    };
    expect(before.build).toBeDefined();
    expect(before.build.commitShort).not.toBe('dev');
    expect(before.serverStartedAt).toBeTruthy();

    // Kill only the listening server process, matching prod:restart.
    execSync(`kill $(lsof -tiTCP:${currentPort} -sTCP:LISTEN)`, { stdio: 'pipe' });
    await waitForDown(currentPort);
    proc = null;

    // Restart on same port
    proc = startServer(currentPort);
    const restartedPort = await waitForStartedPort(proc);
    expect(restartedPort).toBe(currentPort);
    await waitForUp(currentPort);

    // Verify: same build info, new serverStartedAt
    const after = await fetch(`${url}/api/health`).then((r) => r.json()) as typeof before;
    expect(after.build.commitHash).toBe(before.build.commitHash);
    expect(after.build.commitShort).toBe(before.build.commitShort);
    expect(after.serverStartedAt).not.toBe(before.serverStartedAt);
    expect(new Date(after.serverStartedAt).getTime()).toBeGreaterThan(
      new Date(before.serverStartedAt).getTime(),
    );
  });
});

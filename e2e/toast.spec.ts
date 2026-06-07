import { test, expect } from './fixtures.js';
import { resetServer } from './reset-server.js';
import type { Page, APIRequestContext } from '@playwright/test';

/** Broadcast an info-level alert via the test server's WebSocket. */
async function broadcastInfoAlert(request: APIRequestContext, summary: string) {
  await request.post('/api/test/broadcast-alert', {
    data: { agentId: 'test-agent', summary, severity: 'info' },
  });
}

/** Broadcast a warning-level alert (maps to 'error' in frontend). */
async function broadcastWarningAlert(request: APIRequestContext, summary: string) {
  await request.post('/api/test/broadcast-alert', {
    data: { agentId: 'test-agent', summary, severity: 'warning' },
  });
}

/** Broadcast an error-level alert via the test server's WebSocket. */
async function broadcastErrorAlert(request: APIRequestContext, summary: string) {
  await request.post('/api/test/broadcast-alert', {
    data: { agentId: 'test-agent', summary, severity: 'critical' },
  });
}

/** Launch an agent via the UI dialog. */
async function launchViaUI(page: Page, prompt: string, cwd: string) {
  // Ensure WebSocket is connected before launching (CI can be slow to connect)
  await expect(page.locator('.health-dot-connected')).toBeVisible({ timeout: 5000 });
  await page.locator('.btn-launch').click();
  await page.locator('.dialog textarea').fill(prompt);
  const cwdInput = page.locator('.dialog input[type="text"]').first();
  await cwdInput.clear();
  await cwdInput.fill(cwd);
  await page.locator('.dialog .btn-primary').click();
  await expect(page.locator('.dialog')).not.toBeVisible();
}

async function injectSessionStart(request: APIRequestContext, tmuxName: string) {
  await request.post('/api/test/inject-event', {
    data: {
      tmuxName,
      event: {
        session_id: 'sess-test',
        transcript_path: '/tmp/transcript.jsonl',
        cwd: '/test/project',
        hook_event_name: 'SessionStart',
      },
    },
  });
}

async function injectStopEvent(request: APIRequestContext, tmuxName: string) {
  await request.post('/api/test/inject-event', {
    data: {
      tmuxName,
      event: {
        session_id: 'sess-test',
        transcript_path: '/tmp/transcript.jsonl',
        cwd: '/test/project',
        hook_event_name: 'Stop',
        stop_hook_active: true,
        last_assistant_message: 'Help needed.',
      },
    },
  });
}

async function getLatestTmuxName(request: APIRequestContext): Promise<string> {
  const res = await request.get('/api/tasks');
  const tasks = (await res.json()) as Array<{
    status: string;
    sessions: Array<{ tmuxSession: string }>;
  }>;
  const inProgress = tasks.filter((t) => t.status === 'inProgress');
  const last = inProgress[inProgress.length - 1];
  return last.sessions[last.sessions.length - 1].tmuxSession;
}

async function installClockAndReload(page: Page) {
  await page.clock.install({ time: new Date() });
  await page.goto('/');
  await expect(page.locator('.logo')).toHaveText('KOOKR');
  await expect(page.locator('.health-dot-connected')).toBeVisible({ timeout: 5000 });
}

test.describe('Toast notifications — auto-dismiss behavior', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('info toast has solid opaque background', async ({ page, request }) => {
    await broadcastInfoAlert(request, 'PR merged successfully');

    const toast = page.locator('.toast-info');
    await expect(toast).toBeVisible();

    const bg = await toast.evaluate((el) => getComputedStyle(el).backgroundColor);
    // #172033 = rgb(23, 32, 51) — must be solid, not transparent rgba
    expect(bg).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
  });

  test('error toast has solid opaque background', async ({ page, request }) => {
    await broadcastErrorAlert(request, 'Error: build failed');

    const toast = page.locator('.toast-error');
    await expect(toast).toBeVisible();

    const bg = await toast.evaluate((el) => getComputedStyle(el).backgroundColor);
    // #3d1214 = rgb(61, 18, 20) — must be solid
    expect(bg).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
  });

  test('info toast auto-dismisses after ~8 seconds', async ({ page, request }) => {
    // Install fake clock so we can fast-forward through timer waits
    await installClockAndReload(page);

    await broadcastInfoAlert(request, 'CI passed');

    const toast = page.locator('.toast-info');
    await expect(toast).toBeVisible();

    // Should still be visible at 6s
    await page.clock.fastForward(6_000);
    await expect(toast).toBeVisible();

    // Should be gone by 10s (8s timeout + margin)
    await page.clock.fastForward(4_000);
    await expect(toast).not.toBeVisible();
  });

  test('error toast auto-dismisses after ~15 seconds', async ({ page, request }) => {
    await installClockAndReload(page);

    await broadcastErrorAlert(request, 'Error: deployment failed');

    const toast = page.locator('.toast-error');
    await expect(toast).toBeVisible();

    // Should still be visible at 10s (before 15s timeout)
    await page.clock.fastForward(10_000);
    await expect(toast).toBeVisible();

    // Should be gone by 18s (15s timeout + margin)
    await page.clock.fastForward(8_000);
    await expect(toast).not.toBeVisible();
  });

  test('error toast can be manually dismissed before auto-dismiss', async ({ page, request }) => {
    await broadcastErrorAlert(request, 'Error: deployment failed');

    const toast = page.locator('.toast-error');
    await expect(toast).toBeVisible();

    await page.locator('.toast-dismiss').click();
    await expect(toast).not.toBeVisible();
  });

  test('warning-level PR alerts auto-dismiss (new review comment)', async ({ page, request }) => {
    await installClockAndReload(page);

    await broadcastWarningAlert(request, 'PR owner/repo#42: new review comment from @reviewer');

    // Warning maps to error severity in frontend
    const toast = page.locator('.toast-error');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('new review comment');

    // Should auto-dismiss by 18s (15s timeout + margin)
    await page.clock.fastForward(18_000);
    await expect(toast).not.toBeVisible();
  });

  test('info-level PR alerts auto-dismiss (PR merged)', async ({ page, request }) => {
    await installClockAndReload(page);

    await broadcastInfoAlert(request, 'PR owner/repo#42: merged');

    const toast = page.locator('.toast-info');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('merged');

    // Should be gone by 10s (8s timeout + margin)
    await page.clock.fastForward(10_000);
    await expect(toast).not.toBeVisible();
  });

  test('info-level PR alerts auto-dismiss (CI passed)', async ({ page, request }) => {
    await installClockAndReload(page);

    await broadcastInfoAlert(request, 'PR owner/repo#42: all CI checks passed');

    const toast = page.locator('.toast-info');
    await expect(toast).toBeVisible();

    await page.clock.fastForward(10_000);
    await expect(toast).not.toBeVisible();
  });

  test('warning-level PR alerts auto-dismiss (CI failed)', async ({ page, request }) => {
    await installClockAndReload(page);

    await broadcastWarningAlert(request, 'PR owner/repo#42: CI check "build" failed');

    const toast = page.locator('.toast-error');
    await expect(toast).toBeVisible();

    await page.clock.fastForward(18_000);
    await expect(toast).not.toBeVisible();
  });

  test('warning-level PR alerts auto-dismiss (changes requested)', async ({ page, request }) => {
    await installClockAndReload(page);

    await broadcastWarningAlert(request, 'PR owner/repo#42: @reviewer requested changes');

    const toast = page.locator('.toast-error');
    await expect(toast).toBeVisible();

    await page.clock.fastForward(18_000);
    await expect(toast).not.toBeVisible();
  });

  test('multiple toasts dismiss independently', async ({ page, request }) => {
    await installClockAndReload(page);

    await broadcastInfoAlert(request, 'PR merged');
    // Advance 1ms so each alert gets a unique timestamp key
    await page.clock.fastForward(1);
    await broadcastErrorAlert(request, 'Error: CI failed');

    const infoToast = page.locator('.toast-info');
    const errorToast = page.locator('.toast-error');

    await expect(infoToast).toBeVisible();
    await expect(errorToast).toBeVisible();

    // Info toast should dismiss first (~8s), error should remain
    await page.clock.fastForward(10_000);
    await expect(infoToast).not.toBeVisible();
    await expect(errorToast).toBeVisible();

    // Error toast should dismiss later (~15s)
    await page.clock.fastForward(8_000);
    await expect(errorToast).not.toBeVisible();
  });

  test('toasts do not overlap detail-header action buttons', async ({ page, request }) => {
    // Launch an agent and create a finding so detail panel shows
    await launchViaUI(page, 'Test overlap', '/test/project');
    await expect(page.locator('.statusbar')).toContainText('1 task', { timeout: 5000 });

    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    // Select finding to show detail panel with header buttons
    await page.locator('.finding-card').click();
    await expect(page.locator('.detail-header')).toBeVisible();

    // Broadcast a toast
    await broadcastInfoAlert(request, 'PR #42: new comment');

    // Scope by exact toast text — launchViaUI shows a "Starting task: …"
    // info toast that may still be on screen, so .toast-info alone is
    // not unique. See #57.
    const toast = page.locator('.toast-info', { hasText: 'PR #42: new comment' });
    await expect(toast).toBeVisible();

    // Get bounding boxes
    const toastBox = await toast.boundingBox();
    const headerBox = await page.locator('.detail-header').boundingBox();

    expect(toastBox).not.toBeNull();
    expect(headerBox).not.toBeNull();

    // Toast top edge must be at or below the detail-header bottom edge
    expect(toastBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height);
  });
});

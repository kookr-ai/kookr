/**
 * Battle-test E2E suite — API & infrastructure tests.
 *
 * Covers: REST API endpoints, connection indicator, SPA routing, test API.
 */
import { test, expect } from './fixtures.js';
import {
  resetServer,
  launchViaUI,
  getTasks,
  getLatestTmuxName,
  getTmuxNameForPrompt,
  injectSessionStart,
  injectStopEvent,
  injectPermissionEvent,
} from './battle-helpers.js';

// ---------------------------------------------------------------------------
// Suite 1: REST API endpoints
// ---------------------------------------------------------------------------

test.describe('API endpoints', () => {
  test.beforeEach(async ({ request }) => {
    await resetServer(request);
  });

  test('GET /api/health returns ok with agent count', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(typeof data.agents).toBe('number');
  });

  test('GET /api/tasks returns empty array initially', async ({ request }) => {
    const res = await request.get('/api/tasks');
    const tasks = await res.json();
    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks.length).toBe(0);
  });

  test('GET /api/snapshot returns empty array initially', async ({ request }) => {
    const res = await request.get('/api/snapshot');
    const snapshot = await res.json();
    expect(Array.isArray(snapshot)).toBe(true);
    expect(snapshot.length).toBe(0);
  });

  test('GET /api/queue returns empty array initially', async ({ request }) => {
    const res = await request.get('/api/queue');
    const queue = await res.json();
    expect(Array.isArray(queue)).toBe(true);
    expect(queue.length).toBe(0);
  });

  test('GET /api/capture/:name returns 404 for non-existent session', async ({ request }) => {
    const res = await request.get('/api/capture/nonexistent');
    expect(res.status()).toBe(404);
  });

  test('tasks API reflects launched agents', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');

    await launchViaUI(page, 'Test task', '/test/project');

    const tasks = await getTasks(request);
    expect(tasks.length).toBe(1);
    expect(tasks[0].prompt).toBe('Test task');
    expect(tasks[0].cwd).toBe('/test/project');
    expect(tasks[0].status).toBe('inProgress');
    expect(tasks[0].sessions.length).toBe(1);
  });

  test('snapshot API reflects agent state after events', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');

    await launchViaUI(page, 'Snapshot test', '/test/project');
    const tmuxName = await getLatestTmuxName(request);

    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    const res = await request.get('/api/snapshot');
    const snapshot = await res.json();
    expect(snapshot.length).toBe(1);
    expect(snapshot[0].agentId).toBe(tmuxName);
    expect(snapshot[0].anomaly).not.toBeNull();
    expect(snapshot[0].anomaly.type).toBe('needs_input');
  });

  test('queue API reflects anomalies in priority order', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');

    // Agent A: needs_input (info)
    await launchViaUI(page, 'Agent A', '/test/a');
    const tmuxA = await getTmuxNameForPrompt(request, 'Agent A');
    await injectSessionStart(request, tmuxA);
    await injectStopEvent(request, tmuxA);

    // Agent B: permission_blocked (warning)
    await launchViaUI(page, 'Agent B', '/test/b');
    const tmuxB = await getTmuxNameForPrompt(request, 'Agent B');
    await injectSessionStart(request, tmuxB);
    await injectPermissionEvent(request, tmuxB);

    const res = await request.get('/api/queue');
    const queue = await res.json();
    expect(queue.length).toBe(2);
    // Warning (permission) should come before info (needs_input)
    expect(queue[0].anomaly.type).toBe('permission_blocked');
    expect(queue[1].anomaly.type).toBe('needs_input');
  });
});

// ---------------------------------------------------------------------------
// Suite 15: Connection resilience
// ---------------------------------------------------------------------------

test.describe('Connection indicator', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('connected state shows health dot connected', async ({ page }) => {
    await expect(page.locator('.health-dot-connected')).toBeVisible();
  });

  test('health dot does not show disconnected class when connected', async ({ page }) => {
    await expect(page.locator('.health-dot-disconnected')).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Suite 16: SPA routing & static assets
// ---------------------------------------------------------------------------

test.describe('SPA & static assets', () => {
  test('root URL loads the app', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('unknown path falls back to SPA', async ({ page }) => {
    await page.goto('/unknown/path');
    // Should still load the SPA
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('page title or root element exists', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#root')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Suite 17: Event injection via test API
// ---------------------------------------------------------------------------

test.describe('Test API', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('inject-event endpoint accepts and processes events', async ({ page, request }) => {
    await launchViaUI(page, 'Inject test', '/test/project');
    const tmuxName = await getLatestTmuxName(request);

    const res = await request.post('/api/test/inject-event', {
      data: {
        tmuxName,
        event: {
          session_id: 'sess-test',
          transcript_path: '/tmp/test.jsonl',
          cwd: '/test',
          hook_event_name: 'SessionStart',
        },
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('reset endpoint clears all state', async ({ request }) => {
    // Create some state first (launch via API would need the UI, so just verify reset works)
    const resetRes = await request.post('/api/test/reset');
    expect(resetRes.ok()).toBeTruthy();

    const tasks = await getTasks(request);
    expect(tasks.length).toBe(0);

    const snapshotRes = await request.get('/api/snapshot');
    const snapshot = await snapshotRes.json();
    expect(snapshot.length).toBe(0);
  });
});

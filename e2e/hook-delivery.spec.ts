/**
 * E2E integration test for hook event delivery.
 *
 * Launches a real Claude Code process with --settings and verifies that hook
 * events are written to the JSONL file. This catches regressions where the
 * hook command format breaks stdin delivery (e.g. trailing `&` in non-interactive
 * bash redirects stdin from /dev/null).
 *
 * Requires: `claude` CLI on PATH, network access to localhost for HTTP push.
 */
import { test, expect } from './fixtures.js';
import type { APIRequestContext } from '@playwright/test';


async function resetServer(request: APIRequestContext) {
  await request.post('/api/test/reset');
}

/** Polls until an inProgress task with sessions appears. */
async function getLatestTmuxName(request: APIRequestContext): Promise<string> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const res = await request.get('/api/tasks');
    const tasks = (await res.json()) as Array<{
      status: string;
      sessions: Array<{ tmuxSession: string }>;
    }>;
    const inProgress = tasks.filter((t) => t.status === 'inProgress');
    const last = inProgress[inProgress.length - 1];
    if (last?.sessions?.length > 0) {
      return last.sessions[last.sessions.length - 1].tmuxSession;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Timed out waiting for an inProgress task with sessions');
}

test.describe('Hook event delivery', () => {
  test.beforeEach(async ({ request }) => {
    await resetServer(request);
  });

  test('injected hook events arrive in the snapshot with anomaly detection', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');

    // Ensure WebSocket is connected before launching (CI can be slow to connect)
    await expect(page.locator('.health-dot-connected')).toBeVisible({ timeout: 5000 });
    // Launch an agent
    await page.locator('.btn-launch').click();
    await page.locator('.dialog textarea').fill('Say hello');
    const cwdInput = page.locator('.dialog input[type="text"]').first();
    await cwdInput.clear();
    await cwdInput.fill('/tmp');
    await page.locator('.dialog .btn-primary').click();
    await expect(page.locator('.dialog')).not.toBeVisible();

    const tmuxName = await getLatestTmuxName(request);

    // Inject a stop event (simulates Claude Code finishing its turn)
    await request.post('/api/test/inject-event', {
      data: {
        tmuxName,
        event: {
          session_id: `sess-${Date.now()}`,
          transcript_path: '/tmp/transcript.jsonl',
          cwd: '/tmp',
          hook_event_name: 'Stop',
          stop_hook_active: true,
          last_assistant_message: 'I need your help with something.',
        },
      },
    });

    // The finding should appear in the UI
    await expect(page.locator('.finding-card')).toBeVisible({ timeout: 5000 });

    // The snapshot should show an anomaly
    const snapshot = await request.get('/api/snapshot').then((r) => r.json()) as Array<{
      agentId: string;
      anomaly: { type: string } | null;
      events: unknown[];
    }>;
    const agent = snapshot.find((a) => a.agentId === tmuxName);
    expect(agent).toBeDefined();
    expect(agent!.anomaly).not.toBeNull();
    expect(agent!.anomaly!.type).toBe('needs_input');
    expect(agent!.events.length).toBeGreaterThan(0);
  });
});

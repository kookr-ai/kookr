import { test, expect } from './fixtures.js';
import { resetServer } from './reset-server.js';
import type { Page, APIRequestContext } from '@playwright/test';

async function getLatestUnseenTmuxName(request: APIRequestContext, seen: Set<string>): Promise<string> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const res = await request.get('/api/tasks');
    const tasks = (await res.json()) as Array<{
      status: string;
      sessions: Array<{ tmuxSession: string }>;
    }>;
    const inProgress = tasks.filter((t) => t.status === 'inProgress');
    for (let i = inProgress.length - 1; i >= 0; i--) {
      const task = inProgress[i];
      for (let j = task.sessions.length - 1; j >= 0; j--) {
        const tmuxName = task.sessions[j].tmuxSession;
        if (!seen.has(tmuxName)) return tmuxName;
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Timed out waiting for an inProgress task with sessions');
}

async function injectEvent(request: APIRequestContext, tmuxName: string, event: Record<string, unknown>) {
  await request.post('/api/test/inject-event', { data: { tmuxName, event } });
}

async function injectSessionStart(request: APIRequestContext, tmuxName: string) {
  await injectEvent(request, tmuxName, {
    session_id: `sess-${Date.now()}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/test/project',
    hook_event_name: 'SessionStart',
  });
}

async function injectStopEvent(request: APIRequestContext, tmuxName: string) {
  await injectEvent(request, tmuxName, {
    session_id: `sess-${Date.now()}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/test/project',
    hook_event_name: 'Stop',
    stop_hook_active: true,
    last_assistant_message: 'I need your help.',
  });
}

async function launchViaUI(page: Page, prompt: string, cwd: string) {
  await expect(page.locator('.health-dot-connected')).toBeVisible({ timeout: 5000 });
  await page.locator('.btn-launch').click();
  await page.locator('.dialog textarea').fill(prompt);
  const cwdInput = page.locator('.dialog input[type="text"]').first();
  await cwdInput.clear();
  await cwdInput.fill(cwd);
  await page.locator('.dialog .btn-primary').click();
  await expect(page.locator('.dialog')).not.toBeVisible();
}

test.describe('Findings rail name filter (issue #3125)', () => {
  const assigned: string[] = [];
  const seen = new Set<string>();

  /** Launch a needs_input finding, then rename its card to a deterministic name. */
  async function launchNamedFinding(page: Page, request: APIRequestContext, name: string) {
    await launchViaUI(page, `seed prompt ${assigned.length + 1}`, '/test/project');
    const tmux = await getLatestUnseenTmuxName(request, seen);
    seen.add(tmux);
    await injectSessionStart(request, tmux);
    await injectStopEvent(request, tmux);
    await expect(page.locator('.finding-card')).toHaveCount(assigned.length + 1, { timeout: 5000 });

    // The one card not yet renamed to any of our known names.
    let target = page.locator('.finding-card .finding-task');
    for (const prior of assigned) target = target.filter({ hasNotText: prior });
    await expect(target).toHaveCount(1);
    await target.dblclick();
    const editInput = page.locator('.finding-task-edit');
    await expect(editInput).toBeVisible();
    await editInput.fill(name);
    await editInput.press('Enter');
    await expect(page.locator('.finding-task', { hasText: name })).toBeVisible({ timeout: 5000 });
    assigned.push(name);
  }

  test.beforeEach(async ({ page, request }) => {
    assigned.length = 0;
    seen.clear();
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('free-text box filters the rail by name, composes, persists, and shows an empty state', async ({ page, request }) => {
    await launchNamedFinding(page, request, 'Alpha login task');
    await launchNamedFinding(page, request, 'Beta search task');

    const input = page.locator('[data-testid="findings-name-filter-input"]');
    await expect(input).toBeVisible();
    await expect(page.locator('.finding-card')).toHaveCount(2);

    // Case-insensitive substring narrows the rail to the matching card.
    await input.fill('ALPHA');
    await expect(page.locator('.finding-card')).toHaveCount(1);
    await expect(page.locator('.finding-task', { hasText: 'Alpha login task' })).toBeVisible();

    // A no-match query shows a clear empty state and no cards.
    await input.fill('zzz-none');
    await expect(page.locator('.finding-card')).toHaveCount(0);
    await expect(page.locator('[data-testid="findings-name-filter-empty"]')).toBeVisible();

    // Clearing restores the full list.
    await input.fill('');
    await expect(page.locator('.finding-card')).toHaveCount(2);

    // Persists across reload like the type filter.
    await input.fill('beta');
    await expect(page.locator('.finding-card')).toHaveCount(1);
    await page.reload();
    await expect(page.locator('.logo')).toHaveText('KOOKR');
    await expect(page.locator('[data-testid="findings-name-filter-input"]')).toHaveValue('beta');
    await expect(page.locator('.finding-card')).toHaveCount(1);
    await expect(page.locator('.finding-task', { hasText: 'Beta search task' })).toBeVisible();
  });
});

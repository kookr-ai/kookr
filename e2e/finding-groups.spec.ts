import { test, expect } from './fixtures.js';
import { resetServer } from './reset-server.js';
import type { Page, APIRequestContext } from '@playwright/test';

async function getLatestTmuxName(request: APIRequestContext): Promise<string> {
  return getLatestUnseenTmuxName(request, new Set());
}

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

async function injectEvent(
  request: APIRequestContext,
  tmuxName: string,
  event: Record<string, unknown>,
) {
  await request.post('/api/test/inject-event', {
    data: { tmuxName, event },
  });
}

async function injectPermissionEvent(request: APIRequestContext, tmuxName: string, command = 'npm install') {
  await injectEvent(request, tmuxName, {
    session_id: `sess-${Date.now()}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/test/project',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command },
    permission_mode: 'default',
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

async function waitForAgentCount(page: Page, count: number) {
  await expect(page.locator('.statusbar')).toContainText(`${count} task`, { timeout: 5000 });
}

/** Launch N agents with permission_blocked anomaly. Returns tmux names. */
async function setupPermissionGroup(page: Page, request: APIRequestContext, count: number) {
  const tmuxNames: string[] = [];
  const seen = new Set<string>();
  for (let i = 1; i <= count; i++) {
    await launchViaUI(page, `Task ${i}`, '/test/project');
    const tmux = await getLatestUnseenTmuxName(request, seen);
    await injectPermissionEvent(request, tmux);
    tmuxNames.push(tmux);
    seen.add(tmux);
  }
  await waitForAgentCount(page, count);
  await expect(page.locator('.finding-group')).toBeVisible({ timeout: 5000 });
  return tmuxNames;
}

test.describe('Finding Groups — duplicate anomaly grouping', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('3+ findings with same anomaly type are grouped with expand/collapse', async ({ page, request }) => {
    await setupPermissionGroup(page, request, 3);

    // Group header visible with correct label
    await expect(page.locator('.finding-group-label')).toContainText('3 agents blocked on permission');

    // Collapsed by default — no individual cards
    await expect(page.locator('.finding-group .finding-card')).toHaveCount(0);

    // Expand by clicking the toggle
    await page.locator('.finding-group-toggle').click();
    await expect(page.locator('.finding-group .finding-card')).toHaveCount(3, { timeout: 3000 });

    // Collapse again
    await page.locator('.finding-group-toggle').click();
    await expect(page.locator('.finding-group .finding-card')).toHaveCount(0);
  });

  test('"Respond to All" opens detail panel with banner', async ({ page, request }) => {
    await setupPermissionGroup(page, request, 3);

    // Click "Respond to All"
    await page.locator('button.btn-primary-xs').click();

    // Banner visible in detail panel
    await expect(page.locator('.respond-all-banner')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('.respond-all-banner')).toContainText('Responding to 3 agents');

    // Send button shows batch count
    await expect(page.locator('[data-testid="send-button"]')).toContainText('Send to All (3)');

    // Cancel clears the banner
    await page.locator('.respond-all-banner .btn-xs').click();
    await expect(page.locator('.respond-all-banner')).not.toBeVisible();
    await expect(page.locator('[data-testid="send-button"]')).not.toContainText('Send to All');
  });

  test('ungrouped findings (<3 of same type) display as individual cards', async ({ page, request }) => {
    // 2 permission_blocked + 1 needs_input = 3 findings, none grouped
    const seen = new Set<string>();
    for (let i = 1; i <= 2; i++) {
      await launchViaUI(page, `Permission task ${i}`, '/test/project');
      const tmux = await getLatestUnseenTmuxName(request, seen);
      await injectPermissionEvent(request, tmux, `npm install ${i}`);
      seen.add(tmux);
    }
    await launchViaUI(page, 'Input task', '/test/project');
    const tmuxStop = await getLatestUnseenTmuxName(request, seen);
    await injectStopEvent(request, tmuxStop);

    await waitForAgentCount(page, 3);
    await expect(page.locator('.finding-card')).toHaveCount(3, { timeout: 10000 });

    // No groups — all individual
    await expect(page.locator('.finding-group')).not.toBeVisible();
  });

  test('mixed: some types grouped, others ungrouped', async ({ page, request }) => {
    // 3 permission_blocked (grouped) + 1 needs_input (ungrouped)
    const seen = new Set<string>();
    for (let i = 1; i <= 3; i++) {
      await launchViaUI(page, `Permission task ${i}`, '/test/project');
      const tmux = await getLatestUnseenTmuxName(request, seen);
      await injectPermissionEvent(request, tmux);
      seen.add(tmux);
    }
    await launchViaUI(page, 'Input task', '/test/project');
    const tmuxStop = await getLatestUnseenTmuxName(request, seen);
    await injectStopEvent(request, tmuxStop);

    await waitForAgentCount(page, 4);

    // 1 group + 1 individual card
    await expect(page.locator('.finding-group')).toHaveCount(1, { timeout: 5000 });
    await expect(page.locator('.findings-scroll-area > .finding-card')).toHaveCount(1);
    await expect(page.locator('.finding-group-label')).toContainText('3 agents blocked on permission');
  });
});

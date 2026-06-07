import { test, expect } from './fixtures.js';
import { resetServer } from './reset-server.js';
import type { APIRequestContext, Page } from '@playwright/test';


async function launchViaUI(page: Page, prompt: string, cwd = '/test/project') {
  await expect(page.locator('.health-dot-connected')).toBeVisible({ timeout: 5000 });
  await page.locator('.btn-launch').click();
  await page.locator('.dialog textarea').fill(prompt);
  const cwdInput = page.locator('.dialog input[type="text"]').first();
  await cwdInput.clear();
  await cwdInput.fill(cwd);
  await page.locator('.dialog .btn-primary').click();
  await expect(page.locator('.dialog')).not.toBeVisible();
}

async function taskByPrompt(request: APIRequestContext, prompt: string): Promise<{ id: string; prompt: string }> {
  const res = await request.get('/api/tasks');
  const tasks = await res.json() as Array<{ id: string; prompt: string }>;
  const task = tasks.find((candidate) => candidate.prompt === prompt);
  if (!task) throw new Error(`Task not found for prompt ${prompt}`);
  return task;
}

test.beforeEach(async ({ request, page }) => {
  await resetServer(request);
  await page.goto('/');
});

test('task chip appears for stale task and suppression survives reload', async ({ page, request }) => {
  await launchViaUI(page, 'Coordinator stale chip task');
  const task = await taskByPrompt(request, 'Coordinator stale chip task');

  await request.post(`/api/test/backdate-session/${task.id}`, { data: { minutesAgo: 45 } });
  const chip = page.locator('[data-testid="coordinator-chip-stale"]');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('Nudge');

  await chip.getByRole('button', { name: /Suppress stale/ }).click();
  await expect(chip).toHaveCount(0);

  await page.reload();
  await expect(page.locator('.health-dot-connected')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('[data-testid="coordinator-chip-stale"]')).toHaveCount(0);
});

test('chain strip renders for task lineage and click-time batch action fails visibly on unverifiable prior', async ({ page, request }) => {
  const parentRes = await request.post('/api/tasks', {
    data: { prompt: 'Coordinator parent task', cwd: '/test/project' },
  });
  const parent = await parentRes.json() as { id: string };
  await request.post('/api/tasks', {
    data: { prompt: 'Coordinator child task', cwd: '/test/project', parentTaskId: parent.id },
  });

  await page.reload();
  await expect(page.locator('.health-dot-connected')).toBeVisible({ timeout: 5000 });
  await page.locator('.healthy-row', { hasText: 'Coordinator child task' }).click();
  await expect(page.locator('[data-testid="coordinator-chain-strip"]')).toBeVisible();
  await expect(page.locator('[data-testid="coordinator-chain-strip"]')).toContainText('parent');

  await page.getByRole('button', { name: /Mark prior 1 done/ }).click();
  await expect(page.locator('.coordinator-chain-status')).toContainText(
    /only terminated tasks can be marked done automatically|Coordinator state changed/,
  );
});

test('fleet findings pane lists orphan blockers with a nav badge', async ({ page, request }) => {
  await launchViaUI(page, 'Coordinator orphan edge task');
  const task = await taskByPrompt(request, 'Coordinator orphan edge task');
  await request.patch(`/api/tasks/${task.id}/edges`, {
    data: { blocked_by: ['task:missing-upstream'] },
  });

  const trigger = page.getByRole('button', { name: /Coordinator findings/ });
  await expect(trigger.locator('.coordinator-nav-badge')).toContainText('1');
  await trigger.click();

  await expect(page.locator('[data-testid="coordinator-findings-pane"]')).toBeVisible();
  await expect(page.locator('[data-testid="coordinator-findings-pane"]')).toContainText('Orphan dependency edge');
  await expect(page.locator('[data-testid="coordinator-findings-pane"]')).not.toContainText('Terminate');
});

import { test, expect } from './fixtures.js';
import { resetServer } from './reset-server.js';
import type { APIRequestContext, Page } from '@playwright/test';


async function currentTaskCount(page: Page): Promise<number> {
  const status = await page.locator('.statusbar').textContent();
  const match = status?.match(/(\d+)\s+tasks?/);
  return match ? Number(match[1]) : 0;
}

async function waitForAgentCount(page: Page, count: number) {
  await expect(page.locator('.statusbar')).toContainText(`${count} task`, { timeout: 5000 });
}

async function launchViaUI(page: Page, prompt: string, cwd: string) {
  await expect(page.locator('.health-dot-connected')).toBeVisible({ timeout: 5000 });
  const expectedTaskCount = await currentTaskCount(page) + 1;
  await page.locator('.btn-launch').click();
  await page.locator('.dialog textarea').fill(prompt);
  const cwdInput = page.locator('.dialog input[type="text"]').first();
  await cwdInput.clear();
  await cwdInput.fill(cwd);
  await page.locator('.dialog .btn-primary').click();
  await expect(page.locator('.dialog')).not.toBeVisible();
  await waitForAgentCount(page, expectedTaskCount);
}

async function taskByPrompt(request: APIRequestContext, prompt: string): Promise<{ id: string; blocks?: string[]; blocked_by?: string[] }> {
  const res = await request.get('/api/tasks');
  const tasks = await res.json() as Array<{ id: string; prompt: string; blocks?: string[]; blocked_by?: string[] }>;
  const task = tasks.find((candidate) => candidate.prompt === prompt);
  if (!task) throw new Error(`Task not found for prompt: ${prompt}`);
  return task;
}

async function openRelationshipsMenu(page: Page) {
  await page.locator('.dependency-menu-trigger').click();
  const menu = page.locator('#task-dependency-menu');
  await expect(menu).toBeVisible();
  return menu;
}

test.beforeEach(async ({ request, page }) => {
  await resetServer(request);
  await page.goto('/');
});

test('task detail dependency typeahead adds task and milestone edges', async ({ page, request }) => {
  await launchViaUI(page, 'Upstream API task', '/test/project');
  await launchViaUI(page, 'Unrelated implementation task', '/test/project');
  await launchViaUI(page, 'Build target feature', '/test/project');
  const upstream = await taskByPrompt(request, 'Upstream API task');
  const unrelated = await taskByPrompt(request, 'Unrelated implementation task');

  await page.locator('.healthy-row', { hasText: 'Build target feature' }).click();
  await expect(page.locator('[data-testid="task-dependencies"]')).toBeVisible();

  let menu = await openRelationshipsMenu(page);
  await page.locator('[data-testid="add-dependency-button"]').click();
  const modal = page.locator('[data-testid="dependency-modal"]');
  await expect(modal).toBeVisible();
  await page.locator('[data-testid="dependency-search-input"]').fill('upstream');
  const upstreamResult = page.locator('[data-testid="dependency-results"] button', { hasText: upstream.id.slice(0, 8) });
  await expect(upstreamResult).toBeVisible();
  await expect(page.locator('[data-testid="dependency-results"] button', { hasText: unrelated.id.slice(0, 8) })).toHaveCount(0);
  await upstreamResult.click();

  await expect.poll(async () => (await taskByPrompt(request, 'Build target feature')).blocked_by ?? [])
    .toContain(`task:${upstream.id}`);
  menu = await openRelationshipsMenu(page);
  await expect(menu.locator('.dependency-chip', { hasText: upstream.id.slice(0, 8) })).toBeVisible();

  await menu.locator('[data-testid="add-dependency-button"]').click();
  await page.locator('[data-testid="dependency-search-input"]').fill('Vendor approval');
  await page.locator('[data-testid="dependency-free-text"]').click();

  await expect.poll(async () => (await taskByPrompt(request, 'Build target feature')).blocked_by ?? [])
    .toContain('milestone:Vendor approval');
  menu = await openRelationshipsMenu(page);
  await expect(menu.locator('.dependency-chip', { hasText: 'Vendor approval' })).toBeVisible();

  await menu.locator('.dependency-chip', { hasText: 'Vendor approval' }).getByRole('button').click();
  await expect(menu.locator('.dependency-chip', { hasText: 'Vendor approval' })).toHaveCount(0);
  await expect.poll(async () => (await taskByPrompt(request, 'Build target feature')).blocked_by ?? [])
    .not.toContain('milestone:Vendor approval');

  await menu.getByRole('button', { name: 'Add downstream' }).click();
  await page.locator('[data-testid="dependency-search-input"]').fill('unrelated');
  const unrelatedResult = page.locator('[data-testid="dependency-results"] button', { hasText: unrelated.id.slice(0, 8) });
  await expect(unrelatedResult).toBeVisible();
  await unrelatedResult.click();

  await expect.poll(async () => (await taskByPrompt(request, 'Build target feature')).blocks ?? [])
    .toContain(`task:${unrelated.id}`);
  menu = await openRelationshipsMenu(page);
  await expect(menu.locator('.dependency-chip', { hasText: unrelated.id.slice(0, 8) })).toBeVisible();

  await menu.locator('.dependency-chip', { hasText: unrelated.id.slice(0, 8) }).getByRole('button').click();
  await expect.poll(async () => (await taskByPrompt(request, 'Build target feature')).blocks ?? [])
    .not.toContain(`task:${unrelated.id}`);
});

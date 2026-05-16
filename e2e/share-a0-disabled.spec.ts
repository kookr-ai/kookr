import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures.js';

async function resetServer(request: APIRequestContext) {
  await request.post('/api/test/reset');
}

async function createTask(request: APIRequestContext) {
  const res = await request.post('/api/tasks', {
    data: { prompt: 'Local-only task', cwd: '/test/project' },
  });
  expect(res.status()).toBe(201);
}

async function selectTask(page: Page) {
  await expect(page.locator('.statusbar')).toContainText('1 task', { timeout: 5_000 });
  const shareButton = page.getByTestId('task-share-button');
  if (await shareButton.isVisible().catch(() => false)) return;
  await page.locator('.healthy-row, .finding-card').first().click();
  await expect(shareButton).toBeVisible();
}

test.describe('Easy connection sharing local-only state', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
    await expect(page.locator('.health-dot-connected')).toBeVisible();
  });

  test('share modal is disabled when no relay is preconfigured', async ({ page, request }) => {
    await createTask(request);
    await selectTask(page);
    await page.getByTestId('task-share-button').click();

    const dialog = page.getByRole('dialog', { name: 'Share this task' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Preconfigured relay required');
    await expect(dialog).toContainText('KOOKR_RELAY_URL');
    await expect(dialog.getByRole('button', { name: 'Create share link' })).toHaveCount(0);
  });
});

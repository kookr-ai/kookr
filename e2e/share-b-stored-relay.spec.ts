import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './relay-stored-fixtures.js';

async function resetServer(request: APIRequestContext) {
  await request.post('/api/test/reset');
}

async function createTask(request: APIRequestContext): Promise<void> {
  const res = await request.post('/api/tasks', {
    data: {
      prompt: 'Stored relay credential task with private_marker',
      cwd: '/private/stored-relay',
    },
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

test.describe('Easy connection sharing Phase B stored relay startup', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
    await expect(page.locator('.health-dot-connected')).toBeVisible();
  });

  test('owner can create an A0 share from stored credentials', async ({ page, request }) => {
    await createTask(request);
    await selectTask(page);
    await page.getByTestId('task-share-button').click();

    const dialog = page.getByRole('dialog', { name: 'Share this task' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Create share link' }).click();
    const linkInput = dialog.locator('.task-share-link input');
    await expect(linkInput).toBeVisible();
    const joinUrl = await linkInput.inputValue();
    const parsed = new URL(joinUrl);
    expect(parsed.pathname).toMatch(/^\/relay\/join\/\d{3}-\d{3}$/);
    expect(parsed.search).toBe('');
    expect(parsed.hash).toContain('password=');
    expect(joinUrl).not.toContain('?password');
    await expect(dialog.getByRole('status')).toContainText('Waiting for viewer');
  });
});

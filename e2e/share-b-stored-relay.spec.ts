import type { APIRequestContext, Page } from '@playwright/test';
import { resetServer } from './reset-server.js';
import { test, expect } from './relay-stored-fixtures.js';


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
  await expect(page.getByTestId('task-counts')).toContainText('1 task', { timeout: 5_000 });
  const shareButton = page.getByTestId('task-share-button');
  if (await shareButton.isVisible().catch(() => false)) return;
  await page.locator('.healthy-row, .finding-card').first().click();
  await expect(shareButton).toBeVisible();
}

test.describe('Easy connection sharing Phase B stored relay startup', () => {
  // The facts column (Share, dependencies) docks beside the conversation only
  // when the reading pane is 820 px or wider; from #3561 slice 5a the labelled
  // navigation leaves less than that between 1280 and about 1440 px.
  test.use({ viewport: { width: 1600, height: 950 } });

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
    await dialog.locator('.task-share-path', { hasText: 'Create guest link' }).click();
    await dialog.getByRole('button', { name: 'Create guest link', exact: true }).click();
    const linkInput = dialog.locator('.task-share-link input');
    await expect(linkInput).toBeVisible();
    const joinUrl = await linkInput.inputValue();
    const parsed = new URL(joinUrl);
    expect(parsed.pathname).toMatch(/^\/relay\/join\/\d{3}-\d{3}$/);
    expect(parsed.search).toBe('');
    expect(parsed.hash).toContain('password=');
    expect(joinUrl).not.toContain('?password');
    await expect(dialog.locator('.task-share-state')).toContainText('Waiting for viewer');
  });
});

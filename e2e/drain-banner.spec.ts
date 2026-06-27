import { test, expect } from './fixtures.js';
import { resetServer } from './reset-server.js';

test.describe('drain mode banner', () => {
  test.beforeEach(async ({ request }) => {
    await resetServer(request);
    await request.post('/api/admin/resume');
  });

  test.afterEach(async ({ request }) => {
    await request.post('/api/admin/resume');
  });

  test('appears when the server enters drain mode and disappears after resume', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.getByTestId('drain-mode-banner')).toHaveCount(0);

    const drain = await request.post('/api/admin/drain');
    expect(drain.ok()).toBe(true);
    await expect(page.getByTestId('drain-mode-banner')).toBeVisible();
    await expect(page.getByTestId('drain-mode-banner')).toContainText('Drain mode');
    await expect(page.getByTestId('drain-mode-banner')).toContainText('kookr resume');

    const resume = await request.post('/api/admin/resume');
    expect(resume.ok()).toBe(true);
    await expect(page.getByTestId('drain-mode-banner')).toHaveCount(0);
  });

  test('appears from the initial snapshot when already draining before page load', async ({ page, request }) => {
    const drain = await request.post('/api/admin/drain');
    expect(drain.ok()).toBe(true);

    await page.goto('/');
    await expect(page.getByTestId('drain-mode-banner')).toBeVisible();
    await expect(page.getByTestId('drain-mode-banner')).toContainText('kookr resume');
  });
});

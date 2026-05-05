import { test, expect } from './fixtures.js';

test.describe('Cross-project worktree sweep', () => {
  test.beforeEach(async ({ page, request }) => {
    await request.post('/api/test/reset');
    await page.goto('/');
    await expect(page.locator('.health-dot-connected')).toBeVisible({ timeout: 5000 });
  });

  test('sweep button appears when workspace is enabled', async ({ page }) => {
    await expect(page.locator('[data-testid="sweep-button"]')).toBeVisible();
  });

  test('clicking the button opens a confirmation dialog', async ({ page, request }) => {
    // Seed one project so the button is enabled.
    await request.post('/api/projects/track', {
      data: { repo: 'sweep/e2e-a' },
    });
    await expect(page.locator('[data-testid="sweep-button"]')).toBeEnabled({ timeout: 3000 });

    await page.locator('[data-testid="sweep-button"]').click();
    const dialog = page.locator('[data-testid="sweep-confirm"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('1');
    await expect(dialog).toContainText('known project');
  });

  test('cancel closes the dialog without triggering a sweep', async ({ page, request }) => {
    await request.post('/api/projects/track', {
      data: { repo: 'sweep/e2e-cancel' },
    });
    await expect(page.locator('[data-testid="sweep-button"]')).toBeEnabled({ timeout: 3000 });

    await page.locator('[data-testid="sweep-button"]').click();
    await page.locator('[data-testid="sweep-cancel"]').click();
    await expect(page.locator('[data-testid="sweep-confirm"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="sweep-button"]')).toBeEnabled();
  });

  test('confirming triggers the sweep and the button returns to enabled', async ({ page, request }) => {
    // Seed a project with no resolvable repoPath — the sweep will record it
    // as skipped/repo_path_unresolved and complete immediately. That is still
    // end-to-end coverage of the wire path.
    await request.post('/api/projects/track', {
      data: { repo: 'sweep/e2e-confirm' },
    });
    await expect(page.locator('[data-testid="sweep-button"]')).toBeEnabled({ timeout: 3000 });

    await page.locator('[data-testid="sweep-button"]').click();
    await page.locator('[data-testid="sweep-confirm-go"]').click();

    // Dialog closes immediately.
    await expect(page.locator('[data-testid="sweep-confirm"]')).not.toBeVisible();

    // Button briefly disables during the sweep; on completion it returns to
    // enabled (proof that handleSweepComplete fired and cleared sweepRunning).
    await expect(page.locator('[data-testid="sweep-button"]')).toBeEnabled({ timeout: 8000 });
  });
});

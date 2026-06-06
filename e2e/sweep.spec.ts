import { test, expect } from './fixtures.js';

async function seedTrackedProject(request: import('@playwright/test').APIRequestContext, repo: string) {
  await request.post('/api/projects/track', {
    data: { repo },
  });
}

async function openSweepAction(page: import('@playwright/test').Page) {
  await page.getByTestId('command-trigger').click();
  await page.getByTestId('command-palette-input').fill('sweep');
  const action = page.locator('[data-testid="command-palette-action"][data-action-id="sweep"]');
  await expect(action).toBeVisible();
  await action.click();
}

test.describe('Cross-project worktree sweep', () => {
  test.beforeEach(async ({ page, request }) => {
    await request.post('/api/test/reset');
    await page.goto('/');
    await expect(page.locator('.health-dot-connected')).toBeVisible({ timeout: 5000 });
  });

  test('sweep action appears when workspace is enabled', async ({ page, request }) => {
    await seedTrackedProject(request, 'sweep/e2e-visible');
    await page.getByTestId('command-trigger').click();
    await page.getByTestId('command-palette-input').fill('sweep');
    await expect(page.locator('[data-testid="command-palette-action"][data-action-id="sweep"]')).toBeVisible();
  });

  test('clicking the button opens a confirmation dialog', async ({ page, request }) => {
    // Seed one project so the button is enabled.
    await seedTrackedProject(request, 'sweep/e2e-a');

    await openSweepAction(page);
    const dialog = page.getByRole('dialog', { name: 'Sweep merged worktrees' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('1');
    await expect(dialog).toContainText('project');
  });

  test('cancel closes the dialog without triggering a sweep', async ({ page, request }) => {
    await seedTrackedProject(request, 'sweep/e2e-cancel');

    await openSweepAction(page);
    const dialog = page.getByRole('dialog', { name: 'Sweep merged worktrees' });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
  });

  test('confirming triggers the sweep and closes the confirmation dialog', async ({ page, request }) => {
    // Seed a project with no resolvable repoPath — the sweep will record it
    // as skipped/repo_path_unresolved and complete immediately. That is still
    // end-to-end coverage of the wire path.
    await seedTrackedProject(request, 'sweep/e2e-confirm');

    await openSweepAction(page);
    const dialog = page.getByRole('dialog', { name: 'Sweep merged worktrees' });
    await dialog.getByRole('button', { name: 'Sweep' }).click();

    // Dialog closes immediately.
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('.toast-info')).toContainText('Swept 1 project(s) · skipped 1', {
      timeout: 8000,
    });
  });
});

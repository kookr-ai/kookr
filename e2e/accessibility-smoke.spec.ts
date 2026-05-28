import AxeBuilder from '@axe-core/playwright';
import { resetServer } from './reset-server.js';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures.js';

interface AxeViolationSummary {
  id: string;
  impact: string | null;
  help: string;
  nodes: string[];
}

async function expectNoA11yViolations(page: Page, name: string, includeSelector = 'body') {
  const results = await new AxeBuilder({ page })
    .include(includeSelector)
    .withTags(['wcag2a', 'wcag2aa'])
    // Existing theme contrast debt is tracked outside this smoke layer. Keeping
    // this scan structural makes failures actionable for dashboard/dialog flows.
    .disableRules(['color-contrast'])
    .analyze();

  const violations: AxeViolationSummary[] = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact ?? null,
    help: violation.help,
    nodes: violation.nodes.map((node) => node.target.join(' ')),
  }));

  expect(violations, `${name} accessibility violations`).toEqual([]);
}


async function seedTask(request: APIRequestContext) {
  const response = await request.post('/api/tasks', {
    data: { prompt: 'Investigate accessibility smoke coverage', cwd: '/test/project' },
  });
  expect(response.status()).toBe(201);
}

async function openSelectedTask(page: Page, request: APIRequestContext) {
  await seedTask(request);
  await expect(page.locator('.statusbar')).toContainText('1 task');
  const shareButton = page.getByRole('button', { name: 'Share this task' });
  if (await shareButton.isVisible().catch(() => false)) return;
  await page.locator('.healthy-row, .finding-card').first().click();
  await expect(shareButton).toBeVisible();
}

test.describe('Accessibility smoke scans', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
    await expect(page.locator('.health-dot-connected')).toBeVisible();
  });

  test('dashboard shell has no axe violations and exposes keyboard navigation', async ({ page }) => {
    await expect(page.locator('.findings-empty')).toContainText('No agents running');

    await expectNoA11yViolations(page, 'dashboard shell');

    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toBeVisible();
  });

  test('launch dialog has no axe violations and closes with Escape', async ({ page }) => {
    await page.getByRole('button', { name: '+ Launch' }).click();

    const dialog = page.getByRole('dialog', { name: 'Launch New Task' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    await expectNoA11yViolations(page, 'launch dialog', '[role="dialog"]');

    const closeButton = dialog.getByLabel('Close');
    const cancelButton = dialog.getByRole('button', { name: 'Cancel' });
    await closeButton.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(cancelButton).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(closeButton).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('settings dialog has no axe violations and supports tab focus', async ({ page }) => {
    const settingsButton = page.getByRole('button', { name: 'Settings' });
    await settingsButton.click();

    const dialog = page.getByRole('dialog', { name: 'Settings' });
    const closeButton = dialog.getByLabel('Close');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(closeButton).toBeFocused();
    await expect(dialog.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.getByLabel('Stale agent timeout')).toBeVisible();

    await expectNoA11yViolations(page, 'settings dialog', '[role="dialog"]');

    const footerCloseButton = dialog.getByRole('button', { name: 'Close' }).last();
    await closeButton.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(footerCloseButton).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(closeButton).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(settingsButton).toBeFocused();
  });

  test('share dialog has no axe violations and closes with Escape', async ({ page, request }) => {
    await openSelectedTask(page, request);
    await page.getByRole('button', { name: 'Share this task' }).click();

    const dialog = page.getByRole('dialog', { name: 'Share this task' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Relay connection required');

    await expectNoA11yViolations(page, 'share dialog', '[role="dialog"]');

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('diagnostics dialog has no axe violations and traps keyboard focus', async ({ page }) => {
    await page.getByRole('button', { name: 'Diagnostics' }).click();

    const dialog = page.getByRole('dialog', { name: 'Diagnostics' });
    const closeButton = dialog.getByRole('button', { name: 'Close diagnostics' });
    await expect(dialog).toBeVisible();
    await expect(closeButton).toBeFocused();
    await expect(dialog.getByRole('group', { name: 'Audio alert counts by outcome', includeHidden: true })).toHaveCount(1);

    await expectNoA11yViolations(page, 'diagnostics dialog', '[role="dialog"]');

    const lastFocusable = dialog.getByRole('button', { name: /Finding Evidence/i });
    await page.keyboard.press('Shift+Tab');
    await expect(lastFocusable).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(closeButton).toBeFocused();
  });
});

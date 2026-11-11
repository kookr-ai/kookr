/**
 * Navigation footer, Bypass mode chip and System panel layouts (issue #3619,
 * follow-ups from the #3561 UI overhaul).
 *
 * - Footer layouts: the labelled sidebar (>= 1280 px) shows spend and counts,
 *   the 52 px icon rail shows quota only (and nothing without quota), phones
 *   hide the footer. Until now these were measured by a scratch spec only.
 * - With System open at >= 1280 px, the footer and System's Usage section both
 *   render the same summary, so their test ids exist twice: scope selectors to
 *   `nav-footer` or `system-usage`.
 * - The full 40-character commit hash fits the System panel on a phone.
 * The Bypass mode chip check is in bypass-mode-chip.spec.ts (its own worker).
 */
import { test, expect } from './fixtures.js';
import type { APIRequestContext, Page } from '@playwright/test';
import { launchViaUI, resetServer } from './battle-helpers.js';

async function openDashboard(page: Page, request: APIRequestContext, spendUsd: number): Promise<void> {
  await resetServer(request);
  await request.post('/api/test/set-spend', { data: { lifetimeSpendUsd: spendUsd } });
  await page.goto('/');
  await expect(page.locator('.health-dot-connected')).toBeVisible();
  // The navigation (and its footer) renders once there is a project row.
  await launchViaUI(page, 'Footer layout', '/test/project');
  await expect(page.locator('.project-sidebar')).toBeVisible();
}

async function broadcastQuota(request: APIRequestContext): Promise<void> {
  // Not replayed on reload: call after the page is connected.
  await request.post('/api/test/broadcast-quota', { data: { fiveHour: 42, sevenDay: 61 } });
}

test.describe('Navigation footer layouts', () => {
  test('labelled sidebar (>= 1280 px) shows spend and quota with long labels', async ({ page, request }) => {
    await page.setViewportSize({ width: 1600, height: 950 });
    await openDashboard(page, request, 12.34);
    await broadcastQuota(request);

    const footer = page.getByTestId('nav-footer');
    await expect(footer).toBeVisible();
    await expect(footer.getByTestId('all-time-spend')).toBeVisible();
    await expect(footer.getByTestId('all-time-spend')).toHaveText('$12.34');
    await expect(footer.getByTestId('usage-quota-5h')).toBeVisible();
    await expect(footer.locator('.usage-label-long').first()).toBeVisible();
  });

  test('icon rail (< 1280 px) shows quota only, and no footer without quota', async ({ page, request }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await openDashboard(page, request, 12.34);

    const footer = page.getByTestId('nav-footer');
    // Spend alone is not shown in the 52 px rail, so the footer is hidden.
    await expect(footer).toBeHidden();

    await broadcastQuota(request);
    await expect(footer).toBeVisible();
    await expect(footer.getByTestId('usage-quota-5h')).toBeVisible();
    await expect(footer.getByTestId('all-time-spend')).toBeHidden();
    await expect(footer.locator('.usage-label-short').first()).toBeVisible();
    const box = await footer.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(64);
  });

  test('phones hide the footer', async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDashboard(page, request, 12.34);
    await broadcastQuota(request);
    await expect(page.getByTestId('nav-footer')).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test('with System open, footer and Usage share test ids; scoped selectors pick one each', async ({ page, request }) => {
    await page.setViewportSize({ width: 1600, height: 950 });
    await openDashboard(page, request, 12.34);
    await page.getByTestId('system-indicator').click();
    await expect(page.getByTestId('system-usage')).toBeVisible();

    await expect(page.getByTestId('all-time-spend')).toHaveCount(2);
    for (const scope of ['nav-footer', 'system-usage']) {
      await expect(page.getByTestId(scope).getByTestId('all-time-spend')).toHaveCount(1);
      await expect(page.getByTestId(scope).getByTestId('all-time-spend')).toHaveText('$12.34');
    }
  });

  test('the full commit hash fits the System panel on a phone', async ({ page, request }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await openDashboard(page, request, 0);
    await page.getByTestId('system-indicator').click();
    const popover = page.locator('.system-popover');
    await expect(popover).toBeVisible();
    const code = popover.locator('.version-row').filter({ hasText: 'Commit' }).locator('code');
    await expect(code).toHaveText(/^[0-9a-f]{40}$/);

    const fit = await code.evaluate((el) => {
      const row = el.closest('.version-row')!.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      // Every line box of the (possibly wrapped) hash sits inside the row.
      const lines = Array.from(el.getClientRects());
      return {
        insideRow: lines.every((line) => line.right <= row.right + 0.5 && line.left >= row.left - 0.5),
        rowClips: el.closest('.version-row')!.scrollWidth > el.closest('.version-row')!.clientWidth,
        boxRight: box.right,
        viewport: window.innerWidth,
      };
    });
    expect(fit.rowClips).toBe(false);
    expect(fit.insideRow).toBe(true);
    expect(fit.boxRight).toBeLessThanOrEqual(fit.viewport);
  });
});

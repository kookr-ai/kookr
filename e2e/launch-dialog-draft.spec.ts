import { test, expect } from './fixtures.js';

const DRAFT_KEY = 'kookr:launchDialogDraft';

test.describe('Launch dialog draft persistence', () => {
  test('typed text survives Escape-close and reopen', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
    // Clear any leftover draft from a prior test run in this browser context.
    await page.evaluate((key) => window.localStorage.removeItem(key), DRAFT_KEY);

    const DRAFT = 'Draft recovered after accidental close — keep this exact string';

    // Open, type, Escape to close.
    await page.locator('.btn-launch').click();
    await expect(page.locator('.dialog')).toBeVisible();
    await page.locator('.dialog textarea').fill(DRAFT);
    await page.keyboard.press('Escape');
    await expect(page.locator('.dialog')).not.toBeVisible();

    // Reopen — draft should be restored.
    await page.locator('.btn-launch').click();
    await expect(page.locator('.dialog')).toBeVisible();
    await expect(page.locator('.dialog textarea')).toHaveValue(DRAFT);

    // Close again and confirm the draft is still there (Escape doesn't clear).
    await page.keyboard.press('Escape');
    await page.locator('.btn-launch').click();
    await expect(page.locator('.dialog textarea')).toHaveValue(DRAFT);
  });
});

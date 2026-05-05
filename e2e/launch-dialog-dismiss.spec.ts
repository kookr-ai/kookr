import { test, expect } from './fixtures.js';

const DRAFT_KEY = 'kookr:launchDialogDraft';

test.describe('Launch dialog dismiss safety', () => {
  test('clicking the backdrop overlay does not close the dialog', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
    await page.evaluate((key) => window.localStorage.removeItem(key), DRAFT_KEY);

    const TEXT = 'In-progress description that must survive a stray backdrop click';

    await page.locator('.btn-launch').click();
    await expect(page.locator('.dialog')).toBeVisible();
    await page.locator('.dialog textarea').fill(TEXT);

    // Click on the overlay itself (not on the inner .dialog). Use a corner of
    // the viewport that we know is overlay because the dialog is centered.
    const overlay = page.locator('.dialog-overlay');
    await overlay.click({ position: { x: 5, y: 5 }, force: true });

    // Dialog must still be visible and the text intact.
    await expect(page.locator('.dialog')).toBeVisible();
    await expect(page.locator('.dialog textarea')).toHaveValue(TEXT);

    // Cleanup so we don't leak a draft into the next test in this browser
    // context. Escape (which still closes), then discard.
    await page.keyboard.press('Escape');
    await expect(page.locator('.dialog')).not.toBeVisible();
    await page.evaluate((key) => window.localStorage.removeItem(key), DRAFT_KEY);
  });

  test('the X close button still closes the dialog', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
    await page.evaluate((key) => window.localStorage.removeItem(key), DRAFT_KEY);

    await page.locator('.btn-launch').click();
    await expect(page.locator('.dialog')).toBeVisible();

    await page.locator('.dialog-close').click();
    await expect(page.locator('.dialog')).not.toBeVisible();
  });

  test('reopening with a stored draft shows the restored-draft banner', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
    await page.evaluate((key) => window.localStorage.removeItem(key), DRAFT_KEY);

    const TEXT = 'Saved draft text for banner check';

    // First open: type, Escape to close (saves draft).
    await page.locator('.btn-launch').click();
    await expect(page.locator('.dialog')).toBeVisible();
    await page.locator('.dialog textarea').fill(TEXT);
    await page.keyboard.press('Escape');
    await expect(page.locator('.dialog')).not.toBeVisible();

    // Second open: banner visible, content restored.
    await page.locator('.btn-launch').click();
    await expect(page.locator('.dialog')).toBeVisible();
    await expect(page.locator('.draft-restored-banner')).toBeVisible();
    await expect(page.locator('.draft-restored-banner')).toContainText('Restored your last draft');
    await expect(page.locator('.dialog textarea')).toHaveValue(TEXT);

    // Click Discard draft → fields clear, banner disappears, draft removed.
    await page.locator('.draft-restored-banner .link-button').click();
    await expect(page.locator('.draft-restored-banner')).not.toBeVisible();
    await expect(page.locator('.dialog textarea')).toHaveValue('');
    expect(await page.evaluate((key) => window.localStorage.getItem(key), DRAFT_KEY)).toBeNull();

    // Cleanup
    await page.keyboard.press('Escape');
    await expect(page.locator('.dialog')).not.toBeVisible();
  });
});

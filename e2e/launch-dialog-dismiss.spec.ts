import { test, expect } from './fixtures.js';
import type { Page } from '@playwright/test';

const DRAFT_KEY = 'kookr:launchDialogDraft';
const DICTATION_TAB_KEY = 'kookr:dictationTab:v1';

/**
 * Read the stored draft the way the dialog does: since #3375 a draft that
 * carries a dictation id is kept per browser tab, under
 * `kookr:launchDialogDraft:<tab id>`, and the bare key is only the fallback.
 */
function readStoredDraft(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(({ draftKey, tabKey }) => {
    const tabId = window.sessionStorage.getItem(tabKey);
    const raw = (tabId ? window.localStorage.getItem(`${draftKey}:${tabId}`) : null)
      ?? window.localStorage.getItem(draftKey);
    return raw ? JSON.parse(raw) : null;
  }, { draftKey: DRAFT_KEY, tabKey: DICTATION_TAB_KEY });
}

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
    const restoredDictationId = (await readStoredDraft(page))?.dictationId;
    expect(restoredDictationId).toEqual(expect.any(String));

    // Discard clears typed content and creates a new dictation recovery identifier.
    await page.locator('.draft-restored-banner .link-button').click();
    await expect(page.locator('.draft-restored-banner')).not.toBeVisible();
    await expect(page.locator('.dialog textarea')).toHaveValue('');
    const emptyDraft = await readStoredDraft(page);
    expect(emptyDraft).toMatchObject({ prompt: '', criteria: '', dictationId: expect.any(String) });
    expect(emptyDraft?.dictationId).not.toBe(restoredDictationId);

    await page.keyboard.press('Escape');
    await expect(page.locator('.dialog')).not.toBeVisible();
    await page.locator('.btn-launch').click();
    await expect(page.locator('.dialog textarea')).toHaveValue('');
    await expect(page.locator('.draft-restored-banner')).not.toBeVisible();

    // Cleanup
    await page.keyboard.press('Escape');
    await expect(page.locator('.dialog')).not.toBeVisible();
  });
});

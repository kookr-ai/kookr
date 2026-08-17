import { test, expect } from './fixtures.js';

const DRAFT_KEY = 'kookr:launchDialogDraft';

test.describe('Launch dialog sample prompt chips', () => {
  test('clicking a chip fills the prompt without launching', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
    await page.evaluate((key) => window.localStorage.removeItem(key), DRAFT_KEY);

    await page.locator('.btn-launch').click();
    const dialog = page.getByRole('dialog', { name: 'Launch New Task' });
    await expect(dialog).toBeVisible();

    const chips = dialog.getByRole('group', { name: 'Sample prompts' }).getByRole('button');
    expect(await chips.count()).toBeGreaterThanOrEqual(2);

    const prompt = dialog.getByLabel('Task description');
    const cwd = dialog.getByPlaceholder('/home/user/my-project');
    await prompt.fill('typed by the operator');
    const cwdBefore = await cwd.inputValue();

    await dialog.getByRole('button', { name: 'Review the latest diff' }).click();

    await expect(prompt).toHaveValue(
      'Review the diff since origin/main and summarize risks',
    );
    await expect(cwd).toHaveValue(cwdBefore);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Launch' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Copy kookr spawn' })).toBeVisible();

    await page.keyboard.press('Escape');
    await page.evaluate((key) => window.localStorage.removeItem(key), DRAFT_KEY);
  });
});

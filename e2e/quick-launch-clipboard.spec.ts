import { test, expect } from './fixtures.js';

for (const width of [1280, 390]) {
  test(`Quick Launch clipboard path stays open at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await page.addInitScript(() => {
      let reads = 0;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { readText: async () => {
          reads += 1;
          document.documentElement.dataset.clipboardReads = String(reads);
          return '  ~/clipboard-project  ';
        } },
      });
    });
    await page.goto('/');
    await expect(page.locator('.health-dot-connected')).toBeVisible();
    const isMac = await page.evaluate(() => /Mac/i.test(navigator.platform));
    await page.keyboard.press(isMac ? 'Control+Meta+l' : 'Alt+l');
    const bar = page.locator('.quick-launch-bar');
    await expect(bar).toBeVisible();
    const prompt = bar.getByPlaceholder('Task prompt...', { exact: false });
    await prompt.fill('Review the current changes');
    await expect(page.locator('html')).not.toHaveAttribute('data-clipboard-reads');

    const paste = bar.getByRole('button', { name: 'Use clipboard path' });
    await paste.click();
    await expect(bar.locator('.quick-launch-cwd')).toHaveText('~/clipboard-project');
    await expect(prompt).toHaveValue('Review the current changes');
    await expect(prompt).toBeFocused();
    await expect(page.locator('html')).toHaveAttribute('data-clipboard-reads', '1');

    // Enter activates the focused button without submitting the prompt.
    await paste.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveAttribute('data-clipboard-reads', '2');
    await expect(bar).toBeVisible();
    await expect(prompt).toHaveValue('Review the current changes');
    await expect(paste).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('quick-launch-clipboard.png') });
    await page.keyboard.press('Escape');
    await expect(bar).toBeHidden();
  });
}

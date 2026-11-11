/**
 * Bypass mode with real spend (issue #3619). The server runs in
 * bypass-all-permissions mode (a worker option, so this file has its own
 * worker) and has non-zero spend. The Bypass mode chip must stay neutral and
 * clear of every other top-bar control at every desktop width; a #3597
 * reviewer found spend printed over the chip by hand, because no fixture
 * combined bypass mode with real spend.
 */
import { test, expect } from './fixtures.js';
import { launchViaUI, resetServer } from './battle-helpers.js';

test.use({ bypassAllPermissions: true });

test.describe('Bypass mode chip with real spend', () => {
  test('the chip is neutral and clear of every other top-bar control', async ({ page, request }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await resetServer(request);
    await request.post('/api/test/set-spend', { data: { lifetimeSpendUsd: 12345.67 } });
    await page.goto('/');
    await expect(page.locator('.health-dot-connected')).toBeVisible();
    // A project row, so the navigation footer (which shows the spend) renders.
    await launchViaUI(page, 'Bypass chip', '/test/project');
    await expect(page.locator('.project-sidebar')).toBeVisible();

    const chip = page.getByTestId('permission-mode-chip');
    await expect(chip).toHaveText('Bypass mode');
    // Neutral secondary text, not the red of the old banner.
    const chipColors = await chip.evaluate((el) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--text-secondary)';
      document.body.appendChild(probe);
      const neutral = getComputedStyle(probe).color;
      probe.remove();
      return { chip: getComputedStyle(el).color, neutral };
    });
    expect(chipColors.chip).toBe(chipColors.neutral);
    // The spend really is on screen somewhere, so the check below is not vacuous.
    await expect(page.getByTestId('nav-footer').getByTestId('all-time-spend')).toHaveText('$12345.67');

    for (const width of [769, 834, 900, 1024, 1180, 1280, 1600]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(chip).toBeVisible();
      const overlaps = await page.evaluate(() => {
        const chipEl = document.querySelector('[data-testid="permission-mode-chip"]')!;
        const c = chipEl.getBoundingClientRect();
        return Array.from(document.querySelectorAll<HTMLElement>('.topbar *'))
          .filter((el) => el !== chipEl && !chipEl.contains(el) && !el.contains(chipEl))
          .filter((el) => {
            const style = getComputedStyle(el);
            if (style.visibility === 'hidden' || style.display === 'none') return false;
            const b = el.getBoundingClientRect();
            if (b.width === 0 || b.height === 0) return false;
            return b.left < c.right - 0.5 && b.right > c.left + 0.5 && b.top < c.bottom - 0.5 && b.bottom > c.top + 0.5;
          })
          .map((el) => `${el.tagName.toLowerCase()}.${el.className}`);
      });
      expect(overlaps, `${width}px`).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth), `${width}px`).toBeLessThanOrEqual(width);
    }
  });
});

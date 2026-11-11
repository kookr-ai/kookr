import { test, expect } from './fixtures.js';
import type { Page } from '@playwright/test';
import { AVATAR_PANEL_KEY } from '../src/frontend/store/avatar-panel-prefs.js';

/**
 * The avatar panel is an optional feature. These tests pin the two promises
 * that make it safe to ship to everyone: it costs nothing until switched on
 * (no 3D renderer, no avatar file is requested), and once switched on it can
 * be minimised and reopened and remembers its state across reloads.
 *
 * The 3D view itself is not asserted here: headless browsers may have no
 * WebGL, in which case the panel shows a short message instead of the
 * character. The window, its controls and the downloads are what matter.
 */

const AVATAR_ASSET = /vendor-three|AvatarDock|\.glb(\?|$)/;

function trackAvatarRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    if (AVATAR_ASSET.test(request.url())) seen.push(request.url());
  });
  return seen;
}

async function openSettings(page: Page): Promise<void> {
  await page.keyboard.press('Control+k');
  await page.getByTestId('command-palette-input').fill('settings');
  await page.locator('[data-testid="command-palette-action"][data-action-id="settings"]').click();
  await expect(page.locator('.settings-dialog-body')).toBeVisible();
}

test.describe('avatar panel (optional)', () => {
  test('is off by default and downloads nothing', async ({ page }) => {
    const requests = trackAvatarRequests(page);
    await page.goto('/');
    await expect(page.locator('.app')).toBeVisible();
    // Give lazy chunks a chance to load if they were going to.
    await page.waitForLoadState('networkidle');

    await expect(page.getByTestId('avatar-dock')).toHaveCount(0);
    await expect(page.getByTestId('avatar-bubble')).toHaveCount(0);
    expect(requests, 'no avatar code or model may be requested while the panel is off').toEqual([]);
    expect(await page.evaluate((key) => localStorage.getItem(key), AVATAR_PANEL_KEY)).toBeNull();
  });

  test('switching it on in Settings shows the window and only then downloads it', async ({ page }) => {
    const requests = trackAvatarRequests(page);
    await page.goto('/');
    await expect(page.locator('.app')).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(requests).toEqual([]);

    await openSettings(page);
    const toggle = page.getByRole('button', { name: 'Toggle avatar panel' });
    await toggle.scrollIntoViewIfNeeded();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    const dock = page.getByTestId('avatar-dock');
    await expect(dock).toBeVisible();
    await expect(dock).toHaveAttribute('data-avatar-state', 'idle');
    await expect(page.getByTestId('avatar-caption')).toContainText('speaker button');
    expect(requests.some((url) => /AvatarDock/.test(url)), 'the panel code is fetched on demand').toBe(true);
    // Positive control for the "downloads nothing" checks above: the 3D renderer really does live in a chunk
    // of its own with this name. If it were folded into a shared chunk, those checks would pass while every
    // operator paid for it.
    await expect
      .poll(() => requests.some((url) => /vendor-three/.test(url)), { message: 'the 3D renderer is fetched on demand' })
      .toBe(true);

    // Switching it off again removes the window.
    await toggle.click();
    await expect(page.getByTestId('avatar-dock')).toHaveCount(0);
  });

  test('minimises to a bubble, reopens, and remembers both across a reload', async ({ page }) => {
    await page.addInitScript((key) => {
      if (window.localStorage.getItem(key) === null) {
        window.localStorage.setItem(key, JSON.stringify({ enabled: true, minimized: false, position: null }));
      }
    }, AVATAR_PANEL_KEY);
    await page.goto('/');
    const dock = page.getByTestId('avatar-dock');
    await expect(dock).toBeVisible();

    // The window starts fully inside the viewport, in the bottom-right corner.
    const box = await dock.boundingBox();
    const viewport = page.viewportSize();
    expect(box && viewport).toBeTruthy();
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
    expect(box!.x).toBeGreaterThan(viewport!.width / 2);

    await page.getByRole('button', { name: 'Minimise Lucy' }).click();
    const bubble = page.getByTestId('avatar-bubble');
    await expect(bubble).toBeVisible();
    // Keyboard focus follows from the Minimise button to the bubble that replaced the window.
    await expect(bubble).toBeFocused();
    await expect(dock).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId('avatar-bubble')).toBeVisible();
    await expect(page.getByTestId('avatar-dock')).toHaveCount(0);

    await page.getByTestId('avatar-bubble').click();
    await expect(page.getByTestId('avatar-dock')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Minimise Lucy' })).toBeFocused();

    await page.reload();
    await expect(page.getByTestId('avatar-dock')).toBeVisible();
  });

  test('can be moved to another corner without dragging, and stays there after a reload', async ({ page }) => {
    await page.addInitScript((key) => {
      if (window.localStorage.getItem(key) === null) {
        window.localStorage.setItem(key, JSON.stringify({ enabled: true, minimized: false, position: null }));
      }
    }, AVATAR_PANEL_KEY);
    await page.goto('/');
    const dock = page.getByTestId('avatar-dock');
    await expect(dock).toBeVisible();
    const viewport = page.viewportSize();
    const before = await dock.boundingBox();
    expect(before!.x).toBeGreaterThan(viewport!.width / 2);

    await page.getByRole('button', { name: 'Move Lucy to the next corner' }).click();
    await expect.poll(async () => (await dock.boundingBox())!.x).toBeLessThan(viewport!.width / 2);

    await page.reload();
    await expect(dock).toBeVisible();
    expect((await dock.boundingBox())!.x).toBeLessThan(viewport!.width / 2);
  });
});

/**
 * Machine + fleet vitals in the real dashboard: the block at the top of the
 * System detail and the opt-in strip in the top bar.
 *
 * The readings are fixtures (see fleet-vitals-fixtures.ts), so the spec does
 * not depend on the host it runs on having a GPU or being idle.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import {
  routeFleetVitals,
  vitalsHistory,
  vitalsSample,
  type FleetVitalsRoute,
  type VitalsFixtureOptions,
} from './fleet-vitals-fixtures.js';

async function openDashboard(page: Page, options: VitalsFixtureOptions = {}): Promise<FleetVitalsRoute> {
  const vitals = await routeFleetVitals(page);
  await page.goto('/');
  await expect(page.locator('.health-dot-connected')).toBeVisible();
  const sample = vitalsSample(options);
  vitals.send(sample, vitalsHistory(sample));
  return vitals;
}

test.describe('Fleet vitals', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 950 });
  });

  test('the System detail leads with the verdict, the machine meters and the fleet rates', async ({ page }) => {
    await openDashboard(page);
    // Off by default: nothing is added to the top bar.
    await expect(page.getByTestId('fleet-vitals-strip')).toHaveCount(0);

    await page.getByTestId('system-indicator').click();
    const block = page.getByTestId('fleet-vitals');
    await expect(block).toBeVisible();
    await expect(block.getByTestId('fleet-vitals-verdict')).toContainText('Machine comfortable');
    await expect(block.getByTestId('fleet-vitals-verdict')).toContainText('Tightest: CPU 66%');
    await expect(block.getByRole('meter')).toHaveCount(4);
    await expect(block.getByRole('meter', { name: 'VRAM' })).toHaveAttribute('aria-valuetext', '10%, 2.4 / 24 GB');
    await expect(block.getByRole('meter', { name: 'VRAM' })).toHaveAttribute('aria-valuenow', '10');
    await expect(block.getByTestId('fleet-vitals-running')).toContainText('15');
    await expect(block.getByRole('group', { name: /^Generated: at least 110 tokens per second/ })).toBeVisible();
    await expect(block.getByRole('group', { name: /^Tool calls: 26 per minute/ })).toBeVisible();
    // The block replaces the two CPU / RAM pills.
    await expect(page.locator('.system-popover .resource-status')).toHaveCount(0);

    // The block fits its popover: no row is clipped or scrolls sideways.
    const fits = await block.evaluate((el) => {
      const popover = el.closest('.system-popover')!;
      const edge = popover.getBoundingClientRect().right;
      const overflowing = Array.from(el.querySelectorAll<HTMLElement>('*'))
        .filter((child) => child.getBoundingClientRect().right > edge + 0.5)
        .map((child) => child.className);
      return { overflowing, scrolls: popover.scrollWidth > popover.clientWidth };
    });
    expect(fits).toEqual({ overflowing: [], scrolls: false });
  });

  test('pinning adds a quiet strip to the top bar, and the choice survives a reload', async ({ page }) => {
    const vitals = await openDashboard(page);
    await page.getByTestId('system-indicator').click();
    const pin = page.getByTestId('fleet-vitals-pin');
    await expect(pin).toHaveAttribute('aria-checked', 'false');
    await pin.click();
    await expect(pin).toHaveAttribute('aria-checked', 'true');

    const strip = page.getByTestId('fleet-vitals-strip');
    await expect(strip).toBeVisible();
    await expect(strip).toHaveAccessibleName(/^Vitals: CPU 66%, GPU load 24%, video memory 10%, 15 running/);
    // At rest no cell carries a state colour, and the System indicator is calm too.
    await expect(strip.locator('.vitals-cell--watch, .vitals-cell--bad')).toHaveCount(0);
    await expect(page.getByTestId('system-indicator')).not.toHaveAccessibleName(/CPU high|GPU memory|memory high/);

    // The strip is a second trigger for the detail: it closes and reopens it.
    await strip.click();
    await expect(page.getByTestId('fleet-vitals')).toHaveCount(0);
    await strip.click();
    await expect(page.getByTestId('fleet-vitals')).toBeVisible();
    await page.keyboard.press('Escape');

    // Pinned is remembered by the browser: after a reload the strip is back as
    // soon as the first sample arrives, without touching the switch again.
    await page.reload();
    await expect(page.locator('.health-dot-connected')).toBeVisible();
    vitals.send(vitalsSample());
    await expect(page.getByTestId('fleet-vitals-strip')).toBeVisible();
  });

  test('under pressure the strip names the resource and the System indicator agrees', async ({ page }) => {
    await page.addInitScript(() => {
      try { window.localStorage.setItem('kookr:vitalsPinned', 'true'); } catch { /* ignore */ }
    });
    const vitals = await openDashboard(page);
    const strip = page.getByTestId('fleet-vitals-strip');
    await expect(strip).toBeVisible();

    const pressure = vitalsSample({ cpu: 96, vramPercent: 97.1, gpuLoad: 100 });
    vitals.send(pressure);

    await expect(strip.locator('[data-vitals-cell="vram"]')).toHaveClass(/vitals-cell--bad/);
    await expect(strip.locator('[data-vitals-cell="vram"]')).toHaveText('VRAM97%');
    // A GPU at 100 % load is a busy GPU, not a problem.
    await expect(strip.locator('[data-vitals-cell="gpu"]')).toHaveClass(/vitals-cell--ok/);
    await expect(page.getByTestId('system-indicator')).toHaveAccessibleName(/CPU high.*GPU memory nearly full/);
    await expect(page.getByTestId('system-indicator')).toHaveClass(/needs-attention/);

    await strip.click();
    await expect(page.getByTestId('fleet-vitals-verdict')).toContainText('CPU saturated, VRAM nearly full');
  });

  test('the strip never overlaps another top-bar control or widens the page', async ({ page }) => {
    await page.addInitScript(() => {
      try { window.localStorage.setItem('kookr:vitalsPinned', 'true'); } catch { /* ignore */ }
    });
    // The widest strip: every alert cell, every machine cell, a four-digit rate.
    await openDashboard(page, {
      cpu: 100, ramPercent: 93, vramPercent: 100, gpuLoad: 100, lagMs: 1_240,
      agents: 40, subagents: 80, generatedPerSec: 12_400,
    });
    for (const width of [1100, 1280, 1400, 1440, 1540, 1600, 1920]) {
      await page.setViewportSize({ width, height: 950 });
      await expect(page.getByTestId('system-indicator')).toBeVisible();
      const overlaps = await page.evaluate(() => {
        const strip = document.querySelector('[data-testid="fleet-vitals-strip"]');
        if (!strip) return [];
        const s = strip.getBoundingClientRect();
        return Array.from(document.querySelectorAll<HTMLElement>('.topbar *'))
          .filter((el) => el !== strip && !strip.contains(el) && !el.contains(strip))
          .filter((el) => {
            const style = getComputedStyle(el);
            if (style.visibility === 'hidden' || style.display === 'none') return false;
            const b = el.getBoundingClientRect();
            if (b.width === 0 || b.height === 0) return false;
            return b.left < s.right - 0.5 && b.right > s.left + 0.5 && b.top < s.bottom - 0.5 && b.bottom > s.top + 0.5;
          })
          .map((el) => `${el.tagName.toLowerCase()}.${el.className}`);
      });
      expect(overlaps, `${width}px`).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth), `${width}px`).toBeLessThanOrEqual(width);
    }

    // The strip sheds cells to fit instead of crowding the bar: everything on
    // a wide screen, and still the most serious problem, by name, on a small one.
    const strip = page.getByTestId('fleet-vitals-strip');
    await page.setViewportSize({ width: 1920, height: 950 });
    await expect(strip).toHaveAttribute('data-density', 'full');
    await expect(strip.locator('.vitals-cell')).toHaveCount(7);
    await page.setViewportSize({ width: 1280, height: 950 });
    await expect(strip).toHaveAttribute('data-density', 'worst');
    await expect(strip).toHaveText('VRAM100%');
  });

  test('a machine without a GPU shows no GPU or VRAM anywhere', async ({ page }) => {
    await page.addInitScript(() => {
      try { window.localStorage.setItem('kookr:vitalsPinned', 'true'); } catch { /* ignore */ }
    });
    await openDashboard(page, { gpu: false });
    await expect(page.getByTestId('fleet-vitals-strip')).toHaveText('CPU66%Running15tok/s≥110');
    await page.getByTestId('system-indicator').click();
    await expect(page.getByTestId('fleet-vitals').getByRole('meter')).toHaveCount(2);
    await expect(page.getByTestId('fleet-vitals')).not.toContainText('VRAM');
  });
});

/**
 * E2E tests for the first-run onboarding tour.
 *
 * Coverage matches the v5 RFC's test plan:
 *  - Fresh storage shows tour on load
 *  - Skip dismisses and reload doesn't re-show
 *  - Command palette Help action → "Take the product tour" re-shows from HelpDialog
 *  - Esc closes
 *  - Focus is inside the modal at open
 *  - Backdrop click on Card 3 closes without spawning LaunchDialog
 *  - Body class swaps with active card
 *  - Contract: every TOUR_TARGET_CLASSES entry resolves to ≥1 live element
 *
 * Each test seeds storage explicitly via `page.evaluate` after an initial
 * `page.goto('/')` (the same pattern launch-dialog-dismiss.spec.ts uses) so
 * subsequent reloads don't reset the key.
 */
import { test, expect } from './fixtures.js';
import { STORAGE_KEY as KEY } from '../src/frontend/store/onboarding-status.js';
import { TOUR_TARGET_CLASSES } from '../src/frontend/components/onboarding-tour-targets.js';

// Tour spec opts out of the fixture's automatic pre-mark so we can exercise
// the real first-run trigger. Each test seeds storage explicitly.
test.use({ suppressOnboarding: false });

async function seedFresh(page: import('@playwright/test').Page): Promise<void> {
  // Storage starts empty in a fresh context; just navigate.
  await page.goto('/');
  await expect(page.locator('.logo')).toHaveText('KOOKR');
}

async function seedSeen(page: import('@playwright/test').Page): Promise<void> {
  // Pre-mark via init script so it persists across reloads.
  await page.addInitScript((key) => {
    try { window.localStorage.setItem(key, 'true'); }
    catch { /* ignore */ }
  }, KEY);
  await page.goto('/');
  await expect(page.locator('.logo')).toHaveText('KOOKR');
}

test.describe('Onboarding tour', () => {
  test('fresh storage shows the tour on load', async ({ page }) => {
    await seedFresh(page);
    await expect(page.locator('[data-testid="onboarding-overlay"]')).toBeVisible();
    await expect(page.locator('.onboarding-tour')).toBeVisible();
    await expect(page.locator('.onboarding-tour h3')).toHaveText('Welcome to Kookr');
    const demo = page.getByRole('link', { name: 'Watch the 2-minute demo' });
    await expect(demo).toHaveAttribute('href', 'https://youtu.be/DHZrO8T_6Xg');
    await expect(demo).toHaveAttribute('target', '_blank');
    await expect(demo).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test('Skip dismisses the tour and reload does not re-show', async ({ page }) => {
    await seedFresh(page);
    await expect(page.locator('.onboarding-tour')).toBeVisible();
    await page.locator('[data-testid="onboarding-skip"]').click();
    await expect(page.locator('.onboarding-tour')).not.toBeVisible();

    await page.reload();
    await expect(page.locator('.logo')).toHaveText('KOOKR');
    await expect(page.locator('.onboarding-tour')).not.toBeVisible();
  });

  test('onboarding=0 query param suppresses the first-run tour', async ({ page }) => {
    await page.goto('/?onboarding=0');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
    await expect(page.locator('[data-testid="onboarding-overlay"]')).not.toBeVisible();
    await expect(page.locator('.onboarding-tour')).not.toBeVisible();
  });

  test('? button opens HelpDialog with "Take the product tour" CTA that re-shows the tour', async ({ page }) => {
    await seedSeen(page);
    await expect(page.locator('.onboarding-tour')).not.toBeVisible();

    await page.getByTestId('command-trigger').click();
    await page.getByTestId('command-palette-input').fill('help');
    await page.locator('[data-testid="command-palette-action"][data-action-id="shortcuts"]').click();
    await expect(page.locator('.shortcuts-help')).toBeVisible();
    await expect(page.locator('.shortcuts-header h3')).toHaveText('Help & Shortcuts');

    await page.getByRole('button', { name: 'Take the product tour' }).click();
    await expect(page.locator('.shortcuts-help')).not.toBeVisible();
    await expect(page.locator('.onboarding-tour')).toBeVisible();
    await expect(page.locator('.onboarding-tour h3')).toHaveText('Welcome to Kookr');
  });

  test('Esc closes the tour', async ({ page }) => {
    await seedFresh(page);
    await expect(page.locator('.onboarding-tour')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.onboarding-tour')).not.toBeVisible();
  });

  test('focus is inside the modal at open', async ({ page }) => {
    await seedFresh(page);
    await expect(page.locator('.onboarding-tour')).toBeVisible();

    // Active element must be inside the modal — we don't pin it to a specific
    // button to stay robust against extension overlays that snipe focus
    // momentarily.
    const focusInsideModal = await page.evaluate(() => {
      const modal = document.querySelector('.onboarding-tour');
      return !!modal && !!document.activeElement && modal.contains(document.activeElement);
    });
    expect(focusInsideModal).toBe(true);
  });

  test('backdrop click on Card 3 closes the tour and does not open LaunchDialog', async ({ page }) => {
    await seedFresh(page);
    await expect(page.locator('.onboarding-tour')).toBeVisible();

    // Advance to Card 3 — the card whose ring spotlights the + Launch button.
    await page.keyboard.press('ArrowRight'); // -> Card 2
    await page.keyboard.press('ArrowRight'); // -> Card 3
    await expect(page.locator('.onboarding-tour h3')).toHaveText('Launching an agent');

    // Click the overlay backdrop at a corner that we know is overlay (not the
    // centred dialog).
    const overlay = page.locator('.onboarding-overlay');
    await overlay.click({ position: { x: 5, y: 5 }, force: true });

    await expect(page.locator('.onboarding-tour')).not.toBeVisible();
    // LaunchDialog must NOT have opened — backdrop click must be isolated.
    await expect(page.locator('.dialog')).not.toBeVisible();
  });

  test('final card launch action closes the tour and opens the Launch dialog', async ({ page }) => {
    await seedFresh(page);
    await expect(page.locator('.onboarding-tour h3')).toHaveText('Welcome to Kookr');

    // Advance to the final card (Welcome -> ... -> Findings and routing).
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    await expect(page.locator('.onboarding-tour h3')).toHaveText('Findings and routing');

    // The terminal card offers a launch conversion alongside a Done dismiss.
    const launch = page.locator('[data-testid="onboarding-launch-first-task"]');
    await expect(launch).toHaveText('Launch your first agent');
    await launch.click();

    // Tour tears down; the existing Launch dialog opens (no aria-modal collision).
    await expect(page.locator('.onboarding-tour')).not.toBeVisible();
    await expect(page.locator('#launch-task-dialog-title')).toHaveText('Launch New Task');
  });

  test('First-launch readiness opens Diagnostics after tearing down the tour', async ({ page }) => {
    await seedFresh(page);
    await expect(page.locator('.onboarding-tour h3')).toHaveText('Welcome to Kookr');

    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    await expect(page.locator('.onboarding-tour h3')).toHaveText('First-launch readiness');

    await page.getByTestId('onboarding-check-setup').click();

    await expect(page.locator('.onboarding-tour')).not.toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Diagnostics' })).toBeVisible();
  });

  test('body class swaps to match the active card targetClass', async ({ page }) => {
    await seedFresh(page);
    await expect(page.locator('.onboarding-tour')).toBeVisible();

    // Card 1 has no targetClass.
    await expect(page.locator('body')).not.toHaveClass(/kookr-tour-active-/);

    // Card 2 = layout.
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('body')).toHaveClass(/kookr-tour-active-layout/);

    // Spotlight ring must use amber (#fbbf24) for contrast against the dark
    // dashboard — guards against an accidental revert to accent-blue.
    const ringColor = await page
      .locator('.kookr-tour-target-layout')
      .first()
      .evaluate((el) => getComputedStyle(el).outlineColor);
    expect(ringColor).toMatch(/251,\s*191,\s*36/);

    // Card 3 = launch.
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('body')).toHaveClass(/kookr-tour-active-launch/);

    // Card 4 = readiness guidance, no spotlight target.
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.onboarding-tour h3')).toHaveText('First-launch readiness');
    await expect(page.locator('body')).not.toHaveClass(/kookr-tour-active-/);

    // Card 5 = shortcut guidance, no spotlight target.
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.onboarding-tour h3')).toHaveText('Shortcuts that save clicks');
    await expect(page.locator('body')).not.toHaveClass(/kookr-tour-active-/);

    // Card 6 = findings.
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('body')).toHaveClass(/kookr-tour-active-findings/);

    // Closing the tour must remove all kookr-tour-active-* classes.
    await page.keyboard.press('Escape');
    await expect(page.locator('.onboarding-tour')).not.toBeVisible();
    await expect(page.locator('body')).not.toHaveClass(/kookr-tour-active-/);
  });

  test('Enter advances exactly one card (regression: keyboard handler used to double-fire with focused button)', async ({ page }) => {
    await seedFresh(page);
    await expect(page.locator('.onboarding-tour h3')).toHaveText('Welcome to Kookr');
    await page.keyboard.press('Enter');
    await expect(page.locator('.onboarding-tour h3')).toHaveText('The four panes');
    await page.keyboard.press('Enter');
    await expect(page.locator('.onboarding-tour h3')).toHaveText('Launching an agent');
  });

  test('? key while tour is open does not stack ShortcutsHelp on top', async ({ page }) => {
    await seedFresh(page);
    await expect(page.locator('.onboarding-tour')).toBeVisible();
    await page.keyboard.press('?');
    // Tour stays open; ShortcutsHelp does not appear.
    await expect(page.locator('.onboarding-tour')).toBeVisible();
    await expect(page.locator('.shortcuts-help')).not.toBeVisible();
  });

  test('contract: every targetClass resolves to ≥ 1 live element', async ({ page }) => {
    await seedFresh(page);
    await expect(page.locator('.onboarding-tour')).toBeVisible();
    // Wait for non-modal app to render.
    await expect(page.locator('.topbar')).toBeVisible();

    // Imports TOUR_TARGET_CLASSES from the component itself so a new card's
    // targetClass is automatically covered without editing the test.
    for (const cls of TOUR_TARGET_CLASSES) {
      const matches = await page.locator(`.kookr-tour-target-${cls}`).count();
      expect(matches, `targetClass "${cls}" must have ≥1 live element`).toBeGreaterThanOrEqual(1);
    }
  });
});

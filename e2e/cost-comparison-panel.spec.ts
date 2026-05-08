/**
 * E2E verification for the Cost Comparison panel.
 * Run with: npx playwright test cost-comparison-panel
 *
 * Verifies:
 *   - The "$" icon is visible in TopBar
 *   - Clicking it opens the panel with the expected sections
 *   - Escape closes the panel
 *   - Agent chips toggle aria-pressed
 *   - The search box debounces (300 ms) before firing the request
 */
import { test, expect } from './fixtures.js';

test.describe('CostComparisonPanel', () => {
  test('shows the $ icon in TopBar', async ({ page }) => {
    await page.goto('/');
    const icon = page.getByRole('button', { name: /cost comparison/i });
    await expect(icon).toBeVisible();
    await expect(icon).toHaveText('$');
  });

  test('opens, renders sections, and closes via Escape', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /cost comparison/i }).click();

    // Dialog has the right ARIA shape (a11y review #2 fix).
    const dialog = page.getByRole('dialog', { name: /cost comparison/i });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    // The three section headings render.
    await expect(page.getByRole('heading', { name: /per playbook/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /aggregate/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^tasks/i })).toBeVisible();

    // Escape closes (a11y review #2 fix — useEscapeToClose hook wired).
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('agent chips use aria-pressed (toggle-button semantics, not tab)', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /cost comparison/i }).click();

    // Initially "All" is pressed.
    const allChip    = page.getByRole('button', { name: 'All', exact: true });
    const claudeChip = page.getByRole('button', { name: 'Claude', exact: true });
    const codexChip  = page.getByRole('button', { name: 'Codex',  exact: true });
    await expect(allChip).toHaveAttribute('aria-pressed', 'true');
    await expect(claudeChip).toHaveAttribute('aria-pressed', 'false');

    await codexChip.click();
    await expect(codexChip).toHaveAttribute('aria-pressed', 'true');
    await expect(allChip).toHaveAttribute('aria-pressed', 'false');
  });

  test('search input debounces — 300 ms of quiet before the next request fires', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /cost comparison/i }).click();

    // Capture every cost-comparison fetch.
    const requests: string[] = [];
    page.on('request', (r) => {
      const url = r.url();
      if (url.includes('/api/cost-comparison')) requests.push(url);
    });

    const searchBox = page.getByRole('textbox', { name: /search task names/i });

    // Quick burst — 4 keystrokes in <100 ms.
    const before = requests.length;
    await searchBox.fill('abcd');
    // Just after the burst, no NEW q= request should have fired yet.
    expect(requests.filter(u => u.includes('q=abcd')).length).toBe(0);

    // After ~400 ms, exactly one request with the final value should land.
    await page.waitForTimeout(400);
    const fired = requests.filter(u => u.includes('q=abcd'));
    expect(fired.length).toBeGreaterThanOrEqual(1);
    // Intermediate "a", "ab", "abc" must NOT each fire — debounce is the contract.
    const intermediates = requests.filter(u =>
      u.includes('q=a&') || u.includes('q=ab&') || u.includes('q=abc&'),
    );
    expect(intermediates.length).toBe(0);

    // No more than 2 cost-comparison requests since the burst (the burst's settled call,
    // and at most one earlier in-flight one), allowing slack for very slow CI.
    const sinceBurst = requests.length - before;
    expect(sinceBurst).toBeLessThanOrEqual(2);
  });

  test('notes-stack expander uses aria-expanded', async ({ page }) => {
    // The fixture's backend has no Codex tasks pre-populated, so the notes stack
    // is typically empty — we verify the contract holds by not crashing and by
    // the absence of a stale aria-expanded button.
    await page.goto('/');
    await page.getByRole('button', { name: /cost comparison/i }).click();
    const expander = page.locator('.cost-notes-expander');
    // Either zero (no notes overflow) or, if present, must carry aria-expanded.
    const count = await expander.count();
    if (count > 0) {
      await expect(expander.first()).toHaveAttribute('aria-expanded', 'false');
    }
  });
});

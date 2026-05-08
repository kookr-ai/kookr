/**
 * Inverse verification: with KOOKR_COST_PANEL UNSET, the $ icon must NOT
 * appear in the TopBar. Run this spec alone in a fresh worker:
 *   unset KOOKR_COST_PANEL && npx playwright test cost-comparison-flag-off
 */
import { test, expect } from './fixtures.js';

test('with KOOKR_COST_PANEL unset, the $ icon is hidden', async ({ page }) => {
  await page.goto('/');
  // The icon's accessible label is exactly "Cost comparison". The button must
  // not exist when the route returns 404 — App.tsx probes on mount and only
  // wires `onCostComparison` when the response is ok.
  const icon = page.getByRole('button', { name: /cost comparison/i });
  await expect(icon).toHaveCount(0);
});

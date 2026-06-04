import { test, expect } from './fixtures.js';
import {
  resetServer,
  launchViaUI,
  getLatestTmuxName,
  getTasks,
  injectSessionStart,
  injectEditEvent,
  injectStopEvent,
} from './battle-helpers.js';
import type { APIRequestContext, Page } from '@playwright/test';
import { STORAGE_KEY as ONBOARDING_STORAGE_KEY } from '../src/frontend/store/onboarding-status.js';
import { DASHBOARD_SPLIT_KEY, MIN_FINDINGS_WIDTH } from '../src/frontend/store/dashboard-layout-prefs.js';

const PROJECT_ID = 'github.com/org/resizable-panel-split';

async function latestTaskId(request: APIRequestContext): Promise<string> {
  const tasks = await getTasks(request);
  const task = tasks.at(-1);
  expect(task?.id, 'latest task should exist').toBeTruthy();
  return task!.id;
}

async function setProjectId(request: APIRequestContext, taskId: string, projectId: string) {
  const response = await request.post('/api/test/set-project-id', { data: { taskId, projectId } });
  expect(response.ok()).toBe(true);
}

async function broadcastProjectSummaries(request: APIRequestContext) {
  const response = await request.post('/api/test/broadcast-project-summaries');
  expect(response.ok()).toBe(true);
}

async function seedTask(page: Page, request: APIRequestContext) {
  await launchViaUI(page, 'Resizable split task', '/test/resizable-panel-split');
  const taskId = await latestTaskId(request);
  const tmuxName = await getLatestTmuxName(request);
  await injectSessionStart(request, tmuxName);
  await injectEditEvent(request, tmuxName, '/test/resizable-panel-split/src/app.tsx', 'resizable-panel-split', 'before', 'after');
  await injectStopEvent(request, tmuxName, 'Need a layout decision.');
  await setProjectId(request, taskId, PROJECT_ID);
  await broadcastProjectSummaries(request);
}

async function selectTask(page: Page) {
  await expect(page.locator('[data-testid="project-sidebar"]')).toBeVisible();
  await page.locator(`[data-testid="project-icon-${PROJECT_ID}"]`).click();
  await expect(page.getByTestId('project-detail-drawer')).toBeVisible();
  await page.locator('.finding-card').first().click();
  await expect(page.getByTestId('detail-panel')).toBeVisible();
}

function findingsWidth(page: Page): Promise<number> {
  return page.locator('.findings-panel').evaluate((el) => el.getBoundingClientRect().width);
}

test.describe('Resizable findings/terminal split', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.addInitScript(({ onboardingStorageKey, splitKey }) => {
      // Clear the persisted split once per browser context so a reload within a
      // test keeps the value the test just wrote.
      if (!sessionStorage.getItem('kookr-resizable-split-init')) {
        localStorage.removeItem(splitKey);
        sessionStorage.setItem('kookr-resizable-split-init', '1');
      }
      localStorage.setItem(onboardingStorageKey, 'true');
    }, { onboardingStorageKey: ONBOARDING_STORAGE_KEY, splitKey: DASHBOARD_SPLIT_KEY });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('drag widens the findings panel and the split persists across reload', async ({ page, request }) => {
    await seedTask(page, request);
    await selectTask(page);

    const resizer = page.getByTestId('findings-resizer');
    await expect(resizer).toBeVisible();
    await expect(resizer).toHaveAttribute('role', 'separator');
    await expect(resizer).toHaveAttribute('aria-orientation', 'vertical');
    await expect(page.locator('.terminal-xterm .xterm-screen')).toBeVisible();

    const startWidth = await findingsWidth(page);

    // Drag the divider to the right to widen the findings panel.
    const box = await resizer.boundingBox();
    expect(box).not.toBeNull();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 160, cy, { steps: 12 });
    await page.mouse.up();

    const widened = await findingsWidth(page);
    expect(widened).toBeGreaterThan(startWidth + 100);

    // Persisted to localStorage and reflects the live width.
    const stored = await page.evaluate((key) => localStorage.getItem(key), DASHBOARD_SPLIT_KEY);
    expect(stored).not.toBeNull();
    expect(Math.abs(Number(stored) - widened)).toBeLessThan(8);

    // Survives a reload.
    await page.reload();
    await expect(page.locator('.logo')).toHaveText('KOOKR');
    await selectTask(page);
    const afterReload = await findingsWidth(page);
    expect(Math.abs(afterReload - widened)).toBeLessThan(8);
  });

  test('a committed wide split re-clamps when the viewport narrows so the terminal stays usable', async ({ page, request }) => {
    await seedTask(page, request);
    await selectTask(page);

    const resizer = page.getByTestId('findings-resizer');
    // End drives the panel to its widest allowed value at the current width.
    await resizer.focus();
    await resizer.press('End');
    const wide = await findingsWidth(page);

    // Narrow the desktop viewport. The committed width no longer fits, so the
    // panel must shrink to keep the terminal viewport above its reserve.
    await page.setViewportSize({ width: 900, height: 900 });
    await expect.poll(() => findingsWidth(page)).toBeLessThan(wide);
    // 900 - 480 reserve = 420 max; allow a small rounding margin.
    await expect.poll(() => findingsWidth(page)).toBeLessThanOrEqual(421);
  });

  test('separator is keyboard-resizable and clamps at the minimum', async ({ page, request }) => {
    await seedTask(page, request);
    await selectTask(page);

    const resizer = page.getByTestId('findings-resizer');
    await resizer.focus();
    const startWidth = await findingsWidth(page);

    // Arrow keys nudge the split.
    await resizer.press('ArrowLeft');
    await resizer.press('ArrowLeft');
    await expect.poll(() => findingsWidth(page)).toBeLessThan(startWidth);

    // Home collapses to the documented minimum, never below it.
    await resizer.press('Home');
    await expect.poll(() => findingsWidth(page)).toBeLessThanOrEqual(MIN_FINDINGS_WIDTH + 1);
    await expect.poll(() => findingsWidth(page)).toBeGreaterThanOrEqual(MIN_FINDINGS_WIDTH - 1);
    await expect.poll(
      () => page.evaluate((key) => localStorage.getItem(key), DASHBOARD_SPLIT_KEY),
    ).toBe(String(MIN_FINDINGS_WIDTH));
  });
});

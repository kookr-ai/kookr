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

const PROJECT_ID = 'github.com/org/detail-pane-visibility';
const DETAIL_PANE_MODE_STORAGE_KEY = 'kookr-detail-panel-mode';

async function latestTaskId(request: APIRequestContext): Promise<string> {
  const tasks = await getTasks(request);
  const task = tasks.at(-1);
  expect(task?.id, 'latest task should exist').toBeTruthy();
  return task!.id;
}

async function setProjectId(request: APIRequestContext, taskId: string, projectId: string) {
  const response = await request.post('/api/test/set-project-id', {
    data: { taskId, projectId },
  });
  expect(response.ok()).toBe(true);
}

async function broadcastProjectSummaries(request: APIRequestContext) {
  const response = await request.post('/api/test/broadcast-project-summaries');
  expect(response.ok()).toBe(true);
}

async function seedDetailTask(page: Page, request: APIRequestContext) {
  await launchViaUI(page, 'Detail pane visibility task', '/test/detail-pane-visibility');
  const taskId = await latestTaskId(request);
  const tmuxName = await getLatestTmuxName(request);
  await injectSessionStart(request, tmuxName);
  await injectEditEvent(request, tmuxName, '/test/detail-pane-visibility/src/app.tsx', 'detail-pane-visibility', 'before', 'after');
  await injectStopEvent(request, tmuxName, 'Need a layout decision.');
  await setProjectId(request, taskId, PROJECT_ID);
  await broadcastProjectSummaries(request);
}

async function selectDetailTask(page: Page) {
  await expect(page.locator('[data-testid="project-sidebar"]')).toBeVisible();
  await page.locator(`[data-testid="project-icon-${PROJECT_ID}"]`).click();
  await expect(page.getByTestId('project-detail-drawer')).toBeVisible();
  await page.locator('.finding-card').first().click();
  await expect(page.getByTestId('detail-panel')).toBeVisible();
}

test.describe('Detail pane visibility controls', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.addInitScript(({ onboardingStorageKey, detailPaneModeStorageKey }) => {
      if (!sessionStorage.getItem('kookr-detail-pane-visibility-init')) {
        localStorage.removeItem(detailPaneModeStorageKey);
        localStorage.removeItem('kookr-terminal-focus-mode');
        sessionStorage.setItem('kookr-detail-pane-visibility-init', '1');
      }
      localStorage.setItem(onboardingStorageKey, 'true');
    }, {
      onboardingStorageKey: ONBOARDING_STORAGE_KEY,
      detailPaneModeStorageKey: DETAIL_PANE_MODE_STORAGE_KEY,
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('supports split, activity-only, terminal-only, restore, and reload persistence', async ({ page, request }) => {
    await seedDetailTask(page, request);
    await selectDetailTask(page);

    await expect(page.locator('.detail-split-left')).toBeVisible();
    await expect(page.locator('.detail-split-right')).toBeVisible();
    await expect(page.locator('.terminal-xterm .xterm-screen')).toBeVisible();

    await page.getByRole('button', { name: 'Hide terminal/diff pane' }).click();
    await expect(page.locator('.detail-panel.detail-left-only')).toBeVisible();
    await expect(page.locator('.detail-split-left')).toBeVisible();
    await expect(page.locator('.detail-split-right')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Show terminal/diff pane' })).toBeVisible();
    await expect(page.locator('.terminal-xterm')).toBeHidden();
    await expect.poll(
      () => page.evaluate((key) => localStorage.getItem(key), DETAIL_PANE_MODE_STORAGE_KEY),
    ).toBe('left');

    await page.getByRole('button', { name: 'Show terminal/diff pane' }).click();
    await expect(page.locator('.detail-split-left')).toBeVisible();
    await expect(page.locator('.detail-split-right')).toBeVisible();
    await expect.poll(
      () => page.evaluate((key) => localStorage.getItem(key), DETAIL_PANE_MODE_STORAGE_KEY),
    ).toBeNull();

    await page.getByRole('button', { name: /terminal focus/i }).click();
    await expect(page.locator('.detail-panel.terminal-focus')).toBeVisible();
    await expect(page.locator('.detail-split-left')).toHaveCount(0);
    await expect(page.locator('.detail-split-right')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show Activity/GitHub pane' })).toBeVisible();
    await expect(page.locator('.terminal-xterm .xterm-screen')).toBeVisible();
    await expect.poll(
      () => page.evaluate((key) => localStorage.getItem(key), DETAIL_PANE_MODE_STORAGE_KEY),
    ).toBe('right');

    await page.getByRole('button', { name: 'Show Activity/GitHub pane' }).click();
    await expect(page.locator('.detail-split-left')).toBeVisible();
    await expect(page.locator('.detail-split-right')).toBeVisible();

    await page.getByRole('button', { name: 'Hide terminal/diff pane' }).click();
    await page.reload();
    await expect(page.locator('.logo')).toHaveText('KOOKR');
    await selectDetailTask(page);

    await expect(page.locator('.detail-panel.detail-left-only')).toBeVisible();
    await expect(page.locator('.detail-split-left')).toBeVisible();
    await expect(page.locator('.detail-split-right')).toBeHidden();
    await expect.poll(
      () => page.evaluate((key) => localStorage.getItem(key), DETAIL_PANE_MODE_STORAGE_KEY),
    ).toBe('left');
  });
});

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

type TerminalBudget = {
  width: number;
  height: number;
  cols: number;
  rows: number;
};

const PROJECT_ID = 'github.com/org/terminal-budget';

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

async function seedTerminalBudgetTask(page: Page, request: APIRequestContext) {
  await launchViaUI(page, 'Terminal viewport budget task', '/test/terminal-budget');
  const taskId = await latestTaskId(request);
  const tmuxName = await getLatestTmuxName(request);
  await injectSessionStart(request, tmuxName);
  await injectEditEvent(request, tmuxName, '/test/terminal-budget/src/dashboard.tsx', 'tu-budget', 'before', 'after');
  await injectStopEvent(request, tmuxName, 'Need a dashboard decision.');
  await setProjectId(request, taskId, PROJECT_ID);
  await broadcastProjectSummaries(request);
  return { taskId };
}

async function selectBudgetTask(page: Page) {
  await expect(page.locator('[data-testid="project-sidebar"]')).toBeVisible();
  await page.locator(`[data-testid="project-icon-${PROJECT_ID}"]`).click();
  await expect(page.getByTestId('project-detail-drawer')).toBeVisible();
  await page.locator('.finding-card').first().click();
  await expect(page.locator('.terminal-xterm .xterm-screen')).toBeVisible();
}

async function readTerminalBudget(page: Page): Promise<TerminalBudget> {
  return page.locator('.terminal-xterm').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const core = element.querySelector('.xterm-screen') as HTMLElement | null;
    const row = element.querySelector('.xterm-rows > div') as HTMLElement | null;
    const span = row?.querySelector('span') as HTMLElement | null;
    const rowRect = row?.getBoundingClientRect();
    const spanRect = span?.getBoundingClientRect();
    const charCount = span?.textContent?.length ?? 0;
    // xterm renders rows asynchronously; fall back to conservative 12px-font
    // cell dimensions so a blank first frame still produces a useful budget.
    const cellWidth = spanRect && charCount > 0 ? spanRect.width / charCount : 7;
    const cellHeight = rowRect?.height && rowRect.height > 0 ? rowRect.height : 14;

    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      cols: Math.floor((core?.getBoundingClientRect().width ?? rect.width) / cellWidth),
      rows: Math.floor((core?.getBoundingClientRect().height ?? rect.height) / cellHeight),
    };
  });
}

async function expectTerminalBudget(page: Page, minimum: TerminalBudget, label: string) {
  for (const metric of ['width', 'height', 'cols', 'rows'] as const) {
    await expect.poll(
      async () => (await readTerminalBudget(page))[metric],
      { message: `${label} ${metric} budget`, timeout: 5_000 },
    ).toBeGreaterThanOrEqual(minimum[metric]);
  }
}

test.describe('Terminal viewport budgets', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.addInitScript(() => {
      localStorage.removeItem('kookr-terminal-focus-mode');
      localStorage.setItem('kookr:onboarding:seen-v1', 'true');
    });
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('desktop dashboard chrome keeps the selected terminal above the minimum budget', async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { taskId } = await seedTerminalBudgetTask(page, request);
    const githubResponse = await request.post('/api/test/broadcast-github', {
      data: {
        taskId,
        prs: [{ number: 77, title: 'Viewport budget PR', url: 'https://github.com/org/terminal-budget/pull/77', state: 'open' }],
        issues: [{ number: 561, title: 'Viewport budget issue', url: 'https://github.com/org/terminal-budget/issues/561', state: 'open' }],
      },
    });
    expect(githubResponse.ok()).toBe(true);

    await selectBudgetTask(page);
    await expect(page.locator('.detail-split-left')).toBeVisible();
    await expect(page.getByTestId('project-detail-drawer')).toBeVisible();
    await expect(page.getByRole('button', { name: /GitHub/ })).toBeVisible();

    await expectTerminalBudget(page, { width: 400, height: 560, cols: 50, rows: 34 }, 'desktop terminal');
  });

  test('terminal focus mode restores a wide desktop terminal budget', async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedTerminalBudgetTask(page, request);
    await selectBudgetTask(page);

    await page.getByRole('button', { name: /terminal focus/i }).click();
    await expect(page.locator('.detail-panel.terminal-focus')).toBeVisible();
    await expect(page.getByTestId('project-detail-drawer')).toHaveCount(0);
    await expect(page.locator('.detail-split-left')).toHaveCount(0);

    await expectTerminalBudget(page, { width: 950, height: 600, cols: 115, rows: 36 }, 'terminal focus');
  });

  test('mobile task tab retains visible terminal geometry', async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seedTerminalBudgetTask(page, request);

    await expect(page.getByTestId('mobile-dashboard-tabs')).toBeVisible();
    await page.locator('.finding-card').first().click();
    await expect(page.getByTestId('mobile-tab-task')).toHaveClass(/active/);
    await page.getByTestId('detail-panel').getByRole('button', { name: 'Terminal' }).click();
    await expect(page.locator('.terminal-xterm .xterm-screen')).toBeVisible();

    await expectTerminalBudget(page, { width: 340, height: 80, cols: 40, rows: 5 }, 'mobile terminal');
  });
});

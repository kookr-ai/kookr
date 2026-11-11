import { test, expect } from './fixtures.js';
import { resetServer, getTmuxNameForPrompt, injectSessionStart, injectToolUse, injectStopEvent, openTerminalTab } from './battle-helpers.js';
import type { APIRequestContext, Page } from '@playwright/test';

// #3561 slice 4b: the reading pane's header (one meta line, one main action
// plus a More actions menu), the facts column and the decision card.

async function launchTask(page: Page, request: APIRequestContext, prompt: string, finding: boolean) {
  const res = await request.post('/api/tasks', { data: { prompt, cwd: '/tmp' } });
  expect(res.ok(), await res.text()).toBe(true);
  const tmux = await getTmuxNameForPrompt(request, prompt);
  await injectSessionStart(request, tmux);
  await injectToolUse(request, tmux);
  if (finding) await injectStopEvent(request, tmux, 'Done. Should I open the PR now?');
}

test.beforeEach(async ({ request, page }) => {
  await resetServer(request);
  await page.goto('/');
  await expect(page.locator('.health-dot-connected')).toBeVisible({ timeout: 10_000 });
});

test('a working task shows one main action; Cancel waits in More actions and Escape returns focus', async ({ page, request }) => {
  await launchTask(page, request, 'Reading pane working task', false);
  await page.locator('.healthy-row').first().click();

  const header = page.locator('.detail-header');
  await expect(header.getByTestId('action-complete')).toBeVisible();
  await expect(header.getByTestId('detail-state-chip')).toHaveText('Working');
  await expect(page.getByTestId('action-cancel')).toHaveCount(0);
  await expect(page.getByTestId('action-reflect')).toHaveCount(0);

  const more = page.getByTestId('detail-more-actions');
  await more.click();
  await expect(page.getByRole('menu', { name: 'More actions' })).toBeVisible();
  await expect(page.getByTestId('action-reflect')).toBeFocused();
  await expect(page.getByTestId('action-cancel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: 'More actions' })).toHaveCount(0);
  await expect(more).toBeFocused();
  // Escape closed only the menu, not the task selection.
  await expect(page.locator('.detail-header h2')).toBeVisible();
});

test('the facts column docks on a wide pane and opens over a narrow one from Details', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await launchTask(page, request, 'Reading pane facts task', false);
  await page.locator('.healthy-row').first().click();

  const facts = page.getByTestId('detail-facts');
  await expect(facts).toBeVisible();
  await expect(facts).not.toHaveClass(/detail-facts--overlay/);
  await expect(facts.getByTestId('task-share-button')).toBeVisible();
  await expect(facts.getByTestId('task-dependencies')).toBeVisible();
  await expect(facts.getByTestId('task-timeline')).toBeVisible();
  await expect(page.getByTestId('detail-facts-toggle')).toHaveCount(0);

  await page.setViewportSize({ width: 1024, height: 800 });
  await expect(facts).toHaveCount(0);
  const toggle = page.getByTestId('detail-facts-toggle');
  await toggle.click();
  await expect(facts).toHaveClass(/detail-facts--overlay/);
  await expect(page.getByRole('button', { name: 'Close details' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(facts).toHaveCount(0);
  await expect(toggle).toBeFocused();
});

test('a finding docks the decision card above the reply box; the Terminal tab folds it away', async ({ page, request }) => {
  await launchTask(page, request, 'Reading pane finding task', true);
  await page.locator('.finding-card').first().click();

  const card = page.getByTestId('decision-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Signaled Complete');
  const cardBox = await card.boundingBox();
  const replyBox = await page.locator('.response-row textarea').boundingBox();
  expect(cardBox && replyBox && cardBox.y + cardBox.height <= replyBox.y).toBe(true);

  await openTerminalTab(page);
  await expect(card).toHaveCount(0);
  await page.locator('.detail-tabs').getByRole('button', { name: 'Conversation' }).click();
  await expect(card).toBeVisible();
});

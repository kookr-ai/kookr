/**
 * Labelled navigation (#3561 slice 5a, variant B "triage inbox").
 *
 * At 1280 px and wider, queues with counts and projects by name replace the
 * 52 px icon rail; under 1280 px the same navigation collapses to today's
 * icons. Projects without live work sit behind one "All N projects" toggle
 * in the labelled layout only.
 */
import { test, expect } from './fixtures.js';
import { resetServer } from './reset-server.js';
import type { APIRequestContext } from '@playwright/test';
import { getTmuxNameForPrompt, injectSessionStart, injectStopEvent, injectToolUse } from './battle-helpers.js';

async function launch(request: APIRequestContext, prompt: string): Promise<string> {
  const res = await request.post('/api/tasks', { data: { prompt, cwd: '/tmp' } });
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()).id as string;
}

async function setProjectId(request: APIRequestContext, taskId: string, projectId: string) {
  const res = await request.post('/api/test/set-project-id', { data: { taskId, projectId } });
  expect(res.ok()).toBe(true);
}

test.describe('labelled navigation (#3561 slice 5a)', () => {
  test.beforeEach(async ({ request }) => {
    await resetServer(request);
  });

  test('queues and named projects at 1280 px, icons under 1280 px', async ({ page, request }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await expect(page.locator('.health-dot-connected')).toBeVisible({ timeout: 10000 });

    const waitingId = await launch(request, 'Nav waiting task');
    const waitingTmux = await getTmuxNameForPrompt(request, 'Nav waiting task');
    await injectSessionStart(request, waitingTmux);
    await injectStopEvent(request, waitingTmux, 'Should I open the PR now?');
    await setProjectId(request, waitingId, 'github.com/org/waiting');

    const workingId = await launch(request, 'Nav working task');
    const workingTmux = await getTmuxNameForPrompt(request, 'Nav working task');
    await injectSessionStart(request, workingTmux);
    await injectToolUse(request, workingTmux);
    await setProjectId(request, workingId, 'github.com/org/working');

    const finishedId = await launch(request, 'Nav finished task');
    const finishedTmux = await getTmuxNameForPrompt(request, 'Nav finished task');
    await injectSessionStart(request, finishedTmux);
    await setProjectId(request, finishedId, 'github.com/org/idle');
    expect((await request.post(`/api/test/complete-task/${finishedId}`)).ok()).toBe(true);

    await expect(page.locator('.finding-card')).toHaveCount(1, { timeout: 15000 });
    expect((await request.post('/api/test/broadcast-project-summaries')).ok()).toBe(true);

    const nav = page.getByTestId('project-sidebar');
    await expect(nav).toBeVisible({ timeout: 5000 });
    await expect.poll(async () => Math.round((await nav.boundingBox())?.width ?? 0)).toBe(212);

    // Queues carry the same counts as the list sections.
    await expect(page.getByTestId('nav-queue-needs-you').locator('.project-nav-count')).toHaveText('1');
    await expect(page.getByTestId('nav-queue-working').locator('.project-nav-count')).toHaveText('1');
    await expect(page.getByTestId('nav-queue-finished').locator('.project-nav-count')).toHaveText('1');
    await expect(page.getByTestId('nav-queue-scheduled')).toBeVisible();

    // Projects are listed by name; the idle one waits behind the toggle.
    const waiting = page.getByTestId('project-icon-github.com/org/waiting');
    await expect(waiting.locator('.project-nav-name')).toBeVisible();
    await expect(waiting.locator('.project-icon-badge.anomaly')).toHaveText('1');
    await expect(page.getByTestId('project-icon-all').locator('.project-nav-name')).toHaveText('All projects');
    const idle = page.getByTestId('project-icon-github.com/org/idle');
    await expect(idle).toBeHidden();
    const toggle = page.getByTestId('project-nav-idle-toggle');
    await expect(toggle).toHaveText(/^All \d+ projects$/);
    await toggle.click();
    await expect(idle).toBeVisible();
    await expect(toggle).toHaveText('Hide idle projects');

    // Finished jumps to the (collapsed by default) Finished section and opens it.
    await expect(page.locator('.completed-section .completed-row')).toHaveCount(0);
    await page.getByTestId('nav-queue-finished').click();
    await expect(page.locator('.completed-section .completed-row')).toHaveCount(1);

    // A selected project opens its detail drawer, which already names the
    // project; the nav keeps the 52 px icon rail so the pane keeps main's width.
    await waiting.click();
    await expect(page.getByTestId('project-detail-drawer')).toBeVisible();
    await expect.poll(async () => Math.round((await nav.boundingBox())?.width ?? 0)).toBe(52);
    await expect(page.getByTestId('nav-queue-needs-you')).toBeHidden();
    await page.getByTestId('project-icon-all').click();
    await expect(page.getByTestId('project-detail-drawer')).toHaveCount(0);
    await expect.poll(async () => Math.round((await nav.boundingBox())?.width ?? 0)).toBe(212);

    // Under 1280 px the same rail is the icon column, with every project shown.
    await toggle.click();
    await expect(idle).toBeHidden();
    await page.setViewportSize({ width: 1279, height: 800 });
    await expect.poll(async () => Math.round((await nav.boundingBox())?.width ?? 0)).toBe(52);
    await expect(page.getByTestId('nav-queue-needs-you')).toBeHidden();
    await expect(waiting.locator('.project-nav-name')).toBeHidden();
    await expect(waiting.locator('.project-icon-letter')).toBeVisible();
    await expect(idle).toBeVisible();
    await expect(page.getByTestId('project-nav-idle-toggle')).toBeHidden();
  });
});

/**
 * A prompt the operator was typing in a task's terminal survives the task
 * being closed: reopening the task offers the unsent text back.
 *
 * Real browser, real xterm keystrokes, real complete + reopen through the API
 * (a reopened task runs in a new terminal session).
 */
import { test, expect } from './fixtures.js';
import {
  getTasks,
  getTmuxNameForPrompt,
  injectSessionStart,
  injectStopEvent,
  launchViaUI,
  openTerminalTab,
  resetServer,
} from './battle-helpers.js';

const PROMPT = 'Unsent Draft Recovery';
const DRAFT = 'mon long prompt pas fini';

test.describe('Unsent terminal draft recovery', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('a task closed while the operator types offers the text back on reopen', async ({ page, request }) => {
    await launchViaUI(page, PROMPT, '/test/unsent-draft');
    const firstSession = await getTmuxNameForPrompt(request, PROMPT);
    await injectSessionStart(request, firstSession);
    await injectStopEvent(request, firstSession, 'Done. Anything else?');

    await page.getByRole('button', { name: /All Projects/ }).click();
    await page.keyboard.press('Alt+n');
    await openTerminalTab(page);
    await expect(page.locator('.terminal-xterm .xterm-screen')).toBeVisible();
    await page.locator('.terminal-xterm').click();
    await page.keyboard.type(DRAFT);

    const tasks = (await getTasks(request)) as Array<{ id: string; prompt: string }>;
    const taskId = tasks.find((t) => t.prompt === PROMPT)!.id;
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage)
      .filter((k) => k.startsWith('kookr.unsentTerminalDraft.v1.')).length)).toBe(1);

    // The task is closed under the operator, then reopened: a new session.
    expect((await request.post(`/api/tasks/${taskId}/complete`, { data: {} })).ok()).toBe(true);
    expect((await request.post(`/api/tasks/${taskId}/reopen`, { data: {} })).ok()).toBe(true);
    await expect.poll(async () => {
      const all = (await getTasks(request)) as Array<{ id: string; status: string; sessions: Array<{ tmuxSession: string }> }>;
      const task = all.find((t) => t.id === taskId);
      return task?.status === 'inProgress' ? task.sessions.at(-1)?.tmuxSession : undefined;
    }, { timeout: 10_000 }).not.toBe(firstSession);
    const secondSession = await getTmuxNameForPrompt(request, PROMPT);
    expect(secondSession).not.toBe(firstSession);
    await injectSessionStart(request, secondSession);
    await injectStopEvent(request, secondSession, 'Resumed. What next?');
    // Closing the task cleared the selection: open it again, as the operator would.
    await page.getByRole('button', { name: `Signaled Complete ${PROMPT} unsent-draft` }).click();
    await openTerminalTab(page);

    const banner = page.getByRole('status', { name: 'Unsent draft recovered' });
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText(DRAFT);

    await banner.getByRole('button', { name: 'Restore into prompt' }).click();
    await expect(banner).toContainText('Restored into the prompt');
    await expect(banner.getByRole('button', { name: 'Restore again' })).toBeVisible();

    await banner.getByRole('button', { name: 'Dismiss recovered draft' }).click();
    await expect(banner).toBeHidden();
  });
});

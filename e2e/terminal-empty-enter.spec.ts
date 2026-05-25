import { test, expect } from './fixtures.js';
import {
  getLatestTmuxName,
  injectSessionStart,
  injectStopEvent,
  launchViaUI,
  resetServer,
} from './battle-helpers.js';
import type { APIRequestContext, Page } from '@playwright/test';

async function setTerminalPrompt(request: APIRequestContext, tmuxName: string, promptGlyph = '❯') {
  await setTerminalContent(request, tmuxName, `\r\n╭────────────────╮\r\n${promptGlyph} \r\n`);
}

async function setTerminalContent(request: APIRequestContext, tmuxName: string, text: string) {
  const response = await request.post('/api/test/set-terminal-content', {
    data: {
      tmuxName,
      content: {
        mode: 'instant',
        text,
      },
    },
  });
  expect(response.ok()).toBe(true);
}

async function launchStoppedTask(page: Page, request: APIRequestContext, prompt: string, cwd: string) {
  await launchViaUI(page, prompt, cwd);
  const tmuxName = await getLatestTmuxName(request);
  await setTerminalPrompt(request, tmuxName);
  await injectSessionStart(request, tmuxName);
  await injectStopEvent(request, tmuxName, 'Waiting for input.');
  return tmuxName;
}

async function selectedFindingName(page: Page): Promise<string> {
  return (await page.locator('.finding-card.selected .finding-task').textContent())?.trim() ?? '';
}

test.describe('Terminal empty Enter navigation', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('pressing Enter on an empty terminal prompt advances to the next task', async ({ page, request }) => {
    await launchStoppedTask(page, request, 'Terminal Empty Alpha', '/test/terminal-alpha');
    await launchStoppedTask(page, request, 'Terminal Empty Beta', '/test/terminal-beta');
    await expect(page.locator('.finding-card')).toHaveCount(2);

    await page.keyboard.press('Alt+n');
    const firstSelected = await selectedFindingName(page);
    await expect(page.locator('.terminal-xterm .xterm-screen')).toBeVisible();
    await page.locator('.terminal-xterm').click();

    await page.keyboard.press('Enter');

    await expect.poll(() => selectedFindingName(page), { timeout: 5000 }).not.toBe(firstSelected);
    const secondSelected = await selectedFindingName(page);

    await page.locator('.terminal-xterm').click();
    await page.keyboard.press('Enter');

    await expect.poll(() => selectedFindingName(page), { timeout: 5000 }).not.toBe(secondSelected);
  });

  test('pressing Enter advances when the terminal prompt is redrawn over a status line', async ({ page, request }) => {
    const tmuxA = await launchStoppedTask(page, request, 'Terminal Redraw Alpha', '/test/terminal-redraw-alpha');
    await setTerminalContent(request, tmuxA, '\r\nWorking (3s • esc to interrupt)\r❯ \x1b[K\r\n');
    await launchStoppedTask(page, request, 'Terminal Redraw Beta', '/test/terminal-redraw-beta');
    await expect(page.locator('.finding-card')).toHaveCount(2);

    await page.keyboard.press('Alt+n');
    const firstSelected = await selectedFindingName(page);
    await expect(page.locator('.terminal-xterm .xterm-screen')).toBeVisible();
    await expect(page.locator('.terminal-xterm')).toContainText('❯');
    await page.locator('.terminal-xterm').click();

    await page.keyboard.press('Enter');

    await expect.poll(() => selectedFindingName(page), { timeout: 5000 }).not.toBe(firstSelected);
  });
});

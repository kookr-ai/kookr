import { test, expect } from './fixtures.js';
import {
  getLatestTmuxName,
  injectSessionStart,
  injectStopEvent,
  injectToolUse,
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

async function showAllProjects(page: Page) {
  await page.getByRole('button', { name: /All Projects/ }).click();
}

async function showTerminalPane(page: Page) {
  const restore = page.getByRole('button', { name: 'Show terminal/diff pane' });
  if (await restore.isVisible()) {
    await restore.click();
  }
  const terminalTab = page.locator('.detail-split-right').getByRole('button', { name: 'Terminal', exact: true });
  if (await terminalTab.isVisible()) {
    await terminalTab.click();
  }
}

async function selectedFindingName(page: Page): Promise<string> {
  return (await page.locator('.finding-card.selected .finding-task').textContent())?.trim() ?? '';
}

async function selectedHealthyName(page: Page): Promise<string> {
  return (await page.locator('.healthy-row.selected .healthy-row-name').textContent())?.trim() ?? '';
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
    await showAllProjects(page);
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
    await showAllProjects(page);
    await expect(page.locator('.finding-card')).toHaveCount(2);

    await page.keyboard.press('Alt+n');
    const firstSelected = await selectedFindingName(page);
    await expect(page.locator('.terminal-xterm .xterm-screen')).toBeVisible();
    await expect(page.locator('.terminal-xterm')).toContainText('❯');
    await page.locator('.terminal-xterm').click();

    await page.keyboard.press('Enter');

    await expect.poll(() => selectedFindingName(page), { timeout: 5000 }).not.toBe(firstSelected);
  });

  test('pressing Enter with an empty terminal draft advances while the agent is streaming', async ({ page, request }) => {
    await launchViaUI(page, 'Terminal Streaming Alpha', '/test/terminal-streaming-alpha');
    const tmuxA = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxA);
    await injectToolUse(request, tmuxA);
    await setTerminalContent(request, tmuxA, '\r\n• Working (7m 32s • esc to interrupt)\r\n');

    await launchViaUI(page, 'Terminal Streaming Beta', '/test/terminal-streaming-beta');
    const tmuxB = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxB);
    await injectToolUse(request, tmuxB);
    await setTerminalContent(request, tmuxB, '\r\n• Working (4m 12s • esc to interrupt)\r\n');

    await showAllProjects(page);
    await expect(page.locator('.healthy-row')).toHaveCount(2);
    await page.locator('.healthy-row', { hasText: 'Terminal Streaming Alpha' }).click();
    const firstSelected = await selectedHealthyName(page);
    expect(firstSelected).toContain('Terminal Streaming Alpha');
    await showTerminalPane(page);
    await expect(page.locator('.terminal-xterm .xterm-screen')).toBeVisible();
    await expect(page.locator('.terminal-xterm')).toContainText('Working');
    await page.locator('.terminal-xterm').click();

    await page.keyboard.press('Enter');

    await expect.poll(() => selectedHealthyName(page), { timeout: 5000 }).not.toBe(firstSelected);
    await expect(page.locator('.healthy-row.selected .healthy-row-name')).toContainText('Terminal Streaming Beta');
  });

  test('bottom response input advances repeatedly on empty Enter without waiting', async ({ page, request }) => {
    for (const name of ['Bottom Input Alpha', 'Bottom Input Beta', 'Bottom Input Gamma']) {
      await launchViaUI(page, name, `/test/${name.toLowerCase().replaceAll(' ', '-')}`);
      const tmuxName = await getLatestTmuxName(request);
      await injectSessionStart(request, tmuxName);
      await injectToolUse(request, tmuxName);
    }

    await showAllProjects(page);
    await expect(page.locator('.healthy-row')).toHaveCount(3);
    await page.locator('.healthy-row', { hasText: 'Bottom Input Alpha' }).click();
    await expect(page.locator('.healthy-row.selected .healthy-row-name')).toContainText('Bottom Input Alpha');

    const input = page.locator('.response-row input');
    await input.click();
    await input.press('Enter');
    await expect(page.locator('.healthy-row.selected .healthy-row-name')).toContainText('Bottom Input Beta');

    await input.press('Enter');
    await expect(page.locator('.healthy-row.selected .healthy-row-name')).toContainText('Bottom Input Gamma');

    await input.press('Enter');
    await expect(page.locator('.healthy-row.selected .healthy-row-name')).toContainText('Bottom Input Alpha');
  });
});

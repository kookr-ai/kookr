import { test, expect } from './fixtures.js';
import {
  getTmuxNameForPrompt,
  launchViaUI,
  resetServer,
} from './battle-helpers.js';
import type { APIRequestContext, Page } from '@playwright/test';

test.use({ promptBracketedPaste: true });

async function getWrittenText(request: APIRequestContext, tmuxName: string): Promise<string> {
  const res = await request.get(`/api/test/written-text/${encodeURIComponent(tmuxName)}`);
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { writtenText: string }).writtenText;
}

async function getKeysReceived(request: APIRequestContext, tmuxName: string): Promise<string[]> {
  const res = await request.get(`/api/test/keys-received/${encodeURIComponent(tmuxName)}`);
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { keysReceived: string[] }).keysReceived;
}

async function waitForTerminal(page: Page): Promise<void> {
  await page.locator('.healthy-row').first().click();
  const restore = page.getByRole('button', { name: 'Show terminal/diff pane' });
  if (await restore.isVisible()) {
    await restore.click();
  }
  const terminalTab = page.locator('.detail-split-right').getByRole('button', { name: 'Terminal', exact: true });
  if (await terminalTab.isVisible()) {
    await terminalTab.click();
  }
  await expect(page.locator('.terminal-xterm .xterm-screen')).toBeVisible({ timeout: 10_000 });
  await page.locator('.terminal-xterm .xterm-screen').click();
}

test.describe('Prompt delivery and terminal paste', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('launched task receives and submits the initial prompt through the test server path', async ({ page, request }) => {
    const prompt = `Initial prompt delivery ${Date.now()}\nSecond line reaches the spawned session`;

    await launchViaUI(page, prompt, '/test/prompt-delivery');
    const tmuxName = await getTmuxNameForPrompt(request, prompt);

    await expect.poll(() => getWrittenText(request, tmuxName), { timeout: 5_000 })
      .toContain(`\x1b[200~${prompt}\x1b[201~\r`);
    await expect.poll(() => getKeysReceived(request, tmuxName), { timeout: 5_000 })
      .toContain('');
  });

  test('terminal multiline paste works through browser paste events and the context menu', async ({ page, request }) => {
    const prompt = `Paste behavior target ${Date.now()}`;

    await launchViaUI(page, prompt, '/test/prompt-paste');
    const tmuxName = await getTmuxNameForPrompt(request, prompt);
    await waitForTerminal(page);

    const keyboardPaste = 'ctrl-v line 1\nctrl-v line 2';
    await page.evaluate((text) => {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: { getData: (type: string) => (type === 'text' || type === 'text/plain' ? text : '') },
      });
      document.querySelector('.terminal-xterm')?.dispatchEvent(event);
    }, keyboardPaste);

    await expect.poll(() => getWrittenText(request, tmuxName), { timeout: 5_000 })
      .toContain(`\x1b[200~${keyboardPaste}\x1b[201~`);

    const menuPaste = 'menu paste line 1\nmenu paste line 2';
    await page.evaluate((text) => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          readText: () => Promise.resolve(text),
          writeText: () => Promise.resolve(),
        },
      });
    }, menuPaste);
    await page.locator('.terminal-xterm').click({ button: 'right' });
    await page.getByRole('button', { name: 'Paste', exact: true }).click();

    await expect.poll(() => getWrittenText(request, tmuxName), { timeout: 5_000 })
      .toContain(`\x1b[200~${menuPaste}\x1b[201~`);
  });
});

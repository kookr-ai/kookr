/**
 * Runtime guard for #3561 slice 1: no rendered text below 12 px, in the
 * all-clear state, with findings, and with a task open in the detail panel.
 *
 * The stylesheet test (src/frontend/design-tokens.test.ts) pins declared
 * sizes; this spec checks what the browser actually renders, which also
 * catches em inheritance and inline styles.
 */
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import {
  resetServer,
  launchViaUI,
  getTmuxNameForPrompt,
  injectSessionStart,
  injectToolUse,
  injectPermissionEvent,
  injectAskUserQuestion,
  injectAgentMessage,
} from './battle-helpers.js';

const MIN_FONT_PX = 12;

/** Visible text nodes whose computed font size is under the minimum. */
async function textBelowMinimum(page: Page): Promise<string[]> {
  return page.evaluate((min) => {
    const offenders: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      const el = node.parentElement;
      if (!text || !el) continue;
      // Scaled illustrations (SVG viewBox units) and the xterm canvas are not UI text.
      if (el.closest('svg, .xterm')) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      // Visually hidden (sr-only) text has a 1x1 clip box.
      if (rect.width <= 1 && rect.height <= 1) continue;
      const size = parseFloat(style.fontSize);
      if (size < min) offenders.push(`${size}px <${el.tagName.toLowerCase()} class="${el.className}"> ${text.slice(0, 40)}`);
    }
    return offenders;
  }, MIN_FONT_PX);
}

async function launchWithSession(page: Page, request: APIRequestContext, prompt: string, cwd: string) {
  await launchViaUI(page, prompt, cwd);
  const tmux = await getTmuxNameForPrompt(request, prompt);
  await injectSessionStart(request, tmux, cwd);
  return tmux;
}

test.describe('Type scale at runtime (#3561)', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.setViewportSize({ width: 1600, height: 950 });
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('no visible text renders below 12 px across the main dashboard states and dialogs', async ({ page, request }) => {
    await expect(page.locator('.findings-empty')).toBeVisible();
    expect(await textBelowMinimum(page), 'empty dashboard').toEqual([]);

    const running = await launchWithSession(page, request, 'Export invoices as CSV', '/test/billing');
    await injectToolUse(request, running, 'Bash');
    await expect(page.locator('.healthy-row')).toHaveCount(1);
    expect(await textBelowMinimum(page), 'all clear, one agent running').toEqual([]);

    const permission = await launchWithSession(page, request, 'Fix auth refresh token race', '/test/api');
    await injectPermissionEvent(request, permission, 'Bash', 'pnpm db:migrate');
    const question = await launchWithSession(page, request, 'Add cursor pagination', '/test/api');
    await injectAskUserQuestion(request, question);
    const stopped = await launchWithSession(page, request, 'Migrate CI to pnpm 10', '/test/ci');
    // Markdown #/##/### render as h4/h5/h6, whose browser defaults shrink text.
    await injectAgentMessage(request, stopped, '# Report\n\n## Summary\n\n### Next steps\n\nI need your help.');
    await expect(page.locator('.finding-card')).toHaveCount(3);
    expect(await textBelowMinimum(page), 'three findings').toEqual([]);

    await page.locator('.finding-card', { hasText: 'Migrate CI to pnpm 10' }).click();
    await expect(page.locator('.detail-header')).toBeVisible();
    await expect(page.locator('.act-msg-text h6.md-h')).toBeVisible();
    expect(await textBelowMinimum(page), 'task open in detail panel, markdown headings').toEqual([]);

    await page.getByRole('button', { name: 'Share this task' }).click();
    await expect(page.getByRole('dialog', { name: 'Share this task' })).toBeVisible();
    expect(await textBelowMinimum(page), 'share dialog').toEqual([]);
    await page.keyboard.press('Escape');

    await page.locator('.btn-launch').click();
    await expect(page.getByRole('dialog', { name: 'Launch New Task' })).toBeVisible();
    expect(await textBelowMinimum(page), 'launch dialog').toEqual([]);
    await page.keyboard.press('Escape');

    await page.setViewportSize({ width: 1180, height: 950 });
    expect(await textBelowMinimum(page), 'narrow window').toEqual([]);
  });
});

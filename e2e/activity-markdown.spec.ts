/**
 * E2E for the activity-panel markdown renderer — agent messages render with
 * bold / italic / inline code / code fences, and raw HTML is escaped.
 * See docs/rfc/rfc-activity-panel-ux.md §2.
 */
import { test, expect } from './fixtures.js';
import {
  resetServer,
  launchViaUI,
  getLatestTmuxName,
  injectSessionStart,
  injectAgentMessage,
} from './battle-helpers.js';

test.describe('Activity panel → markdown rendering', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('renders bold + inline code in an agent message', async ({ page, request }) => {
    await launchViaUI(page, 'Markdown test', '/test/project');
    const tmux = await getLatestTmuxName(request);
    await injectSessionStart(request, tmux);
    await injectAgentMessage(request, tmux, 'All **done** — run `pnpm test` to verify.');

    await page.locator('.finding-card').click();
    const msg = page.locator('.act-msg-agent .act-msg-text');
    await expect(msg).toBeVisible();
    // bold
    await expect(msg.locator('strong')).toContainText('done');
    // inline code
    await expect(msg.locator('code').first()).toContainText('pnpm test');
    // No literal asterisks or backticks in rendered text
    await expect(msg).not.toContainText('**');
    await expect(msg).not.toContainText('`pnpm test`');
  });

  test('renders fenced code blocks and bullet lists', async ({ page, request }) => {
    await launchViaUI(page, 'Fence test', '/test/project');
    const tmux = await getLatestTmuxName(request);
    await injectSessionStart(request, tmux);
    await injectAgentMessage(
      request,
      tmux,
      'Summary:\n\n- first item\n- second item\n\n```\nconst x = 1;\n```',
    );

    await page.locator('.finding-card').click();
    const msg = page.locator('.act-msg-agent .act-msg-text');
    await expect(msg.locator('ul li').first()).toContainText('first item');
    await expect(msg.locator('ul li').nth(1)).toContainText('second item');
    await expect(msg.locator('pre code')).toContainText('const x = 1;');
  });

  test('HTML in agent message renders as literal text (XSS defense)', async ({ page, request }) => {
    await launchViaUI(page, 'XSS test', '/test/project');
    const tmux = await getLatestTmuxName(request);
    await injectSessionStart(request, tmux);
    await injectAgentMessage(request, tmux, 'try <script>alert(1)</script> now');

    await page.locator('.finding-card').click();
    const msg = page.locator('.act-msg-agent .act-msg-text');
    await expect(msg).toContainText('<script>alert(1)</script>');
    // Assert no actual <script> element is created inside the message
    const scripts = await msg.locator('script').count();
    expect(scripts).toBe(0);
  });
});

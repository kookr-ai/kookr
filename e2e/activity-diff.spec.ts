/**
 * E2E for the activity-panel diff pane — clicking an edited file in an
 * expanded tool group opens a diff view in place of the terminal.
 * See docs/rfc/rfc-activity-panel-ux.md §3.
 */
import { test, expect } from './fixtures.js';
import {
  resetServer,
  launchViaUI,
  getLatestTmuxName,
  injectSessionStart,
  injectEditEvent,
  injectStopEvent,
  injectEvent,
} from './battle-helpers.js';

test.describe('Activity panel → diff pane', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('click edited file opens diff pane, Terminal toggle restores terminal', async ({ page, request }) => {
    await launchViaUI(page, 'Diff test', '/test/project');
    const tmux = await getLatestTmuxName(request);
    await injectSessionStart(request, tmux);
    await injectEditEvent(request, tmux, '/test/project/src/foo.ts', 'tu_alpha', 'before', 'after');
    await injectStopEvent(request, tmux);
    await page.locator('.finding-card').click();

    // Activity panel should show a tool group summary "edited 1 file"
    const summary = page.locator('.act-tool-summary-line').filter({ hasText: /edited 1 file/i });
    await expect(summary).toBeVisible();

    // Expand the group
    await summary.click();

    // Clickable edit entry — button element with is-clickable
    const editEntry = page.locator('button.act-tool-entry.is-clickable', { hasText: 'foo.ts' });
    await expect(editEntry).toBeVisible();

    // Terminal pane is visible, Diff tab not present yet
    await expect(page.locator('.right-pane-slot-terminal')).toBeVisible();
    await expect(page.locator('.right-pane-slot-diff')).toHaveCount(0);

    // Click the edit entry — diff pane opens
    await editEntry.click();

    // Diff pane header shows the file path
    await expect(page.locator('.diff-pane-path')).toContainText('foo.ts');
    // Wait for fetch to resolve — diff hunks should render
    await expect(page.locator('.diff-line.diff-add')).toContainText('+after');
    await expect(page.locator('.diff-line.diff-del')).toContainText('-before');

    // Terminal slot exists but is hidden
    const terminalSlot = page.locator('.right-pane-slot-terminal');
    await expect(terminalSlot).toHaveCSS('display', 'none');
    const diffSlot = page.locator('.right-pane-slot-diff');
    await expect(diffSlot).toBeVisible();

    // Terminal mode toggle button — click to restore
    await page.locator('button.pane-tab', { hasText: 'Terminal' }).click();
    await expect(terminalSlot).toBeVisible();
    await expect(diffSlot).toHaveCSS('display', 'none');
  });

  test('Escape in diff pane returns to terminal', async ({ page, request }) => {
    await launchViaUI(page, 'Escape test', '/test/project');
    const tmux = await getLatestTmuxName(request);
    await injectSessionStart(request, tmux);
    await injectEditEvent(request, tmux, '/test/project/src/bar.ts', 'tu_beta', 'x', 'y');
    await injectStopEvent(request, tmux);
    await page.locator('.finding-card').click();

    await page.locator('.act-tool-summary-line').first().click();
    await page.locator('button.act-tool-entry.is-clickable').first().click();
    await expect(page.locator('.diff-pane')).toBeVisible();
    await expect(page.locator('.diff-line.diff-add')).toBeVisible();

    // Press Escape inside the diff pane
    await page.locator('.diff-pane').click(); // ensure focus is inside the pane
    await page.keyboard.press('Escape');

    // Terminal slot becomes active again; diff slot hides via inline display.
    await expect(page.locator('.right-pane-slot-diff')).toHaveCSS('display', 'none');
    await expect(page.locator('.right-pane-slot-terminal')).toHaveCSS('display', 'flex');
  });

  test('same file edited in two groups — click each resolves to that group\'s diff', async ({ page, request }) => {
    // Regression for Codex P1 on PR #335: a click on the earlier group's
    // entry used to resolve to the later group's tool_use.
    await launchViaUI(page, 'Cross-group test', '/test/project');
    const tmux = await getLatestTmuxName(request);
    await injectSessionStart(request, tmux);

    // Group 1 — foo.ts edited with tu_first
    await injectEditEvent(request, tmux, '/test/project/foo.ts', 'tu_first', 'X', 'Y');
    // Flush into a separate group via a user prompt
    await injectEvent(request, tmux, {
      session_id: `sess-${Date.now()}`,
      transcript_path: '/tmp/t.jsonl',
      cwd: '/test/project',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'again',
    });
    // Group 2 — foo.ts edited with tu_second
    await injectEditEvent(request, tmux, '/test/project/foo.ts', 'tu_second', 'A', 'B');
    await injectStopEvent(request, tmux);
    await page.locator('.finding-card').click();

    // Expand BOTH tool groups
    const summaries = page.locator('.act-tool-summary-line');
    await expect(summaries).toHaveCount(2);
    await summaries.nth(0).click();
    await summaries.nth(1).click();

    // Click the FIRST group's foo.ts entry → expect diff with +Y / -X (tu_first)
    const firstEntry = page.locator('button.act-tool-entry.is-clickable').first();
    await firstEntry.click();
    await expect(page.locator('.diff-line.diff-add')).toContainText('+Y');
    await expect(page.locator('.diff-line.diff-del')).toContainText('-X');

    // Click the SECOND group's foo.ts entry → expect diff with +B / -A (tu_second)
    const secondEntry = page.locator('button.act-tool-entry.is-clickable').nth(1);
    await secondEntry.click();
    await expect(page.locator('.diff-line.diff-add')).toContainText('+B');
    await expect(page.locator('.diff-line.diff-del')).toContainText('-A');
  });

  test('clicking a second edit swaps the diff without open/close', async ({ page, request }) => {
    await launchViaUI(page, 'Swap test', '/test/project');
    const tmux = await getLatestTmuxName(request);
    await injectSessionStart(request, tmux);
    await injectEditEvent(request, tmux, '/test/project/a.ts', 'tu_one', '1', '2');
    await injectEditEvent(request, tmux, '/test/project/b.ts', 'tu_two', '3', '4');
    await injectStopEvent(request, tmux);
    await page.locator('.finding-card').click();

    await page.locator('.act-tool-summary-line').first().click();
    const entries = page.locator('button.act-tool-entry.is-clickable');
    await expect(entries).toHaveCount(2);

    // Click first edit
    await entries.filter({ hasText: 'a.ts' }).click();
    await expect(page.locator('.diff-pane-path')).toContainText('a.ts');
    await expect(page.locator('.diff-line.diff-add')).toContainText('+2');

    // Click second edit — same pane updates, no close
    await entries.filter({ hasText: 'b.ts' }).click();
    await expect(page.locator('.diff-pane-path')).toContainText('b.ts');
    await expect(page.locator('.diff-line.diff-add')).toContainText('+4');
  });
});

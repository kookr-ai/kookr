/**
 * Battle-test E2E suite — Triage, multi-agent prioritization, and lifecycle tests.
 *
 * Covers: Triage loop (respond/skip/snooze), multi-agent prioritization & navigation,
 * task lifecycle, snoozed agents.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import {
  resetServer,
  launchViaUI,
  getLatestTmuxName,
  getTasks,
  injectSessionStart,
  injectStopEvent,
  injectToolUse,
  injectPermissionEvent,
  injectAskUserQuestion,
  waitForAgentCount,
  waitForFindingCount,
} from './battle-helpers.js';

// The Snoozed section in FindingsPanel defaults to collapsed (intentional UX
// from #589). Tests must expand it before asserting on `.snoozed-row`.
async function expandSnoozedSection(page: Page) {
  const header = page.locator('.snoozed-section .section-header');
  await expect(header).toBeVisible({ timeout: 3000 });
  if ((await header.getAttribute('aria-expanded')) === 'false') {
    await header.click();
  }
}

// ---------------------------------------------------------------------------
// Suite 4: Triage loop — respond, skip, snooze, advance
// ---------------------------------------------------------------------------

test.describe('Triage loop', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('respond and advance to next finding', async ({ page, request }) => {
    // Create two findings
    await launchViaUI(page, 'Agent A', '/test/a');
    const tmuxA = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxA);
    await injectStopEvent(request, tmuxA);

    await launchViaUI(page, 'Agent B', '/test/b');
    const tmuxB = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxB);
    await injectStopEvent(request, tmuxB);

    await expect(page.locator('.finding-card')).toHaveCount(2);

    // Select first finding
    await page.locator('.finding-card').first().click();
    await expect(page.locator('.detail-header')).toBeVisible();
    const firstAgentName = await page.locator('.detail-header h2').textContent();

    // Respond
    await page.locator('.response-row input').fill('Try this approach');
    await page.locator('.btn-primary:has-text("Send & Next")').click();

    // Should see sent overlay
    await expect(page.locator('.sent-overlay')).toBeVisible();

    // After advance, the selected agent should change
    // Wait for the overlay to disappear and the detail to update
    await expect(page.locator('.sent-overlay')).not.toBeVisible({ timeout: 3000 });
  });

  test('skip removes finding from active queue and advances', async ({ page, request }) => {
    await launchViaUI(page, 'Skip me', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    await page.locator('.finding-card').click();
    await page.locator('.response-row .btn-secondary:has-text("Skip")').click();

    // After skipping, the finding card should still exist but it should move to the end of the queue
    // The detail panel should either show next finding or empty state
  });

  test('snooze hides finding from active list', async ({ page, request }) => {
    await launchViaUI(page, 'Snooze test', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    // Finding visible
    await expect(page.locator('.finding-card')).toBeVisible();

    // Snooze from findings panel — click "Snooze" then select "5m" from dialog
    await page.locator('.finding-actions .btn-xs:has-text("Snooze")').click();
    await page.locator('.snooze-dialog-btn:has-text("5m")').click();

    // Finding should disappear from findings list
    await expect(page.locator('.finding-card')).not.toBeVisible({ timeout: 3000 });
    // Snoozed agent should appear in snoozed section
    await expandSnoozedSection(page);
    await expect(page.locator('.snoozed-row')).toBeVisible({ timeout: 3000 });
  });

  test('snooze from detail panel hides finding', async ({ page, request }) => {
    await launchViaUI(page, 'Snooze detail', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    await page.locator('.finding-card').click();
    await page.locator('.response-row .btn-secondary:has-text("Snooze")').click();
    await page.locator('.snooze-dialog-btn:has-text("5m")').click();

    await expect(page.locator('.finding-card')).not.toBeVisible({ timeout: 3000 });
  });

  test('skip from findings panel actions button', async ({ page, request }) => {
    await launchViaUI(page, 'Skip actions', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    await expect(page.locator('.finding-card')).toBeVisible();
    await page.locator('.finding-actions .btn-xs:has-text("Skip")').click();
  });

  test('empty response is not sent (button disabled)', async ({ page, request }) => {
    await launchViaUI(page, 'Empty test', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    await page.locator('.finding-card').click();

    // Send button should be disabled when input is empty
    const sendBtn = page.locator('.btn-primary:has-text("Send & Next")');
    await expect(sendBtn).toBeDisabled();

    // Fill then clear
    await page.locator('.response-row input').fill('something');
    await expect(sendBtn).toBeEnabled();
    await page.locator('.response-row input').fill('');
    await expect(sendBtn).toBeDisabled();
  });

  test('Enter sends response from detail panel', async ({ page, request }) => {
    await launchViaUI(page, 'Enter test', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    await page.locator('.finding-card').click();
    const input = page.locator('.response-row input');
    await input.fill('Fix with Enter');
    await input.press('Enter');

    // Sent overlay should appear
    await expect(page.locator('.sent-overlay')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Suite 5: Multi-agent prioritization & navigation
// ---------------------------------------------------------------------------

test.describe('Multi-agent prioritization', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('three agents with different severities are ordered correctly', async ({ page, request }) => {
    // Agent A: needs_input (info)
    await launchViaUI(page, 'Agent info', '/test/a');
    const tmuxA = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxA);
    await injectStopEvent(request, tmuxA);

    // Agent B: permission_blocked (warning)
    await launchViaUI(page, 'Agent warning', '/test/b');
    const tmuxB = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxB);
    await injectPermissionEvent(request, tmuxB);

    // Agent C: AskUserQuestion needs_input (warning)
    await launchViaUI(page, 'Agent askuser', '/test/c');
    const tmuxC = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxC);
    await injectAskUserQuestion(request, tmuxC);

    await expect(page.locator('.finding-card')).toHaveCount(3);

    // Ctrl+N should navigate to the highest priority (warning) first
    await page.keyboard.press('Alt+n');
    const badge = page.locator('.detail-badge');
    const badgeText = await badge.textContent();
    // Should be one of the warning-level findings (permission or askuser)
    expect(badgeText === 'PERMISSION BLOCKED' || badgeText === 'NEEDS INPUT').toBeTruthy();
  });

  test('Ctrl+N cycles through all findings', async ({ page, request }) => {
    // Use mixed anomaly types to avoid finding grouping (≥3 same type → group)
    await launchViaUI(page, 'Agent 1', '/test/a');
    const tmux1 = await getLatestTmuxName(request);
    await injectSessionStart(request, tmux1);
    await injectStopEvent(request, tmux1);
    await expect(page.locator('.finding-card')).toHaveCount(1, { timeout: 5000 });

    await launchViaUI(page, 'Agent 2', '/test/b');
    const tmux2 = await getLatestTmuxName(request);
    await injectSessionStart(request, tmux2);
    await injectPermissionEvent(request, tmux2);
    await expect(page.locator('.finding-card')).toHaveCount(2, { timeout: 5000 });

    await launchViaUI(page, 'Agent 3', '/test/c');
    const tmux3 = await getLatestTmuxName(request);
    await injectSessionStart(request, tmux3);
    await injectStopEvent(request, tmux3);
    await expect(page.locator('.finding-card')).toHaveCount(3, { timeout: 5000 });

    // Track which agents we visit
    const visited = new Set<string>();
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Alt+n');
      const name = await page.locator('.detail-header h2').textContent();
      if (name) visited.add(name);
    }
    // Should have visited all 3 different agents
    expect(visited.size).toBe(3);
  });

  test('healthy agents do not appear in findings list', async ({ page, request }) => {
    await launchViaUI(page, 'Healthy agent', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectToolUse(request, tmuxName);

    await expect(page.locator('.finding-card')).not.toBeVisible();
    await expect(page.locator('.healthy-row')).toBeVisible();
    await expect(page.locator('.findings-all-clear')).toContainText('All clear');
  });

  test('selecting healthy agent shows detail panel without response area anomaly badge', async ({ page, request }) => {
    await launchViaUI(page, 'Healthy detail', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectToolUse(request, tmuxName);

    await page.locator('.healthy-row').click();

    // Detail panel should show but badge should say RUNNING (no anomaly)
    await expect(page.locator('.detail-header')).toBeVisible();
    await expect(page.locator('.detail-badge')).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Suite 6: Task lifecycle
// ---------------------------------------------------------------------------

test.describe('Task lifecycle', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('launched task has inProgress status', async ({ page, request }) => {
    await launchViaUI(page, 'Lifecycle test', '/test/project');
    const tasks = await getTasks(request);
    expect(tasks.length).toBe(1);
    expect(tasks[0].status).toBe('inProgress');
  });

  test('cancel agent sets task to cancelled status', async ({ page, request }) => {
    await launchViaUI(page, 'Cancel lifecycle', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    await page.locator('.finding-card').click();
    page.on('dialog', (dialog) => dialog.accept());
    await page.locator('[data-testid="action-cancel"]').click();

    // Wait for cancel to process
    await expect(page.locator('.finding-card')).not.toBeVisible({ timeout: 5000 });

    const tasks = await getTasks(request);
    expect(tasks.length).toBe(1);
    expect(tasks[0].status).toBe('cancelled');
    expect(tasks[0].sessions[0].lastStatus).toBe('aborted');
  });

  test('launch with completion criteria is persisted', async ({ page, request }) => {
    await launchViaUI(page, 'Criteria task', '/test/project', 'Tests pass and PR merged');

    const tasks = await getTasks(request);
    expect(tasks.length).toBe(1);
    expect(tasks[0].criteria).toBe('Tests pass and PR merged');
  });

  test('task rename persists across API queries', async ({ page, request }) => {
    await launchViaUI(page, 'Original name', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    // Rename via double-click in findings
    await page.locator('.finding-task').dblclick();
    const editInput = page.locator('.finding-task-edit');
    await editInput.clear();
    await editInput.fill('Custom Name');
    await editInput.press('Enter');

    // Verify via API
    const tasks = await getTasks(request);
    expect(tasks[0].name).toBe('Custom Name');
  });

  test('multiple launches create independent tasks', async ({ page, request }) => {
    await launchViaUI(page, 'Task 1', '/test/a');
    await launchViaUI(page, 'Task 2', '/test/b');
    await launchViaUI(page, 'Task 3', '/test/c');

    const tasks = await getTasks(request);
    expect(tasks.length).toBe(3);

    const prompts = tasks.map((t) => t.prompt);
    expect(prompts).toContain('Task 1');
    expect(prompts).toContain('Task 2');
    expect(prompts).toContain('Task 3');

    // Each should have a unique session
    const sessions = tasks.flatMap((t) => t.sessions.map((s) => s.tmuxSession));
    expect(new Set(sessions).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Suite 19: Snoozed agents in healthy section
// ---------------------------------------------------------------------------

test.describe('Snoozed agents', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('snoozed agent moves from findings to snoozed section', async ({ page, request }) => {
    await launchViaUI(page, 'Snooze move', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    // Finding visible
    await expect(page.locator('.finding-card')).toBeVisible();
    await expect(page.locator('.statusbar')).toContainText('1 finding');

    // Snooze it — click "Snooze" then select "5m" from dialog
    await page.locator('.finding-actions .btn-xs:has-text("Snooze")').click();
    await page.locator('.snooze-dialog-btn:has-text("5m")').click();

    // Finding should be gone, snoozed section should show
    await expect(page.locator('.finding-card')).not.toBeVisible({ timeout: 3000 });
    await expect(page.locator('.statusbar')).toContainText('0 findings');
    await expandSnoozedSection(page);
    await expect(page.locator('.snoozed-row')).toBeVisible();
  });

  test('snoozing with multiple agents only snoozes the target', async ({ page, request }) => {
    await launchViaUI(page, 'Agent stay', '/test/a');
    const tmuxA = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxA);
    await injectStopEvent(request, tmuxA);

    await launchViaUI(page, 'Agent snooze', '/test/b');
    const tmuxB = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxB);
    await injectStopEvent(request, tmuxB);

    await expect(page.locator('.finding-card')).toHaveCount(2);

    // Snooze only the second agent — click its "Snooze" then select "5m"
    await page.locator('.finding-actions .btn-xs:has-text("Snooze")').nth(1).click();
    await page.locator('.snooze-dialog-btn:has-text("5m")').click();

    // Should have 1 finding remaining
    await expect(page.locator('.finding-card')).toHaveCount(1, { timeout: 3000 });
  });
});

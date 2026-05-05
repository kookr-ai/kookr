/**
 * Battle-test E2E suite — WebSocket, anomaly detection, and agent detail tests.
 *
 * Covers: WebSocket real-time updates, anomaly detection & severity,
 * completion criteria, agent detail metadata.
 */
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

// ---------------------------------------------------------------------------
// Suite 2: WebSocket protocol & real-time updates
// ---------------------------------------------------------------------------

test.describe('WebSocket real-time updates', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('snapshot delivered on page load', async ({ page }) => {
    // The status bar should show 0 tasks — snapshot was received
    await expect(page.locator('.statusbar')).toContainText('0 tasks');
    await expect(page.locator('.statusbar')).toContainText('0 findings');
  });

  test('real-time update when agent goes from healthy to needs_input', async ({ page, request }) => {
    await launchViaUI(page, 'Watch me', '/test/project');
    const tmuxName = await getLatestTmuxName(request);

    await injectSessionStart(request, tmuxName);
    await injectToolUse(request, tmuxName);

    // Agent is healthy
    await expect(page.locator('.healthy-row')).toBeVisible();
    await expect(page.locator('.finding-card')).not.toBeVisible();

    // Now agent stops — becomes a finding
    await injectStopEvent(request, tmuxName);

    await expect(page.locator('.finding-card')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('.finding-severity')).toContainText('Needs Input');
  });

  test('real-time update when anomaly clears after input', async ({ page, request }) => {
    await launchViaUI(page, 'Respond test', '/test/project');
    const tmuxName = await getLatestTmuxName(request);

    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    // Finding visible
    await expect(page.locator('.finding-card')).toBeVisible();

    // Select and respond
    await page.locator('.finding-card').click();
    await page.locator('.response-row input').fill('Do X');
    await page.locator('.btn-primary:has-text("Send & Next")').click();

    // After responding, the anomaly should be cleared
    // Inject a tool use to confirm the agent is working again
    await injectToolUse(request, tmuxName);

    await expect(page.locator('.finding-card')).not.toBeVisible({ timeout: 3000 });
  });

  test('multiple agents tracked independently', async ({ page, request }) => {
    await launchViaUI(page, 'Agent 1', '/test/a');
    const tmux1 = await getLatestTmuxName(request);
    await injectSessionStart(request, tmux1);

    await launchViaUI(page, 'Agent 2', '/test/b');
    const tmux2 = await getLatestTmuxName(request);
    await injectSessionStart(request, tmux2);

    await launchViaUI(page, 'Agent 3', '/test/c');
    const tmux3 = await getLatestTmuxName(request);
    await injectSessionStart(request, tmux3);

    await waitForAgentCount(page, 3);

    // Make agent 1 stuck, 2 healthy, 3 permission blocked
    await injectStopEvent(request, tmux1);
    await injectToolUse(request, tmux2);
    await injectPermissionEvent(request, tmux3);

    await waitForFindingCount(page, 2);
    await expect(page.locator('.finding-card')).toHaveCount(2);
    await expect(page.locator('.healthy-row')).toHaveCount(1);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Anomaly detection & severity
// ---------------------------------------------------------------------------

test.describe('Anomaly detection', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('needs_input from Stop event shows info severity', async ({ page, request }) => {
    await launchViaUI(page, 'Stop test', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName, 'What should I do next?');

    await expect(page.locator('.finding-card')).toBeVisible();
    await page.locator('.finding-card').click();
    await expect(page.locator('.detail-badge')).toContainText('NEEDS INPUT');
    await expect(page.locator('.finding-explanation')).toContainText('What should I do next?');
  });

  test('permission_blocked from PermissionRequest shows warning severity', async ({ page, request }) => {
    await launchViaUI(page, 'Permission test', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectPermissionEvent(request, tmuxName, 'Write');

    await expect(page.locator('.finding-card')).toBeVisible();
    await page.locator('.finding-card').click();
    await expect(page.locator('.detail-badge')).toContainText('PERMISSION');
    await expect(page.locator('.finding-explanation')).toContainText('Write');
  });

  test('AskUserQuestion tool triggers needs_input with warning severity', async ({ page, request }) => {
    await launchViaUI(page, 'AskUser test', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectAskUserQuestion(request, tmuxName);

    await expect(page.locator('.finding-card')).toBeVisible();
    await expect(page.locator('.finding-severity')).toContainText('Needs Input');
    await expect(page.locator('.finding-explanation')).toContainText('AskUserQuestion');
  });

  test('anomaly clears when agent resumes working', async ({ page, request }) => {
    await launchViaUI(page, 'Clear test', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);

    // Create anomaly
    await injectStopEvent(request, tmuxName);
    await expect(page.locator('.finding-card')).toBeVisible();

    // Agent resumes working — anomaly clears
    await injectToolUse(request, tmuxName, 'Bash');
    await expect(page.locator('.finding-card')).not.toBeVisible({ timeout: 3000 });
    await expect(page.locator('.findings-all-clear')).toContainText('All clear');
  });

  test('permission_blocked overrides previous needs_input', async ({ page, request }) => {
    await launchViaUI(page, 'Override test', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);

    // First: needs_input
    await injectStopEvent(request, tmuxName);
    await expect(page.locator('.finding-card')).toHaveCount(1);
    await expect(page.locator('.finding-card .finding-severity')).toContainText('Needs Input');

    // Then: permission_blocked (higher severity replaces)
    await injectPermissionEvent(request, tmuxName);
    await expect(page.locator('.finding-card .finding-severity')).toContainText('Permission');
  });

  test('anomaly explanation includes relevant context', async ({ page, request }) => {
    await launchViaUI(page, 'Explanation test', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName, 'I found 3 failing tests. How should I proceed?');

    await expect(page.locator('.finding-explanation')).toContainText('I found 3 failing tests');
  });
});

// ---------------------------------------------------------------------------
// Suite 18: Completion criteria
// ---------------------------------------------------------------------------

test.describe('Completion criteria', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('launch without criteria sets criteria as undefined', async ({ page, request }) => {
    await launchViaUI(page, 'No criteria', '/test/project');
    const tasks = await getTasks(request);
    expect(tasks[0].criteria).toBeUndefined();
  });

  test('launch with criteria persists it', async ({ page, request }) => {
    await expect(page.locator('.health-dot-connected')).toBeVisible({ timeout: 5000 });
    await page.locator('.btn-launch').click();
    await page.locator('.dialog textarea').fill('Build feature');
    const cwdInput = page.locator('.dialog input[type="text"]').first();
    await cwdInput.clear();
    await cwdInput.fill('/test/project');
    // Fill criteria field
    const criteriaInput = page.locator('.dialog input[type="text"]').nth(1);
    await criteriaInput.fill('All tests pass');
    await page.locator('.dialog .btn-primary').click();
    await expect(page.locator('.dialog')).not.toBeVisible();

    const tasks = await getTasks(request);
    expect(tasks[0].criteria).toBe('All tests pass');
  });
});

// ---------------------------------------------------------------------------
// Suite 20: Agent detail metadata
// ---------------------------------------------------------------------------

test.describe('Agent detail metadata', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('detail panel shows agent type', async ({ page, request }) => {
    await launchViaUI(page, 'Metadata test', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    await page.locator('.finding-card').click();

    // Agent type should be displayed
    await expect(page.locator('.detail-header-right')).toContainText('claude-code');
  });

  test('detail panel shows working directory', async ({ page, request }) => {
    await launchViaUI(page, 'CWD display', '/custom/work/dir');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName, '/custom/work/dir');
    await injectStopEvent(request, tmuxName, undefined, '/custom/work/dir');

    await page.locator('.finding-card').click();
    // CWD is shown as a project badge with short label; full path is in the title attribute
    await expect(page.locator('.detail-header-right .project-badge')).toHaveAttribute('title', '/custom/work/dir');
  });

  test('detail panel shows task completion and cancellation actions', async ({ page, request }) => {
    await launchViaUI(page, 'Actions test', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    await page.locator('.finding-card').click();
    await expect(page.locator('[data-testid="action-attach"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="action-complete"]')).toBeVisible();
    await expect(page.locator('[data-testid="action-cancel"]')).toBeVisible();
  });

  // The `.response-hint` element this test asserts on no longer exists in the
  // current DetailPanel UI — the response-hint feature was removed at some
  // point and the test was not updated. Leaving as fixme rather than deleting
  // so the intent ("clicking a finding card should reveal Enter / Alt+J
  // shortcut affordances") is preserved for whoever resurfaces the hint UI.
  test.fixme('detail panel shows response hints', async ({ page, request }) => {
    await launchViaUI(page, 'Hints test', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    await page.locator('.finding-card').click();
    // Wait for delayed selection (click-dblclick disambiguation)
    await expect(page.locator('.detail-header')).toBeVisible();
    await expect(page.locator('.response-hint')).toContainText('Enter');
    await expect(page.locator('.response-hint')).toContainText('Alt+J');
  });
});

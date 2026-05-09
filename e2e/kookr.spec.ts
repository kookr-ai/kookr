import { test, expect } from './fixtures.js';
import type { Page, APIRequestContext } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


async function resetServer(request: APIRequestContext) {
  await request.post('/api/test/reset');
}

/** Get the tmux session name of the most recently launched in-progress task.
 *  Polls because the WebSocket launch completes asynchronously after the dialog closes. */
async function getLatestTmuxName(request: APIRequestContext): Promise<string> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const res = await request.get('/api/tasks');
    const tasks = (await res.json()) as Array<{
      status: string;
      sessions: Array<{ tmuxSession: string }>;
    }>;
    const inProgress = tasks.filter((t) => t.status === 'inProgress');
    const last = inProgress[inProgress.length - 1];
    if (last?.sessions?.length > 0) {
      return last.sessions[last.sessions.length - 1].tmuxSession;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Timed out waiting for an inProgress task with sessions');
}

/** Inject a raw hook event for a tmux session. */
async function injectEvent(
  request: APIRequestContext,
  tmuxName: string,
  event: Record<string, unknown>,
) {
  await request.post('/api/test/inject-event', {
    data: { tmuxName, event },
  });
}

/** Inject a SessionStart hook so the agent becomes trackable. */
async function injectSessionStart(request: APIRequestContext, tmuxName: string) {
  await injectEvent(request, tmuxName, {
    session_id: `sess-${Date.now()}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/test/project',
    hook_event_name: 'SessionStart',
  });
}

/** Inject a Stop hook — triggers 'needs_input' anomaly. */
async function injectStopEvent(request: APIRequestContext, tmuxName: string) {
  await injectEvent(request, tmuxName, {
    session_id: `sess-${Date.now()}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/test/project',
    hook_event_name: 'Stop',
    stop_hook_active: true,
    last_assistant_message: 'I need your help.',
  });
}

/** Inject a PermissionRequest hook — triggers 'permission_blocked' anomaly. */
async function injectPermissionEvent(request: APIRequestContext, tmuxName: string) {
  await injectEvent(request, tmuxName, {
    session_id: `sess-${Date.now()}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/test/project',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'npm install' },
    permission_mode: 'default',
  });
}

/** Inject a PreToolUse hook (agent is working, no anomaly). */
async function injectToolUse(request: APIRequestContext, tmuxName: string, toolName = 'Read') {
  await injectEvent(request, tmuxName, {
    session_id: `sess-${Date.now()}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/test/project',
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
  });
}

/** Launch an agent via the UI dialog. */
async function launchViaUI(page: Page, prompt: string, cwd: string) {
  // Ensure WebSocket is connected before launching (CI can be slow to connect)
  await expect(page.locator('.health-dot-connected')).toBeVisible({ timeout: 5000 });
  await page.locator('.btn-launch').click();
  await page.locator('.dialog textarea').fill(prompt);
  const cwdInput = page.locator('.dialog input[type="text"]').first();
  await cwdInput.clear();
  await cwdInput.fill(cwd);
  await page.locator('.dialog .btn-primary').click();
  // Wait for dialog to close
  await expect(page.locator('.dialog')).not.toBeVisible();
}

/** Wait for the WebSocket snapshot to deliver agent state. */
async function waitForAgentCount(page: Page, count: number) {
  // The status bar shows "N tasks"
  await expect(page.locator('.statusbar')).toContainText(`${count} task`, { timeout: 5000 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Kookr E2E — nominal paths', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    // Wait for WebSocket to connect and initial render
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  // --- Dashboard ---

  test('dashboard loads with empty state', async ({ page }) => {
    await expect(page.locator('.logo')).toHaveText('KOOKR');
    await expect(page.locator('.findings-empty')).toContainText('No agents running');
    await expect(page.locator('.statusbar')).toContainText('0 tasks');
    await expect(page.locator('.statusbar')).toContainText('0 findings');
    await expect(page.locator('.btn-launch')).toBeVisible();
    await expect(page.locator('.detail-empty')).toContainText('No agents running');
  });

  // --- Launch ---

  test('launch agent via dialog', async ({ page, request }) => {
    await launchViaUI(page, 'Fix the login bug', '/home/user/project');
    await waitForAgentCount(page, 1);

    // Agent should appear (healthy, no anomaly yet)
    await expect(page.locator('.healthy-section')).toBeVisible();
    await expect(page.locator('.statusbar')).toContainText('0 findings');
  });

  test('launch dialog validates required fields', async ({ page }) => {
    await page.locator('.btn-launch').click();
    // Launch button should be disabled with empty fields
    await expect(page.locator('.dialog .btn-primary')).toBeDisabled();

    // Fill only prompt — still disabled because cwd might be empty
    await page.locator('.dialog textarea').fill('Fix something');
    const cwdInput = page.locator('.dialog input[type="text"]').first();
    await cwdInput.clear();
    await expect(page.locator('.dialog .btn-primary')).toBeDisabled();

    // Cancel closes dialog
    await page.locator('.dialog .btn-secondary').click();
    await expect(page.locator('.dialog')).not.toBeVisible();
  });

  // --- Anomaly detection ---

  test('needs_input anomaly appears as finding', async ({ page, request }) => {
    await launchViaUI(page, 'Fix auth module', '/test/project');
    const tmuxName = await getLatestTmuxName(request);

    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    await expect(page.locator('.finding-card')).toBeVisible();
    await expect(page.locator('.finding-severity')).toContainText('Needs Input');
    await expect(page.locator('.statusbar')).toContainText('1 finding');
  });

  test('permission_blocked anomaly appears as finding', async ({ page, request }) => {
    await launchViaUI(page, 'Deploy the app', '/test/project');
    const tmuxName = await getLatestTmuxName(request);

    await injectSessionStart(request, tmuxName);
    await injectPermissionEvent(request, tmuxName);

    await expect(page.locator('.finding-card')).toBeVisible();
    await expect(page.locator('.finding-severity')).toContainText('Permission');
  });

  test('healthy agent appears in healthy section', async ({ page, request }) => {
    await launchViaUI(page, 'Build feature X', '/test/project');
    const tmuxName = await getLatestTmuxName(request);

    await injectSessionStart(request, tmuxName);
    await injectToolUse(request, tmuxName, 'Read');

    await expect(page.locator('.healthy-section')).toBeVisible();
    await expect(page.locator('.healthy-row')).toBeVisible();
    await expect(page.locator('.finding-card')).not.toBeVisible();
    await expect(page.locator('.findings-all-clear')).toContainText('All clear');
  });

  // --- Triage flow ---

  test('click finding to select and view detail panel', async ({ page, request }) => {
    await launchViaUI(page, 'Review code changes', '/test/project');
    const tmuxName = await getLatestTmuxName(request);

    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    await page.locator('.finding-card').click();

    await expect(page.locator('.detail-header')).toBeVisible();
    await expect(page.locator('.detail-badge')).toContainText('NEEDS INPUT');
    await expect(page.locator('.response-row input')).toBeVisible();
  });

  test('send response via detail panel', async ({ page, request }) => {
    await launchViaUI(page, 'Write unit tests', '/test/project');
    const tmuxName = await getLatestTmuxName(request);

    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    await page.locator('.finding-card').click();
    await page.locator('.response-row input').fill('Try running vitest');
    await page.locator('.btn-primary:has-text("Send & Next")').click();

    // Sent overlay appears briefly
    await expect(page.locator('.sent-overlay')).toBeVisible();
    await expect(page.locator('.sent-overlay')).toContainText('Hint sent');
  });

  test('skip finding via detail panel', async ({ page, request }) => {
    await launchViaUI(page, 'Fix CSS layout', '/test/project');
    const tmuxName = await getLatestTmuxName(request);

    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    await page.locator('.finding-card').click();
    await page.locator('.response-row .btn-secondary:has-text("Skip")').click();
  });

  test('snooze finding via detail panel', async ({ page, request }) => {
    await launchViaUI(page, 'Fix flaky test', '/test/project');
    const tmuxName = await getLatestTmuxName(request);

    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    await page.locator('.finding-card').click();
    await page.locator('.response-row .btn-secondary:has-text("Snooze")').click();
    await page.locator('.snooze-dialog-btn:has-text("5m")').click();
  });

  test('skip finding from findings panel actions', async ({ page, request }) => {
    await launchViaUI(page, 'Fix bug', '/test/project');
    const tmuxName = await getLatestTmuxName(request);

    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    await expect(page.locator('.finding-card')).toBeVisible();
    await page.locator('.finding-actions .btn-xs:has-text("Skip")').click();
  });

  // --- Priority ordering ---

  test('findings sorted by severity: permission before needs_input', async ({ page, request }) => {
    // Launch agent A — needs_input (info severity)
    await launchViaUI(page, 'Agent A task', '/test/a');
    const tmuxA = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxA);
    await injectStopEvent(request, tmuxA);

    // Launch agent B — permission_blocked (warning severity)
    await launchViaUI(page, 'Agent B task', '/test/b');
    const tmuxB = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxB);
    await injectPermissionEvent(request, tmuxB);

    await expect(page.locator('.finding-card')).toHaveCount(2);

    // Permission (warning) should appear first in the queue
    // The findings panel renders in snapshot order; Ctrl+N navigates by priority
    // Let's verify via Ctrl+N — first selection should be the permission finding
    await page.keyboard.press('Alt+n');
    await expect(page.locator('.finding-card.selected .finding-severity')).toContainText('Permission');
  });

  // --- Task rename ---

  test('rename task via double-click in findings panel', async ({ page, request }) => {
    await launchViaUI(page, 'Refactor API endpoints', '/test/project');
    const tmuxName = await getLatestTmuxName(request);

    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    await expect(page.locator('.finding-card')).toBeVisible();

    // Double-click task name to edit
    await page.locator('.finding-task').dblclick();
    const editInput = page.locator('.finding-task-edit');
    await expect(editInput).toBeVisible();

    await editInput.clear();
    await editInput.fill('API v2 Refactor');
    await editInput.press('Enter');

    // Name should be updated
    await expect(page.locator('.finding-task')).toContainText('API v2 Refactor');
  });

  test('rename task via double-click in detail panel heading', async ({ page, request }) => {
    await launchViaUI(page, 'Migrate database schema', '/test/project');
    const tmuxName = await getLatestTmuxName(request);

    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    // Select the finding to show detail panel
    await page.locator('.finding-card').click();

    // Double-click heading to rename
    await page.locator('.detail-header h2').dblclick();
    const headingEdit = page.locator('.detail-heading-edit');
    await expect(headingEdit).toBeVisible();

    await headingEdit.clear();
    await headingEdit.fill('DB Migration v3');
    await headingEdit.press('Enter');

    // Heading should reflect new name
    await expect(page.locator('.detail-header h2')).toContainText('DB Migration v3');
  });

  // --- Keyboard shortcuts ---

  test('Ctrl+N navigates to next finding', async ({ page, request }) => {
    await launchViaUI(page, 'Task one', '/test/a');
    const tmuxA = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxA);
    await injectStopEvent(request, tmuxA);

    await launchViaUI(page, 'Task two', '/test/b');
    const tmuxB = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxB);
    await injectStopEvent(request, tmuxB);

    await expect(page.locator('.finding-card')).toHaveCount(2);

    // Press Ctrl+N to select first finding
    await page.keyboard.press('Alt+n');
    await expect(page.locator('.finding-card.selected')).toHaveCount(1);

    // Press again to cycle to next
    await page.keyboard.press('Alt+n');
    await expect(page.locator('.finding-card.selected')).toHaveCount(1);
  });

  test('Ctrl+L opens quick launch bar', async ({ page }) => {
    await page.keyboard.press('Alt+l');
    await expect(page.locator('.quick-launch-bar')).toBeVisible();

    // Shows server CWD
    await expect(page.locator('.quick-launch-cwd')).toContainText('/home/user/projects');

    // Escape closes it
    await page.keyboard.press('Escape');
    await expect(page.locator('.quick-launch-bar')).not.toBeVisible();
  });

  // --- Stop agent ---

  test('cancel agent removes it from findings', async ({ page, request }) => {
    await launchViaUI(page, 'Temporary task', '/test/project');
    const tmuxName = await getLatestTmuxName(request);

    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    await page.locator('.finding-card').click();

    // Accept the confirm dialog
    page.on('dialog', (dialog) => dialog.accept());

    await page.locator('[data-testid="action-cancel"]').click();

    // Agent should be removed from findings
    await expect(page.locator('.finding-card')).not.toBeVisible({ timeout: 5000 });
  });

  // --- Connection indicator ---

  test('connection indicator shows connected state', async ({ page }) => {
    // When connected, the health dot should have the connected class (not disconnected)
    await expect(page.locator('.health-dot-connected')).toBeVisible();
  });

  // --- API health check ---

  test('health API returns ok', async ({ request }) => {
    const res = await request.get('/api/health');
    const data = await res.json();
    expect(data.status).toBe('ok');
  });

  // --- Multiple agents workflow ---

  test('full triage workflow: launch, detect, respond, advance', async ({ page, request }) => {
    // Launch two agents
    await launchViaUI(page, 'Fix login', '/test/auth');
    const tmux1 = await getLatestTmuxName(request);
    await injectSessionStart(request, tmux1);
    await injectStopEvent(request, tmux1);

    await launchViaUI(page, 'Fix signup', '/test/auth');
    const tmux2 = await getLatestTmuxName(request);
    await injectSessionStart(request, tmux2);
    await injectPermissionEvent(request, tmux2);

    // Both findings visible
    await expect(page.locator('.finding-card')).toHaveCount(2);
    await expect(page.locator('.statusbar')).toContainText('2 findings');

    // Navigate to highest-priority finding (permission_blocked)
    await page.keyboard.press('Alt+n');
    await expect(page.locator('.detail-badge')).toContainText('PERMISSION');

    // Send response
    await page.locator('.response-row input').fill('Allow the install');
    await page.locator('.btn-primary:has-text("Send & Next")').click();

    // Sent overlay appears
    await expect(page.locator('.sent-overlay')).toBeVisible();
  });

  // --- TopBar queue indicators ---

  test('topbar shows finding count and queue info', async ({ page, request }) => {
    await launchViaUI(page, 'Task for queue', '/test/project');
    const tmuxName = await getLatestTmuxName(request);

    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    // TopBar should show the finding queue without duplicating status counts
    await expect(page.locator('.queue-info')).toContainText('1 finding waiting');
    await expect(page.locator('.statusbar')).toContainText('1 task · 1 finding');
    await expect(page.locator('.topbar-stat')).toHaveCount(0);

    // Launch a healthy agent
    await launchViaUI(page, 'Healthy task', '/test/healthy');
    const tmux2 = await getLatestTmuxName(request);
    await injectSessionStart(request, tmux2);
    await injectToolUse(request, tmux2);

    // Healthy task state lives in the task list section; aggregate counts live in the status bar.
    await expect(page.locator('.healthy-section')).toBeVisible();
    await expect(page.locator('.healthy-label')).toContainText('Healthy');
    await expect(page.locator('.statusbar')).toContainText('2 tasks');
    await expect(page.locator('.topbar-stat')).toHaveCount(0);
  });

  // --- Focus stability ---

  test('anomaly event does not steal focus from launch dialog', async ({ page, request }) => {
    // Launch an agent first so there's something to get an anomaly
    await launchViaUI(page, 'Background task', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);

    // Select the agent so DetailPanel renders with it
    await page.locator('.healthy-row').click();

    // Now open launch dialog and start typing
    await page.locator('.btn-launch').click();
    const dialogTextarea = page.locator('.dialog textarea');
    await expect(dialogTextarea).toBeVisible();
    await dialogTextarea.focus();
    await dialogTextarea.fill('I am typing a task description');

    // While typing, inject an anomaly — this should NOT steal focus
    await injectStopEvent(request, tmuxName);

    // Wait for the anomaly to be processed by the UI
    await page.waitForTimeout(500);

    // Focus should still be on the dialog textarea, not on the response input
    await expect(dialogTextarea).toBeFocused();
  });

  test('anomaly event does not steal focus from quick launch input', async ({ page, request }) => {
    // Launch an agent
    await launchViaUI(page, 'Background task', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);

    // Select the agent
    await page.locator('.healthy-row').click();

    // Open quick launch bar
    await page.keyboard.press('Alt+l');
    const quickInput = page.locator('.quick-launch-bar input');
    await expect(quickInput).toBeVisible();
    await quickInput.fill('typing a quick command');

    // Inject an anomaly
    await injectStopEvent(request, tmuxName);
    await page.waitForTimeout(500);

    // Focus should stay on quick launch input
    await expect(quickInput).toBeFocused();
  });



  // --- Direct reply (no finding required) ---

  test('send direct reply to healthy agent via reply button', async ({ page, request }) => {
    await launchViaUI(page, 'Build dashboard feature', '/test/project');
    const tmuxName = await getLatestTmuxName(request);

    await injectSessionStart(request, tmuxName);
    await injectToolUse(request, tmuxName, 'Read');

    // Agent should be in healthy section
    await expect(page.locator('.healthy-section')).toBeVisible();
    await expect(page.locator('.healthy-row')).toBeVisible();

    // Hover to reveal reply button and click it
    await page.locator('.healthy-row').hover();
    await page.locator('[data-testid="reply-button"]').click();

    // Detail panel should open with response input
    await expect(page.locator('.detail-header')).toBeVisible();
    await expect(page.locator('.response-row input')).toBeVisible();

    // Button should say "Send" (not "Send & Next") for healthy agents
    await expect(page.locator('[data-testid="send-button"]')).toContainText('Send');
    await expect(page.locator('[data-testid="send-button"]')).not.toContainText('Send & Next');

    // Skip and Snooze buttons should not be visible for healthy agents
    await expect(page.locator('.response-row .btn-secondary:has-text("Skip")')).not.toBeVisible();
    await expect(page.locator('.response-row .btn-secondary:has-text("Snooze")')).not.toBeVisible();

    // Type and send a message
    await page.locator('.response-row input').fill('Please also add dark mode support');
    await page.locator('[data-testid="send-button"]').click();

    // Sent overlay should appear
    await expect(page.locator('.sent-overlay')).toBeVisible();

    // Verify the message was delivered to the agent's terminal session
    const keysRes = await request.get(`/api/test/keys-received/${encodeURIComponent(tmuxName)}`);
    expect(keysRes.status()).toBe(200);
    const keysData = await keysRes.json();
    expect(keysData.keysReceived).toContain('Please also add dark mode support');
  });

  test('direct reply via Enter key on healthy agent', async ({ page, request }) => {
    await launchViaUI(page, 'Implement search API', '/test/project');
    const tmuxName = await getLatestTmuxName(request);

    await injectSessionStart(request, tmuxName);
    await injectToolUse(request, tmuxName, 'Read');

    // Click the healthy row to select the agent
    await page.locator('.healthy-row').click();

    // Type message and press Enter
    await page.locator('.response-row input').fill('Use Elasticsearch instead of SQL');
    await page.locator('.response-row input').press('Enter');

    // Sent overlay appears
    await expect(page.locator('.sent-overlay')).toBeVisible();

    // Verify message delivered
    const keysRes = await request.get(`/api/test/keys-received/${encodeURIComponent(tmuxName)}`);
    expect(keysRes.status()).toBe(200);
    const keysData = await keysRes.json();
    expect(keysData.keysReceived).toContain('Use Elasticsearch instead of SQL');
  });

  test('direct reply via REST API endpoint', async ({ page, request }) => {
    await launchViaUI(page, 'REST reply test', '/test/project');
    const tmuxName = await getLatestTmuxName(request);

    await injectSessionStart(request, tmuxName);
    await injectToolUse(request, tmuxName, 'Read');

    // Send message via REST endpoint
    const res = await request.post(`/api/agents/${encodeURIComponent(tmuxName)}/message`, {
      data: { input: 'Hello from REST' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.delivered).toBe(true);

    // Verify message delivered
    const keysRes = await request.get(`/api/test/keys-received/${encodeURIComponent(tmuxName)}`);
    expect(keysRes.status()).toBe(200);
    const keysData = await keysRes.json();
    expect(keysData.keysReceived).toContain('Hello from REST');
  });

  // --- Removed tmux option endpoint ---

  test('launched dtach agent does not expose removed tmux session options', async ({ page, request }) => {
    await launchViaUI(page, 'Scroll test task', '/test/project');
    const tmuxName = await getLatestTmuxName(request);

    // V8 removed tmux; dtach has no mouse-mode option surface.
    const res = await request.get(`/api/test/session-option/${encodeURIComponent(tmuxName)}/mouse`);
    expect(res.status()).toBe(410);
    const data = await res.json();
    expect(data.error).toContain('dtach');
  });
});

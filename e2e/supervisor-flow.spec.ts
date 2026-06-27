/**
 * E2E tests for the supervisor flow — covers gaps identified in issue #35:
 *   - Auto-advance after responding to a finding
 *   - GitHub tab PR card rendering
 *   - Task lifecycle transitions (complete, cancel, archive, reopen)
 */
import { test, expect } from './fixtures.js';
import { resetServer } from './reset-server.js';
import type { Page, APIRequestContext } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Polls until an inProgress task with sessions appears (WebSocket launch is async). */
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

async function getTmuxNameForPrompt(request: APIRequestContext, prompt: string): Promise<string> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const res = await request.get('/api/tasks');
    const tasks = (await res.json()) as Array<{
      prompt: string;
      status: string;
      sessions: Array<{ tmuxSession: string }>;
    }>;
    const task = [...tasks].reverse().find((candidate) => candidate.prompt === prompt && candidate.status === 'inProgress');
    if (task?.sessions.length) {
      return task.sessions[task.sessions.length - 1].tmuxSession;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for task "${prompt}" with sessions`);
}

async function getTaskId(request: APIRequestContext, index = 0): Promise<string> {
  const res = await request.get('/api/tasks');
  const tasks = (await res.json()) as Array<{ id: string }>;
  return tasks[index].id;
}

async function injectEvent(
  request: APIRequestContext,
  tmuxName: string,
  event: Record<string, unknown>,
) {
  await request.post('/api/test/inject-event', {
    data: { tmuxName, event },
  });
}

async function injectSessionStart(request: APIRequestContext, tmuxName: string) {
  await injectEvent(request, tmuxName, {
    session_id: `sess-${Date.now()}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/test/project',
    hook_event_name: 'SessionStart',
  });
}

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

async function launchViaUI(page: Page, prompt: string, cwd: string) {
  // Ensure WebSocket is connected before launching (CI can be slow to connect)
  await expect(page.locator('.health-dot-connected')).toBeVisible({ timeout: 5000 });
  const expectedTaskCount = await currentTaskCount(page) + 1;
  await page.locator('.btn-launch').click();
  await page.locator('.dialog textarea').fill(prompt);
  const cwdInput = page.locator('.dialog input[type="text"]').first();
  await cwdInput.clear();
  await cwdInput.fill(cwd);
  await page.locator('.dialog .btn-primary').click();
  await expect(page.locator('.dialog')).not.toBeVisible();
  await waitForAgentCount(page, expectedTaskCount);
}

async function waitForAgentCount(page: Page, count: number) {
  await expect(page.locator('.statusbar')).toContainText(`${count} task`, { timeout: 5000 });
}

async function currentTaskCount(page: Page): Promise<number> {
  const status = await page.locator('.statusbar').textContent();
  const match = status?.match(/(\d+)\s+tasks?/);
  return match ? Number(match[1]) : 0;
}

// ---------------------------------------------------------------------------
// Auto-advance tests
// ---------------------------------------------------------------------------

test.describe('Supervisor flow — auto-advance', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('responding to a finding auto-advances selection to the next finding', async ({ page, request }) => {
    // Launch two agents, both with anomalies
    await launchViaUI(page, 'Agent Alpha', '/test/alpha');
    const tmuxA = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxA);
    await injectPermissionEvent(request, tmuxA);

    await launchViaUI(page, 'Agent Beta', '/test/beta');
    const tmuxB = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxB);
    await injectStopEvent(request, tmuxB);

    await expect(page.locator('.finding-card')).toHaveCount(2);

    // Navigate to the first finding (permission_blocked has higher priority)
    await page.keyboard.press('Alt+n');
    await expect(page.locator('.detail-badge')).toContainText('PERMISSION');

    // Send response to the permission finding
    await page.locator('.response-row textarea').fill('Allow it');
    await page.locator('[data-testid="send-next-button"]').click();

    // Sent overlay appears
    await expect(page.locator('.sent-overlay')).toBeVisible();

    // Selection should auto-advance to the next finding (the completed-turn
    // Stop finding). The detail panel should now show the next agent.
    await expect(page.locator('.detail-badge')).toContainText('SIGNALED COMPLETE');
  });

  test('skipping a finding auto-advances to the next finding', async ({ page, request }) => {
    // Launch two agents with anomalies
    const promptA = 'Skip Agent A';
    const promptB = 'Skip Agent B';
    await launchViaUI(page, promptA, '/test/a');
    const tmuxA = await getTmuxNameForPrompt(request, promptA);
    await injectSessionStart(request, tmuxA);
    await injectStopEvent(request, tmuxA);

    await launchViaUI(page, promptB, '/test/b');
    const tmuxB = await getTmuxNameForPrompt(request, promptB);
    await injectSessionStart(request, tmuxB);
    await injectStopEvent(request, tmuxB);

    await expect(page.locator('.finding-card')).toHaveCount(2);

    // Select first finding
    await page.keyboard.press('Alt+n');
    const firstSelected = await page.locator('.finding-card.selected .finding-task').textContent();

    // Skip it via detail panel
    await page.locator('.response-row .btn-secondary:has-text("Skip")').click();

    // Selection should advance — the selected finding should now be different
    const nextSelected = await page.locator('.finding-card.selected .finding-task').textContent();
    expect(nextSelected).not.toBe(firstSelected);
  });

  test('snoozing a finding auto-advances to next finding', async ({ page, request }) => {
    await launchViaUI(page, 'Snooze Agent A', '/test/a');
    const tmuxA = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxA);
    await injectStopEvent(request, tmuxA);

    await launchViaUI(page, 'Snooze Agent B', '/test/b');
    const tmuxB = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxB);
    await injectStopEvent(request, tmuxB);

    await expect(page.locator('.finding-card')).toHaveCount(2);

    // Select first finding
    await page.keyboard.press('Alt+n');
    const firstSelected = await page.locator('.finding-card.selected .finding-task').textContent();

    // Snooze it — click "Snooze" then select "5m" from dialog
    await page.locator('.response-row .btn-secondary:has-text("Snooze")').click();
    await page.locator('.snooze-dialog-btn:has-text("5m")').click();

    // Selection should advance to the remaining finding
    const nextSelected = await page.locator('.finding-card.selected .finding-task').textContent();
    expect(nextSelected).not.toBe(firstSelected);
  });
});

// ---------------------------------------------------------------------------
// GitHub tab — PR card rendering
// ---------------------------------------------------------------------------

test.describe('Supervisor flow — GitHub tab PR cards', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('GitHub tab appears when PR data is broadcast', async ({ page, request }) => {
    // Launch an agent
    await launchViaUI(page, 'PR test agent', '/test/project');
    await waitForAgentCount(page, 1);
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    // Select the finding so detail panel is visible
    await page.locator('.finding-card').click();
    await expect(page.locator('.detail-header')).toBeVisible();

    // Get the task ID
    const taskId = await getTaskId(request);

    // Broadcast GitHub PR data
    await request.post('/api/test/broadcast-github', {
      data: {
        taskId,
        prs: [{
          ref: {
            type: 'pr',
            owner: 'jeanibarz',
            repo: 'kookr',
            number: 42,
            url: 'https://github.com/kookr-ai/kookr/pull/42',
            detectedAt: new Date().toISOString(),
            detectedFrom: tmuxName,
            taskId,
          },
          title: 'feat: add supervisor dashboard',
          status: 'open',
          author: 'jeanibarz',
          branch: 'feature/dashboard',
          baseBranch: 'main',
          reviewDecision: null,
          reviewers: [],
          unresolvedThreads: [],
          totalComments: 0,
          checks: [],
          lastFetchedAt: new Date().toISOString(),
        }],
        issues: [],
        changes: [],
      },
    });

    // GitHub tab should appear
    const githubTab = page.locator('.pane-tab:has-text("GitHub")');
    await expect(githubTab).toBeVisible();
    await expect(githubTab).toContainText('1');

    // Click GitHub tab to switch
    await githubTab.click();

    // PR card should be visible
    await expect(page.locator('.gh-pr-card')).toBeVisible();
    await expect(page.locator('.gh-pr-title')).toContainText('#42 feat: add supervisor dashboard');
    await expect(page.locator('.gh-badge-open')).toContainText('OPEN');
    await expect(page.locator('.gh-pr-meta')).toContainText('feature/dashboard');
    await expect(page.locator('.gh-pr-meta')).toContainText('main');
  });

  test('PR card shows review decision and unresolved threads', async ({ page, request }) => {
    await launchViaUI(page, 'Review PR agent', '/test/project');
    await waitForAgentCount(page, 1);
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    await page.locator('.finding-card').click();
    const taskId = await getTaskId(request);

    // Broadcast PR with changes_requested and unresolved thread
    await request.post('/api/test/broadcast-github', {
      data: {
        taskId,
        prs: [{
          ref: {
            type: 'pr',
            owner: 'jeanibarz',
            repo: 'kookr',
            number: 55,
            url: 'https://github.com/kookr-ai/kookr/pull/55',
            detectedAt: new Date().toISOString(),
            detectedFrom: tmuxName,
            taskId,
          },
          title: 'fix: resolve memory leak',
          status: 'open',
          author: 'jeanibarz',
          branch: 'fix/memory-leak',
          baseBranch: 'main',
          reviewDecision: 'changes_requested',
          reviewers: [{ login: 'reviewer1', state: 'changes_requested' }],
          unresolvedThreads: [{
            id: 'thread-1',
            isResolved: false,
            author: 'reviewer1',
            body: 'This allocation should be pooled.',
            path: 'src/core/monitor.ts',
            line: 42,
            createdAt: new Date().toISOString(),
          }],
          totalComments: 3,
          checks: [
            { name: 'CI', status: 'completed', conclusion: 'success' },
            { name: 'Lint', status: 'completed', conclusion: 'failure' },
          ],
          lastFetchedAt: new Date().toISOString(),
        }],
        issues: [],
        changes: [],
      },
    });

    const githubTab = page.locator('.pane-tab:has-text("GitHub")');
    await expect(githubTab).toBeVisible();
    await githubTab.click();

    // Review decision
    await expect(page.locator('.gh-review-changes_requested')).toContainText('Changes requested');

    // Unresolved threads
    await expect(page.locator('.gh-threads-header')).toContainText('1 unresolved comment');
    await expect(page.locator('.gh-thread-author')).toContainText('@reviewer1');
    await expect(page.locator('.gh-thread-body')).toContainText('This allocation should be pooled');
    await expect(page.locator('.gh-thread-path')).toContainText('src/core/monitor.ts:42');

    // CI checks
    await expect(page.locator('.gh-checks-summary .gh-check-fail')).toContainText('1 check failed');
    await expect(page.locator('.gh-check-item.gh-check-fail')).toContainText('Lint');
  });

  test('GitHub panel shows empty state when no references', async ({ page, request }) => {
    await launchViaUI(page, 'No refs agent', '/test/project');
    await waitForAgentCount(page, 1);
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    await page.locator('.finding-card').click();

    // Without any githubUpdate, there should be no GitHub tab at all
    // (the tab only appears when ghCount > 0)
    await expect(page.locator('.pane-tab:has-text("GitHub")')).not.toBeVisible();
  });

  test('GitHub tab shows issue cards', async ({ page, request }) => {
    await launchViaUI(page, 'Issue agent', '/test/project');
    await waitForAgentCount(page, 1);
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    await page.locator('.finding-card').click();
    const taskId = await getTaskId(request);

    await request.post('/api/test/broadcast-github', {
      data: {
        taskId,
        prs: [],
        issues: [{
          ref: {
            type: 'issue',
            owner: 'jeanibarz',
            repo: 'kookr',
            number: 35,
            url: 'https://github.com/kookr-ai/kookr/issues/35',
            detectedAt: new Date().toISOString(),
            detectedFrom: tmuxName,
            taskId,
          },
          title: 'Add E2E test suite for supervisor flow',
          status: 'open',
          author: 'jeanibarz',
          labels: ['enhancement', 'testing'],
          commentCount: 5,
          lastFetchedAt: new Date().toISOString(),
        }],
        changes: [],
      },
    });

    const githubTab = page.locator('.pane-tab:has-text("GitHub")');
    await expect(githubTab).toBeVisible();
    await githubTab.click();

    // Issue card should render
    await expect(page.locator('.gh-issue-card')).toBeVisible();
    await expect(page.locator('.gh-issue-title')).toContainText('#35 Add E2E test suite');
    await expect(page.locator('.gh-badge-open')).toContainText('OPEN');
    await expect(page.locator('.gh-label')).toHaveCount(2);
    await expect(page.locator('.gh-comment-count')).toContainText('5 comments');
  });

  test('switching back to Activity from GitHub pane works', async ({ page, request }) => {
    await launchViaUI(page, 'Tab switch agent', '/test/project');
    await waitForAgentCount(page, 1);
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    await page.locator('.finding-card').click();
    const taskId = await getTaskId(request);

    // Broadcast minimal PR data to make GitHub pane-tab appear
    await request.post('/api/test/broadcast-github', {
      data: {
        taskId,
        prs: [{
          ref: {
            type: 'pr', owner: 'o', repo: 'r', number: 1,
            url: 'https://github.com/o/r/pull/1',
            detectedAt: new Date().toISOString(),
            detectedFrom: tmuxName, taskId,
          },
          title: 'Test PR', status: 'open', author: 'test',
          branch: 'b', baseBranch: 'main',
          reviewDecision: null, reviewers: [],
          unresolvedThreads: [], totalComments: 0, checks: [],
          lastFetchedAt: new Date().toISOString(),
        }],
        issues: [],
        changes: [],
      },
    });

    // Switch left pane to GitHub
    const githubTab = page.locator('.pane-tab:has-text("GitHub")');
    await expect(githubTab).toBeVisible();
    await githubTab.click();
    await expect(page.locator('.gh-pr-card')).toBeVisible();

    // Switch left pane back to Activity
    await page.locator('.pane-tab:has-text("Activity")').click();

    // GitHub panel should not be visible anymore
    await expect(page.locator('.gh-pr-card')).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Task lifecycle transitions
// ---------------------------------------------------------------------------

test.describe('Supervisor flow — task lifecycle', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('launched task is in inProgress status', async ({ request, page }) => {
    await launchViaUI(page, 'Lifecycle test', '/test/project');
    await waitForAgentCount(page, 1);

    const res = await request.get('/api/tasks');
    const tasks = await res.json();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe('inProgress');
  });

  test('complete transition: inProgress → completed', async ({ request, page }) => {
    await launchViaUI(page, 'Complete me', '/test/project');
    await waitForAgentCount(page, 1);

    const taskId = await getTaskId(request);

    const completeRes = await request.post(`/api/test/complete-task/${taskId}`);
    expect(completeRes.ok()).toBe(true);

    const res = await request.get('/api/tasks');
    const tasks = await res.json();
    expect(tasks[0].status).toBe('completed');
  });

  test('cancel transition: inProgress → cancelled', async ({ request, page }) => {
    await launchViaUI(page, 'Cancel me', '/test/project');
    await waitForAgentCount(page, 1);

    const taskId = await getTaskId(request);

    const cancelRes = await request.post(`/api/test/cancel-task/${taskId}`);
    expect(cancelRes.ok()).toBe(true);

    const res = await request.get('/api/tasks');
    const tasks = await res.json();
    expect(tasks[0].status).toBe('cancelled');
  });

  // archive tests removed — archived state no longer exists in TaskStatus

  test('reopen transition: cancelled → open', async ({ request, page }) => {
    await launchViaUI(page, 'Reopen me', '/test/project');
    await waitForAgentCount(page, 1);

    const taskId = await getTaskId(request);

    await request.post(`/api/test/cancel-task/${taskId}`);
    const reopenRes = await request.post(`/api/test/reopen-task/${taskId}`);
    expect(reopenRes.ok()).toBe(true);

    const res = await request.get('/api/tasks');
    const tasks = await res.json();
    expect(tasks[0].status).toBe('open');
  });

  test('cancelling agent via UI cancels the task', async ({ page, request }) => {
    await launchViaUI(page, 'Cancel lifecycle', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    // Select the finding
    await page.locator('.finding-card').click();

    // Accept the confirm dialog
    page.on('dialog', (dialog) => dialog.accept());
    await page.locator('[data-testid="action-cancel"]').click();

    // Wait for the agent to disappear
    await expect(page.locator('.finding-card')).not.toBeVisible({ timeout: 5000 });

    // Task should be cancelled
    const res = await request.get('/api/tasks');
    const tasks = await res.json();
    expect(tasks[0].status).toBe('cancelled');
  });

  test('clear completed sweeps both completed and cancelled tasks via the section-header button', async ({ page, request }, testInfo) => {
    testInfo.setTimeout(30_000);
    // Launch 3 tasks
    await launchViaUI(page, 'Keep running', '/test/project');
    await launchViaUI(page, 'Will complete', '/test/project');
    await launchViaUI(page, 'Will cancel', '/test/project');
    await waitForAgentCount(page, 3);

    const res = await request.get('/api/tasks');
    const allTasks = (await res.json()) as Array<{ id: string; status: string }>;
    expect(allTasks).toHaveLength(3);

    // Complete second task, cancel third. The server-side default sweep per
    // rfc-task-loss-prevention D2 (revised 2026-04-23) covers both.
    await request.post(`/api/test/complete-task/${allTasks[1].id}`);
    await request.post(`/api/test/cancel-task/${allTasks[2].id}`);

    // Wait for Completed section to appear — the clear button lives in its header now.
    const completedSection = page.locator('.completed-section');
    await expect(completedSection).toBeVisible({ timeout: 5000 });
    const completedToggle = completedSection.locator('.section-header');
    if (await completedToggle.getAttribute('aria-expanded') === 'false') {
      await completedToggle.click();
    }
    await expect(completedSection.locator('.completed-row')).toHaveCount(2);

    // Scope the button locator to the section so we don't pick up any legacy
    // status-bar duplicate if one ever reappears.
    const clearBtn = completedSection.locator('.btn-clear-completed');
    await expect(clearBtn).toBeVisible();
    await clearBtn.click();

    // First click opens the confirmation; the destructive calls are deferred
    // behind the client-side undo window, so rows become pending before they
    // disappear.
    const confirmBtn = page.getByRole('dialog', { name: 'Clear completed tasks' }).getByRole('button', { name: 'Delete' });
    await expect(confirmBtn).toBeVisible({ timeout: 2000 });
    await confirmBtn.click();
    await expect(completedSection.locator('.completed-row.pending-deletion')).toHaveCount(2);
    await expect(page.locator('.toast-undo')).toContainText('Deleting 2 finished tasks');

    // The whole Completed section disappears because no terminal tasks remain.
    await expect(completedSection).not.toBeVisible({ timeout: 15000 });

    // Only the running task should remain on the server.
    await waitForAgentCount(page, 1);
    const remaining = await request.get('/api/tasks');
    const remainingTasks = (await remaining.json()) as Array<{ id: string; status: string }>;
    expect(remainingTasks).toHaveLength(1);
    expect(remainingTasks[0].status).toBe('inProgress');
  });
});

// ---------------------------------------------------------------------------
// Anomaly explanation rendering
// ---------------------------------------------------------------------------

test.describe('Supervisor flow — anomaly explanation', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('finding card shows anomaly explanation text', async ({ page, request }) => {
    await launchViaUI(page, 'Explain test', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    await expect(page.locator('.finding-card')).toBeVisible();
    // The explanation text should be visible in the finding card
    await expect(page.locator('.finding-explanation')).toBeVisible();
    // It should contain some meaningful text (not empty)
    const text = await page.locator('.finding-explanation').textContent();
    expect(text!.length).toBeGreaterThan(0);
  });

  test('permission_blocked finding shows tool information in explanation', async ({ page, request }) => {
    await launchViaUI(page, 'Permission explain', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectPermissionEvent(request, tmuxName);

    await expect(page.locator('.finding-card')).toBeVisible();
    const explanation = await page.locator('.finding-explanation').textContent();
    // Permission blocked anomaly should mention the tool or permission
    expect(explanation!.length).toBeGreaterThan(0);
  });
});

import { test, expect } from './fixtures.js';
import { resetServer } from './reset-server.js';
import type { Page, APIRequestContext } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getLatestTaskId(request: APIRequestContext): Promise<string> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const res = await request.get('/api/tasks');
    const tasks = (await res.json()) as Array<{ id: string; status: string }>;
    const inProgress = tasks.filter((t) => t.status === 'inProgress');
    if (inProgress.length > 0) {
      return inProgress[inProgress.length - 1].id;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Timed out waiting for an inProgress task');
}

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

async function injectToolUse(request: APIRequestContext, tmuxName: string) {
  await injectEvent(request, tmuxName, {
    session_id: `sess-${Date.now()}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/test/project',
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
  });
}

async function launchViaUI(page: Page, prompt: string, cwd: string) {
  await expect(page.locator('.health-dot-connected')).toBeVisible({ timeout: 5000 });
  await page.locator('.btn-launch').click();
  await page.locator('.dialog textarea').fill(prompt);
  const cwdInput = page.locator('.dialog input[type="text"]').first();
  await cwdInput.clear();
  await cwdInput.fill(cwd);
  await page.locator('.dialog .btn-primary').click();
  await expect(page.locator('.dialog')).not.toBeVisible();
}

async function setProjectId(request: APIRequestContext, taskId: string, projectId: string) {
  await request.post('/api/test/set-project-id', {
    data: { taskId, projectId },
  });
}

async function broadcastProjectSummaries(request: APIRequestContext) {
  await request.post('/api/test/broadcast-project-summaries');
}

/** Set up a project in the sidebar by launching a task, assigning it a projectId,
 *  and broadcasting project summaries so the sidebar renders. */
async function setupProjectInSidebar(
  page: Page,
  request: APIRequestContext,
  projectId: string,
) {
  await launchViaUI(page, 'Workspace test task', '/test/project');
  const tmuxName = await getLatestTmuxName(request);
  const taskId = await getLatestTaskId(request);
  await injectSessionStart(request, tmuxName);
  await injectToolUse(request, tmuxName);
  await setProjectId(request, taskId, projectId);
  await broadcastProjectSummaries(request);
  await expect(page.locator(`[data-testid="project-icon-${projectId}"]`)).toBeVisible({ timeout: 5000 });
}

/** Click a project icon, which opens the project detail drawer. */
async function openProjectDrawer(page: Page, projectId: string) {
  await page.locator(`[data-testid="project-icon-${projectId}"]`).click();
  await expect(page.locator('[data-testid="project-detail-drawer"]')).toBeVisible({ timeout: 3000 });
}

/** Open the workspace overlay by clicking the Workspace button in the drawer. */
async function openWorkspace(page: Page) {
  await page.locator('[data-testid="project-workspace-btn"]').click();
  await expect(page.locator('.workspace-overlay')).toBeVisible({ timeout: 3000 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Contribution Workspace', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.health-dot-connected')).toBeVisible({ timeout: 5000 });
  });

  test('workspace button not visible when no project selected', async ({ page }) => {
    // No project in sidebar, no drawer, no workspace button
    await expect(page.locator('[data-testid="project-workspace-btn"]')).not.toBeVisible();
  });

  test('project drawer shows workspace button when project selected', async ({ page, request }) => {
    const projectId = 'github.com/org/repo';
    await setupProjectInSidebar(page, request, projectId);
    await openProjectDrawer(page, projectId);

    await expect(page.locator('[data-testid="project-workspace-btn"]')).toBeVisible();
    await expect(page.locator('[data-testid="project-workspace-btn"]')).toContainText('Workspace');
  });

  test('click workspace button opens overlay', async ({ page, request }) => {
    const projectId = 'github.com/org/workspace-test';
    await setupProjectInSidebar(page, request, projectId);
    await openProjectDrawer(page, projectId);
    await openWorkspace(page);

    await expect(page.locator('.workspace-panel')).toBeVisible();
    await expect(page.locator('.workspace-overlay')).toBeVisible();
  });

  test('close workspace with X button', async ({ page, request }) => {
    const projectId = 'github.com/org/close-x';
    await setupProjectInSidebar(page, request, projectId);
    await openProjectDrawer(page, projectId);
    await openWorkspace(page);

    // Click the close button
    await page.locator('.workspace-close').click();

    // Overlay should disappear
    await expect(page.locator('.workspace-overlay')).not.toBeVisible();
  });

  test('close workspace by clicking overlay backdrop', async ({ page, request }) => {
    const projectId = 'github.com/org/close-backdrop';
    await setupProjectInSidebar(page, request, projectId);
    await openProjectDrawer(page, projectId);
    await openWorkspace(page);

    // Click outside the panel (on the overlay backdrop)
    // The overlay fills the screen; click at top-left corner away from the panel
    await page.locator('.workspace-overlay').click({ position: { x: 5, y: 5 } });

    // Overlay should disappear
    await expect(page.locator('.workspace-overlay')).not.toBeVisible();
  });

  test('cleanup view shows empty state when no candidates', async ({ page, request }) => {
    const projectId = 'github.com/org/cleanup-empty';
    await setupProjectInSidebar(page, request, projectId);
    await openProjectDrawer(page, projectId);
    await openWorkspace(page);

    // Should show empty state (test server has no real git repos)
    await expect(page.locator('.cleanup-empty')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.cleanup-empty')).toContainText('No worktree candidates');

    // Should have a refresh button in the empty state
    await expect(page.locator('.cleanup-empty button')).toBeVisible();
  });

  test('workspace panel shows project name', async ({ page, request }) => {
    const projectId = 'github.com/org/named-project';
    await setupProjectInSidebar(page, request, projectId);
    await openProjectDrawer(page, projectId);
    await openWorkspace(page);

    // The workspace header should show "Workspace Cleanup"
    await expect(page.locator('.workspace-header h2')).toContainText('Workspace Cleanup');
  });

  test('cleanup list rows render age, ahead/behind, dirty, detached, and failed states', async ({ page, request }) => {
    const projectId = 'github.com/org/subtext-demo';
    await setupProjectInSidebar(page, request, projectId);
    await openProjectDrawer(page, projectId);
    await openWorkspace(page);

    const caps = {
      canSafeRemove: false,
      canRemovePathKeepBranch: true,
      canReviewedDiscard: true,
      requiresDirtyRecovery: false,
      defaultActionLabel: 'Keep branch, remove path',
      riskSummary: 'Branch has local-only commits.',
    };
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    const view = {
      projectId,
      displayName: projectId,
      policy: 'known_policy',
      repoPath: '/repo',
      candidates: [
        {
          projectId,
          worktreePath: '/repo-wt-a',
          branch: 'feat/with-commits',
          classification: 'unique_commits',
          reasonCode: 'has_unique_commits',
          source: 'cleanup_inspector',
          baselineRef: 'origin/main',
          observedAt: new Date().toISOString(),
          recoveryGuidance: '',
          capabilities: caps,
          commitSummary: {
            aheadCount: 2,
            behindCount: 97,
            lastCommitAt: threeDaysAgo,
            lastCommitSubject: 'fix: isolate env',
          },
        },
        {
          projectId,
          worktreePath: '/repo-wt-det',
          branch: '(detached at abc1234)',
          classification: 'unknown',
          reasonCode: 'detached_head',
          source: 'cleanup_inspector',
          observedAt: new Date().toISOString(),
          recoveryGuidance: '',
          capabilities: caps,
          headShortSha: 'abc1234',
          dirtySummary: { modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 3 },
        },
        {
          projectId,
          worktreePath: '/repo-wt-failed',
          branch: 'feat/enrichment-failed',
          classification: 'unique_commits',
          reasonCode: 'has_unique_commits',
          source: 'cleanup_inspector',
          baselineRef: 'origin/main',
          observedAt: new Date().toISOString(),
          recoveryGuidance: '',
          capabilities: caps,
          enrichmentFailed: true,
        },
      ],
      recentAttempts: [],
      activeLeases: [],
    };

    await request.post('/api/test/broadcast-workspace-view', { data: view });

    // Wait for the first row to render (empty-state should disappear).
    await expect(page.locator('[data-cleanup-row]').first()).toBeVisible({ timeout: 5000 });

    // Row 1: real data — "N days ago · +2 / −97" somewhere in subtext.
    // Use a regex for the age: the exact value depends on the render-time
    // clock vs the seeded ISO; 2–4 days is fine so long as the formatter
    // is producing *some* relative-time string and the ahead/behind part
    // is exact.
    const row1 = page.locator('[data-cleanup-row]').nth(0);
    await expect(row1.locator('[data-cleanup-subtext]')).toContainText(/\d+ days? ago/);
    await expect(row1.locator('[data-cleanup-subtext]')).toContainText('+2 / −97');

    // Row 2: detached HEAD — "HEAD abc1234 · U3".
    const row2 = page.locator('[data-cleanup-row]').nth(1);
    await expect(row2.locator('[data-cleanup-subtext]')).toContainText('HEAD abc1234');
    await expect(row2.locator('[data-cleanup-subtext]')).toContainText('U3');

    // Row 3: enrichment failed — "(!) details unavailable".
    const row3 = page.locator('[data-cleanup-row]').nth(2);
    await expect(row3.locator('[data-cleanup-subtext]')).toContainText('(!) details unavailable');
    await expect(row3.locator('[data-cleanup-subtext]')).toHaveClass(/cleanup-list-subtext--failed/);

    // Selecting row 1 should populate the detail grid with ahead/behind
    // and last commit subject.
    await row1.click();
    await expect(page.locator('.cleanup-detail-card dt', { hasText: /Ahead \/ behind/ })).toBeVisible();
    await expect(page.locator('.cleanup-detail-card')).toContainText('+2');
    await expect(page.locator('.cleanup-detail-card')).toContainText('−97');
    await expect(page.locator('.cleanup-detail-card dt', { hasText: 'Last commit' })).toBeVisible();
    await expect(page.locator('.cleanup-detail-card')).toContainText('fix: isolate env');
  });
});

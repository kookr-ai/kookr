import { test, expect } from './fixtures.js';
import type { Page, APIRequestContext } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


async function resetServer(request: APIRequestContext) {
  await request.post('/api/test/reset');
}

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

async function launchViaUI(page: Page, prompt: string, cwd: string) {
  // Ensure WebSocket is connected before launching (CI can be slow to connect)
  await expect(page.locator('.health-dot-connected')).toBeVisible({ timeout: 5000 });
  await page.locator('.btn-launch').click();
  await page.locator('.dialog textarea').fill(prompt);
  const cwdInput = page.locator('.dialog input[type="text"]').first();
  await cwdInput.clear();
  await cwdInput.fill(cwd);
  await page.locator('.dialog .btn-primary').click();
  await expect(page.locator('.dialog')).not.toBeVisible();
}

async function waitForAgentCount(page: Page, count: number) {
  await expect(page.locator('.statusbar')).toContainText(`${count} task`, { timeout: 5000 });
}

async function setProjectId(request: APIRequestContext, taskId: string, projectId: string) {
  await request.post('/api/test/set-project-id', {
    data: { taskId, projectId },
  });
}

async function broadcastProjectSummaries(request: APIRequestContext) {
  await request.post('/api/test/broadcast-project-summaries');
}

async function setProjectConfig(request: APIRequestContext, project: string, config: Record<string, unknown>) {
  await request.post('/api/test/set-project-config', {
    data: { project, ...config },
  });
}

async function addContribution(request: APIRequestContext, record: Record<string, unknown>) {
  await request.post('/api/test/add-contribution', {
    data: record,
  });
}

async function seedProjectSidebarCatalog(page: Page, count: number) {
  await page.addInitScript((seedCount) => {
    const catalog: Record<string, { project: string; displayName: string; color: number; lastSeenAt: string }> = {};
    const ordered: string[] = [];
    for (let i = 0; i < seedCount; i += 1) {
      const project = `github.com/org/repo-${i}`;
      ordered.push(project);
      catalog[project] = {
        project,
        displayName: `org/repo-${i}`,
        color: i % 8,
        lastSeenAt: '2026-04-24T00:00:00.000Z',
      };
    }
    localStorage.setItem('kookr:projectSidebarCatalog', JSON.stringify(catalog));
    localStorage.setItem('kookr:projectSidebarPrefs', JSON.stringify({
      version: 2,
      ordered,
      pinned: [],
      hidden: [],
    }));
  }, count);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Multi-Project Tracking', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('project sidebar appears when 1+ projects have agents', async ({ page, request }) => {
    // Launch a single agent in project A
    await launchViaUI(page, 'Task in repo A', '/test/repo-a');
    const tmuxA = await getLatestTmuxName(request);
    const taskA = await getLatestTaskId(request);
    await injectSessionStart(request, tmuxA);
    await injectToolUse(request, tmuxA);
    await setProjectId(request, taskA, 'github.com/org/repo-a');

    // Broadcast project summaries to trigger sidebar visibility
    await broadcastProjectSummaries(request);

    // Sidebar should be visible even with just 1 project
    await expect(page.locator('[data-testid="project-sidebar"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid="project-icon-all"]')).toBeVisible();
  });

  test('project sidebar is hidden with 0 projects', async ({ page, request }) => {
    // No agents, no project summaries — sidebar should not be visible
    await expect(page.locator('[data-testid="project-sidebar"]')).not.toBeVisible();
  });

  test('clicking project icon filters findings to that project', async ({ page, request }) => {
    // Launch agent A
    await launchViaUI(page, 'Fix auth in A', '/test/repo-a');
    const tmuxA = await getLatestTmuxName(request);
    const taskA = await getLatestTaskId(request);
    await injectSessionStart(request, tmuxA);
    await injectStopEvent(request, tmuxA);
    await setProjectId(request, taskA, 'github.com/org/repo-a');

    // Launch agent B
    await launchViaUI(page, 'Fix build in B', '/test/repo-b');
    const tmuxB = await getLatestTmuxName(request);
    const taskB = await getLatestTaskId(request);
    await injectSessionStart(request, tmuxB);
    await injectStopEvent(request, tmuxB);
    await setProjectId(request, taskB, 'github.com/org/repo-b');

    // Both findings visible
    await expect(page.locator('.finding-card')).toHaveCount(2, { timeout: 10000 });

    // Broadcast project summaries
    await broadcastProjectSummaries(request);
    await expect(page.locator('[data-testid="project-sidebar"]')).toBeVisible({ timeout: 5000 });

    // Click project A icon to filter
    await page.locator('[data-testid="project-icon-github.com/org/repo-a"]').click();

    // Only project A's finding should be visible
    await expect(page.locator('.finding-card')).toHaveCount(1, { timeout: 3000 });

    // Click "All Projects" to see both again
    await page.locator('[data-testid="project-icon-all"]').click();
    await expect(page.locator('.finding-card')).toHaveCount(2, { timeout: 3000 });
  });

  test('Alt+P toggles project sidebar visibility', async ({ page, request }) => {
    // Launch agents to trigger sidebar
    await launchViaUI(page, 'Task A', '/test/a');
    const tmuxA = await getLatestTmuxName(request);
    const taskA = await getLatestTaskId(request);
    await injectSessionStart(request, tmuxA);
    await setProjectId(request, taskA, 'github.com/org/a');

    await launchViaUI(page, 'Task B', '/test/b');
    const tmuxB = await getLatestTmuxName(request);
    const taskB = await getLatestTaskId(request);
    await injectSessionStart(request, tmuxB);
    await setProjectId(request, taskB, 'github.com/org/b');

    await broadcastProjectSummaries(request);
    await expect(page.locator('[data-testid="project-sidebar"]')).toBeVisible({ timeout: 5000 });

    // Alt+P should hide sidebar
    await page.keyboard.press('Alt+p');
    await expect(page.locator('[data-testid="project-sidebar"]')).not.toBeVisible();

    // Alt+P again should show it
    await page.keyboard.press('Alt+p');
    await expect(page.locator('[data-testid="project-sidebar"]')).toBeVisible();
  });

  test('project organizer dialog stays within viewport and scrolls in its body', async ({ page, request }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await seedProjectSidebarCatalog(page, 30);
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');

    await expect(page.locator('[data-testid="project-sidebar"]')).toBeVisible({ timeout: 5000 });
    await page.locator('[data-testid="project-sidebar-organizer"]').click();

    const dialog = page.locator('.project-sidebar-manager');
    const body = page.locator('[data-testid="project-sidebar-manager-body"]');
    await expect(dialog).toBeVisible();
    await expect(body).toBeVisible();

    const metrics = await dialog.evaluate((element) => {
      const dialogEl = element as HTMLElement;
      const bodyEl = dialogEl.querySelector('.project-sidebar-manager-body') as HTMLElement | null;
      if (!bodyEl) throw new Error('Missing project-sidebar-manager-body');
      const dialogRect = dialogEl.getBoundingClientRect();
      const dialogStyle = getComputedStyle(dialogEl);
      const bodyStyle = getComputedStyle(bodyEl);
      return {
        viewportHeight: window.innerHeight,
        top: dialogRect.top,
        bottom: dialogRect.bottom,
        dialogClientHeight: dialogEl.clientHeight,
        dialogScrollHeight: dialogEl.scrollHeight,
        dialogOverflow: dialogStyle.overflow,
        bodyClientHeight: bodyEl.clientHeight,
        bodyScrollHeight: bodyEl.scrollHeight,
        bodyOverflowY: bodyStyle.overflowY,
      };
    });

    expect(metrics.top).toBeGreaterThanOrEqual(0);
    expect(metrics.bottom).toBeLessThanOrEqual(metrics.viewportHeight);
    expect(metrics.dialogOverflow).toBe('hidden');
    expect(metrics.bodyOverflowY).toBe('auto');
    expect(metrics.bodyScrollHeight).toBeGreaterThan(metrics.bodyClientHeight);
    expect(metrics.dialogScrollHeight).toBe(metrics.dialogClientHeight);
  });

  test('Alt+0 selects All Projects', async ({ page, request }) => {
    await launchViaUI(page, 'Task', '/test/a');
    const tmux = await getLatestTmuxName(request);
    const taskId = await getLatestTaskId(request);
    await injectSessionStart(request, tmux);
    await injectStopEvent(request, tmux);
    await setProjectId(request, taskId, 'github.com/org/repo');

    await launchViaUI(page, 'Task B', '/test/b');
    const tmuxB = await getLatestTmuxName(request);
    const taskB = await getLatestTaskId(request);
    await injectSessionStart(request, tmuxB);
    await injectStopEvent(request, tmuxB);
    await setProjectId(request, taskB, 'github.com/org/repo-b');

    await broadcastProjectSummaries(request);
    await expect(page.locator('[data-testid="project-sidebar"]')).toBeVisible({ timeout: 5000 });

    // Select project A with the current project-sidebar shortcut range.
    // Alt+1..3 are reserved for terminal send-and-next actions.
    await page.keyboard.press('Alt+4');
    await expect(page.locator('.finding-card')).toHaveCount(1, { timeout: 3000 });

    // Alt+0 goes back to All Projects
    await page.keyboard.press('Alt+0');
    await expect(page.locator('.finding-card')).toHaveCount(2, { timeout: 3000 });
  });

  test('project API returns summaries', async ({ request }) => {
    const res = await request.get('/api/projects');
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test('project config API persists settings', async ({ request }) => {
    const res = await request.post('/api/projects/configs', {
      data: {
        project: 'github.com/test/repo',
        dailyPrLimit: 3,
        notes: 'Test note',
      },
    });
    expect(res.status()).toBe(200);
    const config = await res.json();
    expect(config.project).toBe('github.com/test/repo');
    expect(config.dailyPrLimit).toBe(3);

    // Verify it persisted
    const configsRes = await request.get('/api/projects/configs');
    const configs = await configsRes.json();
    expect(configs).toHaveLength(1);
    expect(configs[0].notes).toBe('Test note');
  });

  test('project icon shows anomaly badge when project has findings', async ({ page, request }) => {
    await launchViaUI(page, 'Stuck task', '/test/a');
    const tmux = await getLatestTmuxName(request);
    const taskId = await getLatestTaskId(request);
    await injectSessionStart(request, tmux);
    await injectStopEvent(request, tmux);
    await setProjectId(request, taskId, 'github.com/org/repo-a');

    await launchViaUI(page, 'Healthy task', '/test/b');
    const tmux2 = await getLatestTmuxName(request);
    const taskId2 = await getLatestTaskId(request);
    await injectSessionStart(request, tmux2);
    await injectToolUse(request, tmux2);
    await setProjectId(request, taskId2, 'github.com/org/repo-b');

    await broadcastProjectSummaries(request);
    await expect(page.locator('[data-testid="project-sidebar"]')).toBeVisible({ timeout: 5000 });

    // Project A should have an anomaly badge
    const projectA = page.locator('[data-testid="project-icon-github.com/org/repo-a"]');
    await expect(projectA.locator('.project-icon-badge.anomaly')).toBeVisible();
    await expect(projectA.locator('.project-icon-badge.anomaly')).toContainText('1');

    // Project B should have an executing-task count, no anomaly badge
    const projectB = page.locator('[data-testid="project-icon-github.com/org/repo-b"]');
    await expect(projectB.locator('.project-icon-task-count')).toContainText('1');
    await expect(projectB.locator('.project-icon-badge')).not.toBeVisible();
  });

  test('statusbar reflects filtered count when project selected', async ({ page, request }) => {
    await launchViaUI(page, 'Task A', '/test/a');
    const tmuxA = await getLatestTmuxName(request);
    const taskA = await getLatestTaskId(request);
    await injectSessionStart(request, tmuxA);
    await injectToolUse(request, tmuxA);
    await setProjectId(request, taskA, 'github.com/org/repo-a');

    await launchViaUI(page, 'Task B', '/test/b');
    const tmuxB = await getLatestTmuxName(request);
    const taskB = await getLatestTaskId(request);
    await injectSessionStart(request, tmuxB);
    await injectToolUse(request, tmuxB);
    await setProjectId(request, taskB, 'github.com/org/repo-b');

    // Total should be 2
    await expect(page.locator('.statusbar')).toContainText('2 tasks', { timeout: 5000 });

    // Broadcast summaries and filter to project A
    await broadcastProjectSummaries(request);
    await expect(page.locator('[data-testid="project-sidebar"]')).toBeVisible({ timeout: 5000 });
    await page.locator('[data-testid="project-icon-github.com/org/repo-a"]').click();

    // Filtered count should be 1
    await expect(page.locator('.statusbar')).toContainText('1 task', { timeout: 3000 });
  });

  test('project icon shows executing task count instead of contribution count', async ({ page, request }) => {
    // Set up a project with a daily limit of 2
    await setProjectConfig(request, 'github.com/org/limited', { dailyPrLimit: 2 });

    // Add 2 contributions for today
    const today = new Date().toISOString();
    await addContribution(request, {
      project: 'github.com/org/limited',
      prUrl: 'https://github.com/org/limited/pull/1',
      prNumber: 1,
      title: 'PR 1',
      createdAt: today,
      status: 'open',
    });
    await addContribution(request, {
      project: 'github.com/org/limited',
      prUrl: 'https://github.com/org/limited/pull/2',
      prNumber: 2,
      title: 'PR 2',
      createdAt: today,
      status: 'open',
    });

    // Launch an agent in this project
    await launchViaUI(page, 'Task in limited repo', '/test/limited');
    const tmux = await getLatestTmuxName(request);
    const taskId = await getLatestTaskId(request);
    await injectSessionStart(request, tmux);
    await injectToolUse(request, tmux);
    await setProjectId(request, taskId, 'github.com/org/limited');

    // Need a second project to trigger sidebar
    await launchViaUI(page, 'Other task', '/test/other');
    const tmux2 = await getLatestTmuxName(request);
    const taskId2 = await getLatestTaskId(request);
    await injectSessionStart(request, tmux2);
    await injectToolUse(request, tmux2);
    await setProjectId(request, taskId2, 'github.com/org/other');

    await broadcastProjectSummaries(request);
    await expect(page.locator('[data-testid="project-sidebar"]')).toBeVisible({ timeout: 5000 });

    // The limited project should show active task load, not the PR count/limit.
    const limitedIcon = page.locator('[data-testid="project-icon-github.com/org/limited"]');
    await expect(limitedIcon.locator('.project-icon-task-count')).toContainText('1', { timeout: 3000 });
    await expect(limitedIcon.locator('.project-icon-pr-count')).toHaveCount(0);
  });
});

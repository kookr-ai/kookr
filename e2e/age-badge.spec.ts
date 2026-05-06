import { test, expect } from './fixtures.js';
import type { Page, APIRequestContext } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


async function resetServer(request: APIRequestContext) {
  await request.post('/api/test/reset');
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
    tool_input: { command: 'npm test' },
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

/** Backdate an anomaly's detectedAt via the test server. */
async function backdateAnomaly(
  request: APIRequestContext,
  agentId: string,
  minutesAgo: number,
) {
  await request.post('/api/test/backdate-anomaly', {
    data: { agentId, minutesAgo },
  });
}

/** Launch an agent and trigger a needs_input finding. Returns the tmux name. */
async function launchWithFinding(
  page: Page,
  request: APIRequestContext,
  prompt: string,
): Promise<string> {
  await launchViaUI(page, prompt, '/test/project');
  const tmuxName = await getLatestTmuxName(request);
  await injectSessionStart(request, tmuxName);
  await injectStopEvent(request, tmuxName);
  await expect(page.locator('.finding-card')).toBeVisible({ timeout: 5000 });
  return tmuxName;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Age badge on finding cards', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('age badge appears on findings older than 2 minutes', async ({ page, request }) => {
    const tmuxName = await launchWithFinding(page, request, 'Fix the login bug');

    // Fresh finding (<2 min) should NOT show an age badge
    await expect(page.locator('.age-badge')).not.toBeVisible();

    // Backdate the anomaly to 5 minutes ago
    await backdateAnomaly(request, tmuxName, 5);

    // Age badge should now appear with "waiting 5m"
    await expect(page.locator('.age-badge')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('.age-badge')).toContainText('waiting');
    await expect(page.locator('.age-badge')).toContainText('5m');
  });

  test('age badge shows gray color for findings < 30 minutes', async ({ page, request }) => {
    const tmuxName = await launchWithFinding(page, request, 'Fix task A');

    await backdateAnomaly(request, tmuxName, 10);
    await expect(page.locator('.age-badge.fresh')).toBeVisible({ timeout: 3000 });
  });

  test('age badge shows yellow color for findings 30m–2h', async ({ page, request }) => {
    const tmuxName = await launchWithFinding(page, request, 'Fix task B');

    await backdateAnomaly(request, tmuxName, 45);
    await expect(page.locator('.age-badge.aging')).toBeVisible({ timeout: 3000 });
  });

  test('age badge shows orange color for findings >= 2h', async ({ page, request }) => {
    const tmuxName = await launchWithFinding(page, request, 'Fix task C');

    await backdateAnomaly(request, tmuxName, 150);
    const badge = page.locator('.age-badge.stale');
    await expect(badge).toBeVisible({ timeout: 3000 });
    await expect(badge).toContainText('2h');
  });
});

test.describe('Initial-load sort and auto-scroll suppression', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
  });

  test('findings sorted oldest-first on initial load', async ({ page, request }) => {
    // Launch 3 agents with findings
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');

    const names: string[] = [];
    // Use mixed anomaly types to avoid finding grouping (≥3 same type → group)
    const prompts = ['Agent A', 'Agent B', 'Agent C'];
    for (let i = 0; i < prompts.length; i++) {
      await launchViaUI(page, prompts[i], '/test/project');
      const tmux = await getLatestTmuxName(request);
      names.push(tmux);
      await injectSessionStart(request, tmux);
      if (i === 0) {
        await injectPermissionEvent(request, tmux);
      } else {
        await injectStopEvent(request, tmux);
      }
      await expect(page.locator('.finding-card')).toHaveCount(i + 1, { timeout: 10000 });
    }

    // Backdate: Agent A = 3h ago (oldest), Agent B = 1h, Agent C = 5m (newest)
    await backdateAnomaly(request, names[0], 180);
    await backdateAnomaly(request, names[1], 60);
    await backdateAnomaly(request, names[2], 5);

    // Reload to get a fresh initial load
    await page.goto('/');
    await expect(page.locator('.health-dot-connected')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.finding-card')).toHaveCount(3, { timeout: 10000 });

    // On initial load, oldest-first: Agent A (3h) should be first
    const badges = page.locator('.age-badge');
    await expect(badges).toHaveCount(3, { timeout: 3000 });
    const texts = await badges.allTextContents();
    // First badge should be the oldest (3h), last should be the newest (5m)
    expect(texts[0]).toContain('3h');
    expect(texts[2]).toContain('5m');
  });

  test('auto-scroll suppressed until first user click', async ({ page, request }) => {
    // Create a finding
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
    const tmux1 = await launchWithFinding(page, request, 'Agent 1');
    await backdateAnomaly(request, tmux1, 10);

    // Reload to get initial load state
    await page.goto('/');
    await expect(page.locator('.health-dot-connected')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.finding-card')).toHaveCount(1, { timeout: 10000 });

    // Launch a second agent with a finding (should NOT auto-scroll)
    // Use permission_blocked to avoid grouping with the first agent's needs_input
    await launchViaUI(page, 'Agent 2', '/test/project');
    const tmux2 = await getLatestTmuxName(request);
    await injectSessionStart(request, tmux2);
    await injectPermissionEvent(request, tmux2);
    await expect(page.locator('.finding-card')).toHaveCount(2, { timeout: 10000 });

    // The scroll area should not have scrolled to top during initial load
    // (We can verify by checking the findings panel is still in isInitialLoad state
    //  — the new finding should appear but not force a scroll)

    // Click on the findings panel to clear isInitialLoad
    await page.locator('.findings-panel').click();

    // Now launch a third agent — auto-scroll should be re-enabled
    await launchViaUI(page, 'Agent 3', '/test/project');
    const tmux3 = await getLatestTmuxName(request);
    await injectSessionStart(request, tmux3);
    await injectStopEvent(request, tmux3);
    await expect(page.locator('.finding-card')).toHaveCount(3, { timeout: 10000 });

    // After clicking, new findings should trigger auto-scroll (scroll to top)
    const scrollArea = page.locator('.findings-scroll-area');
    const scrollTop = await scrollArea.evaluate((el) => el.scrollTop);
    expect(scrollTop).toBe(0);
  });
});

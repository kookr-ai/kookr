import { test, expect } from './fixtures.js';
import type { Page, APIRequestContext } from '@playwright/test';


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

/** Set pane content on FakeTerminalManager (what captureDisplay reads). */
async function setPaneContent(request: APIRequestContext, tmuxName: string, content: string) {
  await request.post('/api/test/set-pane-content', {
    data: { tmuxName, content },
  });
}

/** Permission prompt pane content matching real Claude Code output. */
const PERMISSION_PANE = `● Bash(npm install lodash)
  ⎿  Running…

─────────────────────────────────────────────────────
 Bash command

   npm install lodash
   Install lodash

 Do you want to proceed?
 ❯ 1. Yes
   2. No

 Esc to cancel · Tab to amend · ctrl+e to explain
`;

/** Set up an agent with permission_blocked anomaly and pane content. */
async function setupPermissionBlockedAgent(
  page: Page,
  request: APIRequestContext,
  prompt: string,
): Promise<string> {
  await launchViaUI(page, prompt, '/test/project');
  const tmuxName = await getLatestTmuxName(request);
  await injectSessionStart(request, tmuxName);

  // Set pane content BEFORE injecting permission event (pipeline captures on event)
  await setPaneContent(request, tmuxName, PERMISSION_PANE);

  // Inject permission request — triggers permission_blocked anomaly + pane capture
  await injectEvent(request, tmuxName, {
    session_id: `sess-${Date.now()}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/test/project',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'npm install lodash' },
    permission_mode: 'default',
  });

  // Wait for finding card and click to select the agent
  await expect(page.locator('.finding-card')).toBeVisible({ timeout: 5000 });
  await page.locator('.finding-card').click();

  return tmuxName;
}

test.describe('Permission buttons', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('permission buttons appear when agent is permission_blocked', async ({ page, request }) => {
    await setupPermissionBlockedAgent(page, request, 'Install dependencies');

    // Permission buttons should appear with amber styling
    const permButtons = page.locator('.btn-quick-action.permission-action');
    await expect(permButtons.first()).toBeVisible({ timeout: 5000 });

    // Should have exactly 2 buttons (Yes / No)
    await expect(permButtons).toHaveCount(2);

    // First button should be the "Allow" action
    await expect(permButtons.first()).toContainText('Allow');
    // Last button should be "Deny"
    await expect(permButtons.last()).toContainText('Deny');
  });

  test('clicking a permission button sends keystroke and clears anomaly', async ({ page, request }) => {
    const tmuxName = await setupPermissionBlockedAgent(page, request, 'Run tests');

    // Wait for permission buttons
    const permButtons = page.locator('.btn-quick-action.permission-action');
    await expect(permButtons.first()).toBeVisible({ timeout: 5000 });

    // Verify permission_blocked badge is shown
    await expect(page.locator('.detail-badge.permission')).toBeVisible();

    // Click "Allow" (first button, keystroke '1')
    await permButtons.first().click();

    // Verify keystroke was sent via sendKeystroke (not sendKeys)
    const ksRes = await request.get('/api/test/last-keystroke');
    const ksData = await ksRes.json();
    expect(ksData.lastKeystroke).toEqual({ name: tmuxName, key: '1' });

    // Permission badge should be gone (anomaly cleared)
    await expect(page.locator('.detail-badge.permission')).not.toBeVisible({ timeout: 3000 });
  });

  test('permission buttons disappear after clicking', async ({ page, request }) => {
    await setupPermissionBlockedAgent(page, request, 'Build project');

    const permButtons = page.locator('.btn-quick-action.permission-action');
    await expect(permButtons.first()).toBeVisible({ timeout: 5000 });

    // Click first button
    await permButtons.first().click();

    // Buttons should disappear (suggestions cleared after click)
    await expect(permButtons).toHaveCount(0, { timeout: 3000 });
  });
});

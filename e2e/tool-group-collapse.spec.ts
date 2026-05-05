/**
 * E2E tests for tool group collapse behavior in the activity panel.
 * Tool groups should always render collapsed by default, regardless of errors.
 */
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

async function injectToolUse(
  request: APIRequestContext,
  tmuxName: string,
  toolName: string,
  toolInput?: Record<string, unknown>,
) {
  await injectEvent(request, tmuxName, {
    session_id: `sess-${Date.now()}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/test/project',
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
  });
}

async function injectToolError(
  request: APIRequestContext,
  tmuxName: string,
  toolName: string,
  toolInput?: Record<string, unknown>,
) {
  await injectEvent(request, tmuxName, {
    session_id: `sess-${Date.now()}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/test/project',
    hook_event_name: 'PostToolUseFailure',
    tool_name: toolName,
    tool_input: toolInput,
    error: 'Command failed',
  });
}

async function injectStopEvent(request: APIRequestContext, tmuxName: string) {
  await injectEvent(request, tmuxName, {
    session_id: `sess-${Date.now()}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/test/project',
    hook_event_name: 'Stop',
    stop_hook_active: true,
    last_assistant_message: 'Done.',
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Tool group collapse behavior', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('tool group without errors renders collapsed', async ({ page, request }) => {
    await launchViaUI(page, 'Collapse test', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);

    // Inject several tool_use events (no errors)
    await injectToolUse(request, tmuxName, 'Read', { file_path: '/test/foo.ts' });
    await injectToolUse(request, tmuxName, 'Read', { file_path: '/test/bar.ts' });
    await injectToolUse(request, tmuxName, 'Edit', { file_path: '/test/foo.ts' });

    // Inject a stop so a finding appears and the activity panel is visible
    await injectStopEvent(request, tmuxName);

    // Select the finding to see the activity panel
    await page.locator('.finding-card').click();

    // Tool group summary line should be visible
    await expect(page.locator('.act-tool-summary-line')).toBeVisible();

    // Tool entries (the expanded detail) should NOT be visible — collapsed by default
    await expect(page.locator('.act-tool-entries')).not.toBeVisible();

    // Chevron should not have the 'expanded' class
    await expect(page.locator('.act-tool-chevron')).not.toHaveClass(/expanded/);
  });

  test('tool group with errors renders collapsed', async ({ page, request }) => {
    await launchViaUI(page, 'Error collapse test', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);

    // Inject a tool_use then a tool_error for the same tool
    await injectToolUse(request, tmuxName, 'Bash', { command: 'npm test' });
    await injectToolError(request, tmuxName, 'Bash', { command: 'npm test' });

    await injectStopEvent(request, tmuxName);
    await page.locator('.finding-card').click();

    // The tool group should exist with an error pill
    await expect(page.locator('.act-error-pill')).toBeVisible();

    // But still collapsed — no expanded entries
    await expect(page.locator('.act-tool-entries')).not.toBeVisible();
    await expect(page.locator('.act-tool-chevron')).not.toHaveClass(/expanded/);
  });

  test('clicking collapsed tool group expands it to show entries', async ({ page, request }) => {
    await launchViaUI(page, 'Expand test', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);

    await injectToolUse(request, tmuxName, 'Read', { file_path: '/test/main.ts' });
    await injectToolUse(request, tmuxName, 'Bash', { command: 'ls -la' });

    await injectStopEvent(request, tmuxName);
    await page.locator('.finding-card').click();

    // Starts collapsed
    await expect(page.locator('.act-tool-entries')).not.toBeVisible();

    // Click to expand
    await page.locator('.act-tool-summary-line').click();

    // Now entries should be visible
    await expect(page.locator('.act-tool-entries')).toBeVisible();
    await expect(page.locator('.act-tool-chevron')).toHaveClass(/expanded/);

    // Individual tool entries should be visible
    await expect(page.locator('.act-tool-entry')).toHaveCount(2);
  });

  test('clicking expanded tool group collapses it', async ({ page, request }) => {
    await launchViaUI(page, 'Re-collapse test', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);

    await injectToolUse(request, tmuxName, 'Grep', { pattern: 'TODO' });
    await injectStopEvent(request, tmuxName);
    await page.locator('.finding-card').click();

    // Click once to expand
    await page.locator('.act-tool-summary-line').click();
    await expect(page.locator('.act-tool-entries')).toBeVisible();

    // Click again to collapse
    await page.locator('.act-tool-summary-line').click();
    await expect(page.locator('.act-tool-entries')).not.toBeVisible();
    await expect(page.locator('.act-tool-chevron')).not.toHaveClass(/expanded/);
  });

  test('multiple tool groups all render collapsed', async ({ page, request }) => {
    await launchViaUI(page, 'Multi-group test', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);

    // First tool group — inject some tools then an agent message to flush
    await injectToolUse(request, tmuxName, 'Read', { file_path: '/test/a.ts' });
    await injectToolUse(request, tmuxName, 'Edit', { file_path: '/test/a.ts' });

    // User message between groups forces a flush
    await injectEvent(request, tmuxName, {
      session_id: `sess-${Date.now()}`,
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/test/project',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'continue',
    });

    // Second tool group with errors
    await injectToolUse(request, tmuxName, 'Bash', { command: 'npm test' });
    await injectToolError(request, tmuxName, 'Bash', { command: 'npm test' });

    await injectStopEvent(request, tmuxName);
    await page.locator('.finding-card').click();

    // Both tool groups should be present
    const groups = page.locator('.act-tool-group');
    await expect(groups).toHaveCount(2);

    // Neither should have expanded entries
    await expect(page.locator('.act-tool-entries')).not.toBeVisible();

    // All chevrons should be collapsed
    const chevrons = page.locator('.act-tool-chevron');
    const count = await chevrons.count();
    for (let i = 0; i < count; i++) {
      await expect(chevrons.nth(i)).not.toHaveClass(/expanded/);
    }
  });
});

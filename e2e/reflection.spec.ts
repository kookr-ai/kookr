import { test, expect } from './fixtures.js';
import type { Page, APIRequestContext } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


async function resetServer(request: APIRequestContext) {
  await request.post('/api/test/reset');
}

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
  const expectedTaskCount = await currentTaskCount(page) + 1;
  await page.locator('.btn-launch').click();
  await page.locator('.dialog textarea').fill(prompt);
  const cwdInput = page.locator('.dialog input[type="text"]').first();
  await cwdInput.clear();
  await cwdInput.fill(cwd);
  await page.locator('.dialog .btn-primary').click();
  await expect(page.locator('.dialog')).not.toBeVisible();
  await expect(page.locator('.statusbar')).toContainText(`${expectedTaskCount} task`, { timeout: 5000 });
}

async function currentTaskCount(page: Page): Promise<number> {
  const status = await page.locator('.statusbar').textContent();
  const match = status?.match(/(\d+)\s+tasks?/);
  return match ? Number(match[1]) : 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Pure API tests — no browser context needed
test.describe('Session Reflection — pure API', () => {
  test.beforeEach(async ({ request }) => {
    await resetServer(request);
  });

  test('reflect API returns report with expected structure', async ({ request }) => {
    const res = await request.get('/api/reflect');
    const report = await res.json();

    // Report should have the expected structure
    expect(report).toHaveProperty('sessionStart');
    expect(report).toHaveProperty('sessionEnd');
    expect(report).toHaveProperty('agentCount');
    expect(report).toHaveProperty('totalInterventions');
    expect(report).toHaveProperty('anomalyBreakdown');
    expect(report).toHaveProperty('findings');
    expect(Array.isArray(report.findings)).toBe(true);
  });
});

// UI + API tests — require browser context
test.describe('Session Reflection — API', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('reflect API returns report after user interactions', async ({ page, request }) => {
    // Launch an agent and trigger an anomaly
    await launchViaUI(page, 'Fix auth module', '/test/project');
    const tmuxName = await getLatestTmuxName(request);

    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    // Wait for finding to appear and respond to it
    await expect(page.locator('.finding-card')).toBeVisible();
    await page.locator('.finding-card').click();
    await page.locator('.response-row input').fill('Try running vitest');
    await page.locator('.btn-primary:has-text("Send & Next")').click();

    // Wait for the response to be processed
    await expect(page.locator('.sent-overlay')).toBeVisible();

    // Now check the reflect API
    const res = await request.get('/api/reflect');
    const report = await res.json();

    expect(report.totalInterventions).toBeGreaterThanOrEqual(1);
    // The report should have session timing
    expect(report.sessionStart).toBeTruthy();
    expect(report.sessionEnd).toBeTruthy();
  });

  test('reflect API detects repeated inputs across agents', async ({ page, request }) => {
    // Launch two agents
    await launchViaUI(page, 'Agent A task', '/test/a');
    const tmuxA = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxA);
    await injectStopEvent(request, tmuxA);

    await launchViaUI(page, 'Agent B task', '/test/b');
    const tmuxB = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxB);
    await injectStopEvent(request, tmuxB);

    // Send the same message to both agents via the detail panel response input
    await expect(page.locator('.finding-card')).toHaveCount(2);

    // Click first finding card and respond via detail panel
    await page.locator('.finding-card').first().click();
    await page.locator('.response-row input').fill('run tests');
    await page.locator('.btn-primary:has-text("Send & Next")').click();

    // Wait briefly for first response to process
    await page.waitForTimeout(300);

    // Second finding card is now selected after advance; respond again
    await page.locator('.response-row input').fill('run tests');
    await page.locator('.btn-primary:has-text("Send & Next")').click();

    // Check reflection
    const res = await request.get('/api/reflect');
    const report = await res.json();

    expect(report.totalInterventions).toBeGreaterThanOrEqual(2);
    // Should detect "Repeated input" pattern
    const repeatedFindings = report.findings.filter(
      (f: { name: string }) => f.name === 'Repeated input',
    );
    expect(repeatedFindings.length).toBeGreaterThanOrEqual(1);
  });

  test('reflect API detects skipped findings', async ({ page, request }) => {
    // Launch agents — use mixed anomaly types to avoid finding grouping (≥3 same type)
    for (let i = 0; i < 4; i++) {
      await launchViaUI(page, `Task ${i}`, `/test/p${i}`);
      const tmux = await getLatestTmuxName(request);
      await injectSessionStart(request, tmux);
      if (i % 2 === 0) {
        await injectStopEvent(request, tmux);
      } else {
        await injectPermissionEvent(request, tmux);
      }
      await expect(page.locator('.finding-card')).toHaveCount(i + 1, { timeout: 10000 });
    }

    // Skip all 4 findings rapidly via the findings panel Skip buttons
    const skipBtns = page.locator('.finding-actions .btn-xs:has-text("Skip")');
    for (let i = 0; i < 4; i++) {
      await skipBtns.first().click();
      // Small delay to let the UI update
      await page.waitForTimeout(100);
    }

    const res = await request.get('/api/reflect');
    const report = await res.json();

    // Should have skip events logged
    const skipFindings = report.findings.filter(
      (f: { name: string }) => f.name === 'Rapid skip cycle' || f.name === 'Always-skipped anomaly type',
    );
    expect(skipFindings.length).toBeGreaterThanOrEqual(1);
  });

  test('interaction log captures launch events', async ({ page, request }) => {
    await launchViaUI(page, 'Test task for logging', '/test/project');

    // Give it a moment for the log to be written
    await page.waitForTimeout(200);

    const res = await request.get('/api/reflect');
    const report = await res.json();

    // The session should show at least one agent
    expect(report.agentCount).toBeGreaterThanOrEqual(1);
  });
});

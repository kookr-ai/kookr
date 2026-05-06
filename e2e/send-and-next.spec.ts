/**
 * E2E tests for "Send & Next" input delivery — validates that clicking
 * "Send & Next" both delivers the input to the agent's terminal AND
 * advances the selection to the next finding.
 *
 * Regression guard for the bug where Send & Next showed the sent overlay
 * and navigated to the next agent, but the input was never actually
 * delivered to the original agent.
 */
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
    last_assistant_message: 'I need your help to proceed.',
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

/** Get the keys received by a fake terminal session. */
async function getKeysReceived(request: APIRequestContext, tmuxName: string): Promise<string[]> {
  const res = await request.get(`/api/test/keys-received/${tmuxName}`);
  const data = await res.json();
  return data.keysReceived;
}

// ---------------------------------------------------------------------------
// Send & Next — input delivery tests
// ---------------------------------------------------------------------------

test.describe('Send & Next — input delivery', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('Send & Next delivers input to the agent AND advances to the next finding', async ({ page, request }) => {
    // Launch two agents, both with needs_input anomalies
    await launchViaUI(page, 'Agent Alpha', '/test/alpha');
    const tmuxA = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxA);
    await injectStopEvent(request, tmuxA);

    await launchViaUI(page, 'Agent Beta', '/test/beta');
    const tmuxB = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxB);
    await injectStopEvent(request, tmuxB);

    await expect(page.locator('.finding-card')).toHaveCount(2);

    // Select the first finding
    await page.keyboard.press('Alt+n');
    const firstFinding = await page.locator('.finding-card.selected .finding-task').textContent();

    // Type text and click "Send & Next"
    const inputText = 'Try using the helper function instead';
    await page.locator('.response-row input').fill(inputText);
    await page.locator('.btn-primary:has-text("Send & Next")').click();

    // Sent overlay should appear
    await expect(page.locator('.sent-overlay')).toBeVisible();

    // Selection should advance to the other finding
    const secondFinding = await page.locator('.finding-card.selected .finding-task').textContent();
    expect(secondFinding).not.toBe(firstFinding);

    // CRITICAL: Verify the input was actually delivered to the agent's terminal
    // Wait briefly for the WS message to be processed by the backend
    await expect(async () => {
      const keys = await getKeysReceived(request, tmuxA);
      expect(keys).toContain(inputText);
    }).toPass({ timeout: 3000 });
  });

  test('Send & Next via Enter key delivers input to the agent', async ({ page, request }) => {
    // Launch two agents with anomalies
    await launchViaUI(page, 'Enter Key Alpha', '/test/alpha');
    const tmuxA = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxA);
    await injectStopEvent(request, tmuxA);

    await launchViaUI(page, 'Enter Key Beta', '/test/beta');
    const tmuxB = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxB);
    await injectStopEvent(request, tmuxB);

    await expect(page.locator('.finding-card')).toHaveCount(2);

    // Select first finding and type
    await page.keyboard.press('Alt+n');
    const inputText = 'Check the database connection settings';
    await page.locator('.response-row input').fill(inputText);

    // Press Enter (keyboard shortcut for Send & Next)
    await page.locator('.response-row input').press('Enter');

    // Verify overlay and advancement
    await expect(page.locator('.sent-overlay')).toBeVisible();

    // CRITICAL: Verify the input was delivered
    await expect(async () => {
      const keys = await getKeysReceived(request, tmuxA);
      expect(keys).toContain(inputText);
    }).toPass({ timeout: 3000 });
  });

  test('Send & Next clears the anomaly for the responded agent', async ({ page, request }) => {
    // Launch two agents with anomalies
    await launchViaUI(page, 'Clear Alpha', '/test/alpha');
    const tmuxA = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxA);
    await injectStopEvent(request, tmuxA);

    await launchViaUI(page, 'Clear Beta', '/test/beta');
    const tmuxB = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxB);
    await injectStopEvent(request, tmuxB);

    await expect(page.locator('.finding-card')).toHaveCount(2);

    // Select first finding, note which agent it is
    await page.keyboard.press('Alt+n');
    const firstAgentName = await page.locator('.finding-card.selected .finding-task').textContent();

    // Send response
    await page.locator('.response-row input').fill('Fix applied');
    await page.locator('.btn-primary:has-text("Send & Next")').click();

    // After the response is processed, the first agent's finding should be gone
    // (only one finding card should remain)
    await expect(page.locator('.finding-card')).toHaveCount(1, { timeout: 5000 });

    // The remaining finding should be the OTHER agent (not the one we responded to)
    const remainingAgent = await page.locator('.finding-card .finding-task').textContent();
    expect(remainingAgent).not.toBe(firstAgentName);
  });

  test('Send & Next with single finding delivers input and clears selection', async ({ page, request }) => {
    // Launch one agent with anomaly
    await launchViaUI(page, 'Solo Agent', '/test/solo');
    const tmux = await getLatestTmuxName(request);
    await injectSessionStart(request, tmux);
    await injectStopEvent(request, tmux);

    await expect(page.locator('.finding-card')).toHaveCount(1);

    // Select the finding
    await page.locator('.finding-card').click();
    await expect(page.locator('.detail-badge')).toContainText('NEEDS INPUT');

    // Type and send
    const inputText = 'Continue with the refactoring';
    await page.locator('.response-row input').fill(inputText);
    await page.locator('.btn-primary:has-text("Send & Next")').click();

    // Verify input was delivered
    await expect(async () => {
      const keys = await getKeysReceived(request, tmux);
      expect(keys).toContain(inputText);
    }).toPass({ timeout: 3000 });

    // Finding should be cleared (no more finding cards)
    await expect(page.locator('.finding-card')).toHaveCount(0, { timeout: 5000 });
  });

  test('Send & Next with closed WebSocket does NOT advance or clear input', async ({ page, request }) => {
    // Launch an agent with anomaly
    await launchViaUI(page, 'Disconnected Agent', '/test/project');
    const tmux = await getLatestTmuxName(request);
    await injectSessionStart(request, tmux);
    await injectStopEvent(request, tmux);

    await expect(page.locator('.finding-card')).toHaveCount(1);
    await page.locator('.finding-card').click();
    await expect(page.locator('.detail-badge')).toContainText('NEEDS INPUT');

    // Type text into the input
    const inputText = 'This should not be lost';
    await page.locator('.response-row input').fill(inputText);

    // Close the WebSocket to simulate a disconnection
    await page.evaluate(() => {
      // Access the WebSocket from the page context and close it
      // We need to close all WebSocket connections
      const originalWS = window.WebSocket;
      // Find active WebSocket connections by iterating global objects
      // The useWebSocket hook stores ws in a ref, but we can close it via the prototype
      const sockets: WebSocket[] = [];
      const origSend = originalWS.prototype.send;
      // Monkey-patch to prevent reconnection from sending
      originalWS.prototype.send = function() { /* no-op */ };
      // Close existing connections by dispatching close event
      document.querySelectorAll('*'); // force layout
      // Direct approach: find and close WS connections
      (window as any).__testCloseWS = true;
    });

    // Force close WebSocket by blocking the connection server-side isn't practical
    // Instead, use page.evaluate to close the actual WebSocket instance
    await page.evaluate(() => {
      // The WebSocket is stored in a ref inside the React component tree.
      // We can find it by looking at the performance entries or just close all WSes.
      // Simpler approach: override WebSocket.prototype.send to be a no-op
      const proto = WebSocket.prototype;
      Object.defineProperty(proto, 'readyState', {
        get: function() { return WebSocket.CLOSED; },
        configurable: true,
      });
    });

    // Now click "Send & Next" — the send should fail (WS appears closed)
    await page.locator('.btn-primary:has-text("Send & Next")').click();

    // The input should still contain the text (not cleared)
    await expect(page.locator('.response-row input')).toHaveValue(inputText);

    // The sent overlay should NOT appear
    await expect(page.locator('.sent-overlay')).not.toBeVisible();

    // An error toast/alert should appear. Scope to .toast-error so the
    // locator stays unique even if other (info) toasts are rendered
    // concurrently. See #57.
    await expect(page.locator('.toast-error')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('.toast-error')).toContainText('connection lost');

    // The selection should NOT have advanced (still on the same finding)
    await expect(page.locator('.detail-badge')).toContainText('NEEDS INPUT');

    // The input was NOT delivered to the terminal
    const keys = await getKeysReceived(request, tmux);
    expect(keys).toHaveLength(0);
  });
});

/**
 * E2E tests for input stability — verifies that the response input does NOT
 * automatically send its contents when external state changes occur.
 *
 * Regression guard for a bug where the response input's message was
 * "published automatically" when state changes occurred (new findings, etc.).
 */
import { test, expect } from './fixtures.js';
import { resetServer } from './reset-server.js';
import type { Page, APIRequestContext } from '@playwright/test';

async function getTmuxNameForPrompt(request: APIRequestContext, prompt: string): Promise<string> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const res = await request.get('/api/tasks');
    const tasks = (await res.json()) as Array<{
      prompt: string;
      status: string;
      sessions: Array<{ tmuxSession: string }>;
    }>;
    const task = [...tasks].reverse().find((t) => t.prompt === prompt && t.status === 'inProgress');
    const sessions = task?.sessions;
    if (sessions && sessions.length > 0) {
      return sessions[sessions.length - 1].tmuxSession;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for task "${prompt}" with sessions`);
}

async function injectEvent(request: APIRequestContext, tmuxName: string, event: Record<string, unknown>) {
  await request.post('/api/test/inject-event', { data: { tmuxName, event } });
}

async function injectSessionStart(request: APIRequestContext, tmuxName: string) {
  await injectEvent(request, tmuxName, {
    session_id: `sess-${Date.now()}`, transcript_path: '/tmp/transcript.jsonl',
    cwd: '/test/project', hook_event_name: 'SessionStart',
  });
}

async function injectStopEvent(request: APIRequestContext, tmuxName: string, message = 'I need your help.') {
  await injectEvent(request, tmuxName, {
    session_id: `sess-${Date.now()}`, transcript_path: '/tmp/transcript.jsonl',
    cwd: '/test/project', hook_event_name: 'Stop',
    stop_hook_active: true, last_assistant_message: message,
  });
}

async function injectToolUse(request: APIRequestContext, tmuxName: string) {
  await injectEvent(request, tmuxName, {
    session_id: `sess-${Date.now()}`, transcript_path: '/tmp/transcript.jsonl',
    cwd: '/test/project', hook_event_name: 'PreToolUse', tool_name: 'Read',
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

async function getKeysReceived(request: APIRequestContext, tmuxName: string): Promise<string[]> {
  const res = await request.get(`/api/test/keys-received/${tmuxName}`);
  return (await res.json()).keysReceived;
}

async function broadcastSuggestion(
  request: APIRequestContext, agentId: string,
  suggestions: string[], quickActions: Array<{ label: string; value: string }>,
) {
  await request.post('/api/test/broadcast-suggestion', {
    data: { agentId, suggestions, quickActions },
  });
}

test.describe('Input stability — no auto-send on state changes', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('autocomplete is disabled on response input', async ({ page, request }) => {
    await launchViaUI(page, 'AC Test', '/test/ac');
    const tmux = await getTmuxNameForPrompt(request, 'AC Test');
    await injectSessionStart(request, tmux);
    await injectStopEvent(request, tmux);
    await page.locator('.finding-card').click();
    await expect(page.locator('.response-row input')).toHaveAttribute('autocomplete', 'off');
  });

  test('input preserved when suggestions arrive', async ({ page, request }) => {
    await launchViaUI(page, 'Sugg Agent', '/test/sugg');
    const tmux = await getTmuxNameForPrompt(request, 'Sugg Agent');
    await injectSessionStart(request, tmux);
    await injectStopEvent(request, tmux);
    await page.locator('.finding-card').click();

    const userText = 'My carefully composed response';
    await page.locator('.response-row input').fill(userText);

    await broadcastSuggestion(request, tmux, ['Try the logs'], [
      { label: 'Check logs', value: 'Check logs' },
    ]);
    await expect(page.locator('.btn-quick-action').first()).toBeVisible({ timeout: 3000 });

    await expect(page.locator('.response-row input')).toHaveValue(userText);
    await expect(page.locator('.sent-overlay')).not.toBeVisible();
    expect(await getKeysReceived(request, tmux)).not.toContain(userText);
  });

  test('input preserved when suggestions disappear', async ({ page, request }) => {
    await launchViaUI(page, 'Dis Agent', '/test/dis');
    const tmux = await getTmuxNameForPrompt(request, 'Dis Agent');
    await injectSessionStart(request, tmux);
    await injectStopEvent(request, tmux, 'Should I continue with the next step?');
    await page.locator('.finding-card').click();

    await expect(page.locator('.btn-quick-action').first()).toBeVisible({ timeout: 3000 });

    const userText = 'Half-finished thought';
    await page.locator('.response-row input').fill(userText);

    await broadcastSuggestion(request, tmux, [], []);
    await expect(page.locator('.btn-quick-action')).toHaveCount(0, { timeout: 3000 });

    await expect(page.locator('.response-row input')).toHaveValue(userText);
    await expect(page.locator('.sent-overlay')).not.toBeVisible();
  });

  test('input preserved when anomaly clears externally', async ({ page, request }) => {
    await launchViaUI(page, 'Clear Agent', '/test/clear');
    const tmux = await getTmuxNameForPrompt(request, 'Clear Agent');
    await injectSessionStart(request, tmux);
    await injectStopEvent(request, tmux);
    await page.locator('.finding-card').click();

    const userText = 'Check the database';
    await page.locator('.response-row input').fill(userText);

    await injectToolUse(request, tmux);
    await expect(page.locator('.finding-card')).toHaveCount(0, { timeout: 10000 });

    await expect(page.locator('.response-row input')).toHaveValue(userText);
    await expect(page.locator('.sent-overlay')).not.toBeVisible();
    expect(await getKeysReceived(request, tmux)).not.toContain(userText);
  });

  test('input cleared when switching agents (finding → healthy)', async ({ page, request }) => {
    // Use finding + healthy agent (only 1 stop event) instead of 2 findings
    await launchViaUI(page, 'Finding Agent', '/test/finding');
    const tmux1 = await getTmuxNameForPrompt(request, 'Finding Agent');
    await injectSessionStart(request, tmux1);
    await injectStopEvent(request, tmux1);

    await launchViaUI(page, 'Healthy Agent', '/test/healthy');
    const tmux2 = await getTmuxNameForPrompt(request, 'Healthy Agent');
    await injectSessionStart(request, tmux2);
    await injectToolUse(request, tmux2); // healthy, no anomaly

    await expect(page.locator('.finding-card')).toHaveCount(1);

    // Type on finding agent
    await page.locator('.finding-card').click();
    await page.locator('.response-row input').fill('Message for finding');
    await expect(page.locator('.response-row input')).toHaveValue('Message for finding');

    // Switch to healthy agent via its row
    await page.locator('.healthy-row').click();

    // Input cleared — stale text not sent to wrong agent
    await expect(page.locator('.response-row input')).toHaveValue('');
    await expect(page.locator('.sent-overlay')).not.toBeVisible();
    expect(await getKeysReceived(request, tmux1)).not.toContain('Message for finding');
    expect(await getKeysReceived(request, tmux2)).not.toContain('Message for finding');
  });

  test('Tab key does not send or skip when response input is focused', async ({ page, request }) => {
    // Only 1 agent needed — Tab behavior is in the global handler
    await launchViaUI(page, 'Tab Agent', '/test/tab');
    const tmux = await getTmuxNameForPrompt(request, 'Tab Agent');
    await injectSessionStart(request, tmux);
    await injectStopEvent(request, tmux);

    await page.locator('.finding-card').click();
    await page.locator('.response-row input').fill('Typing here');
    await expect(page.locator('.response-row input')).toBeFocused();

    await page.keyboard.press('Tab');

    // Text and selection are preserved. Browser focus may move normally, but
    // Kookr must not treat Tab as the global "skip finding" shortcut here.
    await expect(page.locator('.response-row input')).toHaveValue('Typing here');
    await expect(page.locator('.finding-card.selected')).toBeVisible();
    expect(await getKeysReceived(request, tmux)).not.toContain('Typing here');
  });

});

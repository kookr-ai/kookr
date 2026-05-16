/**
 * Shared helpers for the battle-test E2E suite.
 *
 * Extracted from the monolithic battle-test.spec.ts to allow
 * thematic splitting into multiple spec files.
 */
import { expect } from '@playwright/test';
import type { Page, APIRequestContext } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers (same conventions as kookr.spec.ts)
// ---------------------------------------------------------------------------

export async function resetServer(request: APIRequestContext) {
  await request.post('/api/test/reset');
}

/** Polls until an inProgress task with sessions appears (WebSocket launch is async). */
export async function getLatestTmuxName(request: APIRequestContext): Promise<string> {
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

/** Polls until the launched task with the given prompt has an attached session. */
export async function getTmuxNameForPrompt(request: APIRequestContext, prompt: string): Promise<string> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const tasks = await getTasks(request);
    const task = [...tasks].reverse().find((t) => t.prompt === prompt && t.status === 'inProgress');
    const sessions = task?.sessions;
    if (sessions && sessions.length > 0) {
      return sessions[sessions.length - 1].tmuxSession;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for task "${prompt}" with sessions`);
}

export async function getTasks(request: APIRequestContext) {
  const res = await request.get('/api/tasks');
  return (await res.json()) as Array<{
    id: string;
    name?: string;
    prompt: string;
    cwd: string;
    criteria?: string;
    status: string;
    sessions: Array<{ tmuxSession: string; lastStatus?: string }>;
  }>;
}

export async function injectEvent(
  request: APIRequestContext,
  tmuxName: string,
  event: Record<string, unknown>,
) {
  await request.post('/api/test/inject-event', {
    data: { tmuxName, event },
  });
}

export async function injectSessionStart(request: APIRequestContext, tmuxName: string, cwd = '/test/project') {
  await injectEvent(request, tmuxName, {
    session_id: `sess-${Date.now()}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd,
    hook_event_name: 'SessionStart',
  });
}

export async function injectStopEvent(request: APIRequestContext, tmuxName: string, message?: string, cwd = '/test/project') {
  await injectEvent(request, tmuxName, {
    session_id: `sess-${Date.now()}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd,
    hook_event_name: 'Stop',
    stop_hook_active: true,
    last_assistant_message: message ?? 'I need your help.',
  });
}

export async function injectPermissionEvent(request: APIRequestContext, tmuxName: string, toolName?: string) {
  await injectEvent(request, tmuxName, {
    session_id: `sess-${Date.now()}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/test/project',
    hook_event_name: 'PermissionRequest',
    tool_name: toolName ?? 'Bash',
    tool_input: { command: 'npm install' },
    permission_mode: 'default',
  });
}

export async function injectToolUse(
  request: APIRequestContext,
  tmuxName: string,
  toolName = 'Read',
) {
  await injectEvent(request, tmuxName, {
    session_id: `sess-${Date.now()}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/test/project',
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
  });
}

export async function injectPostToolUse(
  request: APIRequestContext,
  tmuxName: string,
  toolName = 'Read',
) {
  await injectEvent(request, tmuxName, {
    session_id: `sess-${Date.now()}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/test/project',
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_response: 'file contents...',
  });
}

/** Inject an Edit tool call (PreToolUse) and its matching PostToolUse with a
 *  ready-made structuredPatch. Used by the activity-panel diff E2E tests. */
export async function injectEditEvent(
  request: APIRequestContext,
  tmuxName: string,
  filePath: string,
  toolUseId: string,
  oldString = 'foo',
  newString = 'bar',
) {
  const sessionId = `sess-${Date.now()}`;
  await injectEvent(request, tmuxName, {
    session_id: sessionId,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/test/project',
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_use_id: toolUseId,
    tool_input: { file_path: filePath, old_string: oldString, new_string: newString },
  });
  await injectEvent(request, tmuxName, {
    session_id: sessionId,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/test/project',
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_use_id: toolUseId,
    tool_input: { file_path: filePath, old_string: oldString, new_string: newString },
    tool_response: {
      filePath,
      oldString,
      newString,
      originalFile: `line 1\n${oldString}\nline 3\n`,
      structuredPatch: [
        {
          oldStart: 2, oldLines: 1, newStart: 2, newLines: 1,
          lines: [`-${oldString}`, `+${newString}`],
        },
      ],
      userModified: false,
      replaceAll: false,
    },
  });
}

/** Inject an agent "stop" event with a message containing markdown. Used by
 *  the activity-panel markdown E2E test. */
export async function injectAgentMessage(
  request: APIRequestContext,
  tmuxName: string,
  message: string,
) {
  await injectEvent(request, tmuxName, {
    session_id: `sess-${Date.now()}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/test/project',
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: message,
  });
}

export async function injectErrorEvent(
  request: APIRequestContext,
  tmuxName: string,
  message: string,
) {
  // Errors come through as tool results with error content
  // Use PostToolUse with a failing result pattern
  await injectEvent(request, tmuxName, {
    session_id: `sess-${Date.now()}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/test/project',
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_response: `Error: ${message}`,
    is_error: true,
  });
}

export async function injectAskUserQuestion(request: APIRequestContext, tmuxName: string) {
  await injectEvent(request, tmuxName, {
    session_id: `sess-${Date.now()}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/test/project',
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: { question: 'Which database should I use?' },
  });
}

export async function launchViaUI(page: Page, prompt: string, cwd: string, criteria?: string) {
  // Ensure WebSocket is connected before launching (CI can be slow to connect)
  await expect(page.locator('.health-dot-connected')).toBeVisible({ timeout: 5000 });
  const expectedTaskCount = await currentTaskCount(page) + 1;
  await page.locator('.btn-launch').click();
  await page.locator('.dialog textarea').fill(prompt);
  const cwdInput = page.locator('.dialog input[type="text"]').first();
  await cwdInput.clear();
  await cwdInput.fill(cwd);
  if (criteria) {
    const criteriaInput = page.locator('.dialog input[type="text"]').nth(1);
    await criteriaInput.fill(criteria);
  }
  await page.locator('.dialog .btn-primary').click();
  await expect(page.locator('.dialog')).not.toBeVisible();
  await waitForAgentCount(page, expectedTaskCount);
}

export async function waitForAgentCount(page: Page, count: number) {
  await expect(page.locator('.statusbar')).toContainText(`${count} task`, { timeout: 5000 });
}

async function currentTaskCount(page: Page): Promise<number> {
  const status = await page.locator('.statusbar').textContent();
  const match = status?.match(/(\d+)\s+tasks?/);
  return match ? Number(match[1]) : 0;
}

export async function waitForFindingCount(page: Page, count: number) {
  await expect(page.locator('.statusbar')).toContainText(`${count} finding`, { timeout: 5000 });
}

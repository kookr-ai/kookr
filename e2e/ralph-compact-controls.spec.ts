import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './fixtures.js';

interface LaunchedTask {
  id: string;
  sessions: Array<{ tmuxSession?: string }>;
}

async function launchRalphTask(request: APIRequestContext, prompt: string, cwd: string): Promise<LaunchedTask> {
  const res = await request.post('/api/tasks/ralph-loop', {
    data: {
      prompt,
      cwd,
      iterationCap: 12,
      autonomy: 'supervised',
    },
  });
  expect(res.ok()).toBe(true);
  return await res.json() as LaunchedTask;
}

async function pauseRalphTask(request: APIRequestContext, taskId: string): Promise<void> {
  const res = await request.post(`/api/tasks/${taskId}/ralph-loop/pause`);
  expect(res.ok()).toBe(true);
}

async function injectNeedsInput(request: APIRequestContext, task: LaunchedTask): Promise<void> {
  const sessionId = await waitForTaskSession(request, task.id);
  const res = await request.post('/api/test/inject-event', {
    data: {
      sessionId,
      event: {
        session_id: `sess-${Date.now()}`,
        transcript_path: '/tmp/ralph-compact-controls.jsonl',
        cwd: '/test/ralph-compact-finding',
        hook_event_name: 'Stop',
        stop_hook_active: true,
        last_assistant_message: 'The compact Ralph control layout needs user guidance.',
      },
    },
  });
  expect(res.ok()).toBe(true);
}

async function waitForTaskSession(request: APIRequestContext, taskId: string): Promise<string> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const res = await request.get('/api/tasks');
    expect(res.ok()).toBe(true);
    const tasks = await res.json() as LaunchedTask[];
    const session = tasks.find((task) => task.id === taskId)?.sessions.at(-1);
    const sessionId = session?.tmuxSession;
    if (sessionId) return sessionId;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for task ${taskId} to have a terminal session`);
}

test('Ralph controls stay inside compact dashboard rows', async ({ page, request }) => {
  await request.post('/api/test/reset');

  const findingTask = await launchRalphTask(
    request,
    'Ralph bootstrap follow-up with a long task name that should still have readable room',
    '/test/ralph-compact-finding',
  );
  await pauseRalphTask(request, findingTask.id);
  await injectNeedsInput(request, findingTask);

  await launchRalphTask(
    request,
    'A very long healthy Ralph loop task name remains visible instead of collapsing',
    '/test/ralph-compact-healthy',
  );

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');

  await expect(page.locator('.finding-card .ralph-loop-controls')).toBeVisible();
  await expect(page.locator('.healthy-row .ralph-loop-controls').first()).toBeVisible();
  await expect(page.locator('.ralph-overview-section')).toHaveCount(0);

  const metrics = await page.evaluate(() => {
    function rect(selector: string): { left: number; right: number; width: number } {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing ${selector}`);
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width };
    }
    function within(childSelector: string, parentSelector: string): boolean {
      const child = rect(childSelector);
      const parent = rect(parentSelector);
      return child.left >= parent.left && child.right <= parent.right;
    }
    function descendantsWithin(parentSelector: string): boolean {
      const parent = document.querySelector(parentSelector);
      if (!parent) throw new Error(`Missing ${parentSelector}`);
      const parentBox = parent.getBoundingClientRect();
      return [...parent.querySelectorAll('*')].every((element) => {
        const box = element.getBoundingClientRect();
        return box.left >= parentBox.left - 0.5 && box.right <= parentBox.right + 0.5;
      });
    }
    return {
      panelWidth: rect('.findings-panel').width,
      findingControlsWithinCard: within('.finding-card .ralph-loop-controls', '.finding-card'),
      healthyControlsWithinRow: within('.healthy-row .ralph-loop-controls', '.healthy-row'),
      replyWithinHealthyRow: within('.healthy-row .btn-reply', '.healthy-row'),
      findingDescendantsWithinCard: descendantsWithin('.finding-card'),
      healthyDescendantsWithinRow: descendantsWithin('.healthy-row'),
      healthyNameWidth: rect('.healthy-row-name').width,
    };
  });

  expect(metrics.panelWidth).toBeLessThanOrEqual(430);
  expect(metrics).toMatchObject({
    findingControlsWithinCard: true,
    healthyControlsWithinRow: true,
    replyWithinHealthyRow: true,
    findingDescendantsWithinCard: true,
    healthyDescendantsWithinRow: true,
  });
  expect(metrics.healthyNameWidth).toBeGreaterThan(80);
});

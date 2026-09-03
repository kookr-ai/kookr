import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../../core/tasks.js';
import { AttentionQueue } from '../../core/attention-queue.js';
import { Monitor } from '../../core/monitor.js';
import { registerTaskRoutes } from './task-routes.js';
import { archiveTerminalTasks, TASK_ARCHIVE_DIRNAME } from '../use-cases/task-archive.js';
import type { TaskRouteDeps } from './shared.js';
import type { RecentPromptEntry } from '../../shared/contracts/recent-prompts.js';

function mkDeps(taskStore: TaskStore, extra: Partial<TaskRouteDeps> = {}): TaskRouteDeps {
  const queue = new AttentionQueue();
  const monitor = new Monitor(taskStore, queue);
  return {
    taskStore,
    monitor,
    queue,
    broadcastToAll: () => {},
    serverCwd: '/server',
    launchServiceDeps: { taskStore, adapterRegistry: {}, lifecycleDeps: {} } as never,
    adapter: {} as never,
    ...extra,
  } as TaskRouteDeps;
}

function mkApp(deps: TaskRouteDeps): Hono {
  const app = new Hono();
  registerTaskRoutes(app, deps);
  return app;
}

async function getRecent(app: Hono, query = ''): Promise<{ status: number; body: RecentPromptEntry[] }> {
  const res = await app.request(`/api/tasks/recent-prompts${query}`);
  const body = (await res.json()) as RecentPromptEntry[];
  return { status: res.status, body };
}

describe('GET /api/tasks/recent-prompts', () => {
  test('is NOT shadowed by /api/tasks/:id (route ordering)', async () => {
    // If the literal route were registered after `:id`, this path would be read
    // as a task id and 404 (no such task). A 200 + array proves correct ordering.
    const app = mkApp(mkDeps(new TaskStore()));
    const { status, body } = await getRecent(app);
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  test('returns manual-launch prompts, newest first', async () => {
    const store = new TaskStore();
    // Explicit createdAt so the two fixtures don't tie within the same ms
    // (viewTasks returns the stored refs, so mutating createdAt is observed).
    const first = store.createTask({ prompt: 'first', userPrompt: 'first', cwd: '/r', launchSource: 'ui' });
    first.createdAt = new Date(1000);
    const second = store.createTask({ prompt: 'second', userPrompt: 'second', cwd: '/r', launchSource: 'ui' });
    second.createdAt = new Date(2000);
    const { body } = await getRecent(mkApp(mkDeps(store)));
    expect(body.map((e) => e.prompt)).toEqual(['second', 'first']);
  });

  test('excludes scheduled launches (non-manual provenance)', async () => {
    const store = new TaskStore();
    store.createTask({ prompt: 'manual one', userPrompt: 'manual one', cwd: '/r', launchSource: 'ui' });
    store.createTask({ prompt: 'scheduled', userPrompt: 'scheduled', cwd: '/r', launchSource: 'schedule', scheduleId: 's1' });
    const { body } = await getRecent(mkApp(mkDeps(store)));
    expect(body.map((e) => e.prompt)).toEqual(['manual one']);
  });

  test('clamps limit to [1, 50] and defaults on non-numeric', async () => {
    const store = new TaskStore();
    for (let i = 0; i < 80; i++) {
      store.createTask({ prompt: `p${i}`, userPrompt: `p${i}`, cwd: '/r', launchSource: 'ui' });
    }
    expect((await getRecent(mkApp(mkDeps(store)), '?limit=999')).body).toHaveLength(50);
    expect((await getRecent(mkApp(mkDeps(store)), '?limit=3')).body).toHaveLength(3);
    // Non-numeric → default 20.
    expect((await getRecent(mkApp(mkDeps(store)), '?limit=abc')).body).toHaveLength(20);
  });

  test('ranks prompts launched against the query cwd first', async () => {
    const store = new TaskStore();
    // Newer prompt in an unrelated dir, older one in the target dir.
    store.createTask({ prompt: 'target repo prompt', userPrompt: 'target repo prompt', cwd: '/work/target', launchSource: 'ui' });
    store.createTask({ prompt: 'other repo prompt', userPrompt: 'other repo prompt', cwd: '/work/other', launchSource: 'ui' });
    const { body } = await getRecent(mkApp(mkDeps(store)), '?cwd=' + encodeURIComponent('/work/target'));
    expect(body[0].prompt).toBe('target repo prompt');
    expect(body[0].cwdMatch).toBe(true);
  });

  test('unions the durable archive so pruned manual prompts survive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recent-prompts-'));
    try {
      // Build a manual task, archive it, then serve from a FRESH (empty) live
      // store — the entry can only come from the archive union.
      const builder = new TaskStore();
      const archivedTask = builder.createTask({
        prompt: 'archived-only prompt',
        userPrompt: 'archived-only prompt',
        cwd: '/r',
        launchSource: 'ui',
      });
      await archiveTerminalTasks(join(dir, TASK_ARCHIVE_DIRNAME), [archivedTask]);

      const liveStore = new TaskStore();
      const app = mkApp(mkDeps(liveStore, { kookrDir: dir }));
      const { body } = await getRecent(app);
      // Live store is empty, so the archive union must yield exactly this one
      // entry — no duplicates or leakage from the union.
      expect(body.map((e) => e.prompt)).toEqual(['archived-only prompt']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

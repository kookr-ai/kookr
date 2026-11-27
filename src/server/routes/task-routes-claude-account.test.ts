import { afterEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { TaskStore } from '../../core/tasks.js';
import { Monitor } from '../../core/monitor.js';
import { AttentionQueue } from '../../core/attention-queue.js';
import { emptyClaudeAccountRegistry, withAccount } from '../../core/claude-accounts.js';
import { SUPERVISOR_TOKEN_ENV } from '../supervisor-auth.js';
import { registerTaskRoutes } from './task-routes.js';
import { SHARED_TASK_ID_PREFIX } from '../../shared/contracts/contact-share.js';
import type { TaskRouteDeps } from './shared.js';

// The switch awaits promotion of the requeued task; stand in for it.
const promotePendingTasks = vi.fn(async (_opts: unknown) => undefined);
vi.mock('../agent-lifecycle.js', async (importActual) => ({
  ...(await importActual<typeof import('../agent-lifecycle.js')>()),
  promotePendingTasks: (opts: unknown) => promotePendingTasks(opts),
}));

const originalToken = process.env[SUPERVISOR_TOKEN_ENV];
afterEach(() => {
  promotePendingTasks.mockReset();
  promotePendingTasks.mockImplementation(async () => undefined);
  if (originalToken === undefined) delete process.env[SUPERVISOR_TOKEN_ENV];
  else process.env[SUPERVISOR_TOKEN_ENV] = originalToken;
});

const registry = () => withAccount(emptyClaudeAccountRegistry(), 'work', 'sk-ant-oat01-' + 'w'.repeat(40));

function mkApp(taskStore: TaskStore) {
  const monitor = new Monitor(taskStore, new AttentionQueue());
  const broadcastToAll = vi.fn();
  const stop = vi.fn(async () => {});
  const deps = {
    taskStore,
    monitor,
    queue: new AttentionQueue(),
    adapter: { stop } as never,
    hookWatcher: { stop: vi.fn(), isWatching: () => false, watch: vi.fn() } as never,
    watchdog: { unregisterAgent: vi.fn() } as never,
    broadcastToAll,
    serverCwd: '/server',
    launchServiceDeps: { taskStore, adapterRegistry: {}, lifecycleDeps: {}, loadClaudeAccounts: registry } as never,
  } as unknown as TaskRouteDeps;
  const app = new Hono();
  registerTaskRoutes(app, deps);
  return { app, broadcastToAll, stop };
}

function runningTask(taskStore: TaskStore): string {
  const task = taskStore.createTask({ prompt: 'Implement the thing', cwd: '/repo' });
  taskStore.addSession(task.id, { tmuxSession: 'kookr-live', agentType: 'claude-code', cwd: '/repo', createdAt: new Date() });
  taskStore.updateSession(task.id, 'kookr-live', { claudeSessionId: 'conv-1' });
  return task.id;
}

const post = (app: Hono, id: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(`/api/tasks/${id}/claude-account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('POST /api/tasks/:id/claude-account', () => {
  test('relaunches a running task on the new account and reports it', async () => {
    const taskStore = new TaskStore();
    const id = runningTask(taskStore);
    const { app, broadcastToAll, stop } = mkApp(taskStore);

    const res = await post(app, id, { account: ' work ' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, outcome: 'queued', from: 'host', to: 'work' });
    expect(stop).toHaveBeenCalledWith('kookr-live');
    // The route's promotion pass must give the freed slot back to this task
    // first, not to an older pending one (issue #4235).
    expect(promotePendingTasks).toHaveBeenCalledWith(expect.objectContaining({ firstTaskId: id }));
    expect(broadcastToAll).toHaveBeenCalled();
    expect(taskStore.getTask(id)?.metadata?.claudeAccount).toBe('work');
  });

  test('an unknown account is a 400; a refused switch is a 409', async () => {
    const taskStore = new TaskStore();
    const id = runningTask(taskStore);
    const codex = taskStore.createTask({ prompt: 'x', cwd: '/repo', agentType: 'codex-cli' });
    const { app } = mkApp(taskStore);

    const unknown = await post(app, id, { account: 'nope' });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ code: 'invalid_claude_account' });

    const refused = await post(app, codex.id, { account: 'work' });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'not_claude_task' });
  });

  test('validates the body', async () => {
    const taskStore = new TaskStore();
    const id = runningTask(taskStore);
    const { app } = mkApp(taskStore);

    expect((await post(app, id, {})).status).toBe(400);
    expect((await post(app, id, { account: '  ' })).status).toBe(400);
    expect((await post(app, id, 'not json')).status).toBe(400);
    expect(taskStore.getTask(id)?.status).toBe('inProgress');
  });

  test('unknown and shared task ids', async () => {
    const { app } = mkApp(new TaskStore());
    expect((await post(app, 'missing', { account: 'work' })).status).toBe(404);
    expect((await post(app, `${SHARED_TASK_ID_PREFIX}abc`, { account: 'work' })).status).toBe(403);
  });

  test('is supervisor-gated when a supervisor token is set', async () => {
    process.env[SUPERVISOR_TOKEN_ENV] = 'sup3r-secret';
    const taskStore = new TaskStore();
    const id = runningTask(taskStore);
    const { app, stop } = mkApp(taskStore);

    expect((await post(app, id, { account: 'work' })).status).toBe(401);
    expect(stop).not.toHaveBeenCalled();
    const ok = await post(app, id, { account: 'work' }, { Authorization: 'Bearer sup3r-secret' });
    expect(ok.status).toBe(200);
  });

  test('a relaunch that failed is reported as a 409 and still broadcast', async () => {
    const taskStore = new TaskStore();
    const id = runningTask(taskStore);
    promotePendingTasks.mockImplementation(async () => {
      taskStore.cancelTask(id, { source: 'provider_admission', reason: 'launch_failure', detail: 'boom' } as never);
    });
    const { app, broadcastToAll } = mkApp(taskStore);

    const res = await post(app, id, { account: 'work' });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'relaunch_failed' });
    expect(broadcastToAll).toHaveBeenCalled();
  });
});

describe('POST /api/tasks claudeAccount field', () => {
  test('rejects an empty or non-string value before launching', async () => {
    const { app } = mkApp(new TaskStore());
    for (const claudeAccount of ['', '   ', 42]) {
      const res = await app.request('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'x', cwd: '/repo', claudeAccount }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'invalid_claude_account' });
    }
  });
});

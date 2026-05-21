import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../../core/tasks.js';
import { loadTasks } from '../../core/task-persistence.js';
import { AttentionQueue } from '../../core/attention-queue.js';
import { Monitor } from '../../core/monitor.js';
import type { RouteDeps } from './shared.js';
import type { ServerMessage } from '../../shared/contracts/messages.js';
import { buildCoordinatorSnapshotState } from '../coordinator/detectors.js';
import { buildCoordinatorDetectorTasks } from '../use-cases/get-snapshot.js';

vi.mock('../launch-service.js', async (importActual) => {
  const actual = await importActual<typeof import('../launch-service.js')>();
  return {
    ...actual,
    launchTask: vi.fn(),
  };
});

vi.mock('../use-cases/delete-task.js', async (importActual) => {
  const actual = await importActual<typeof import('../use-cases/delete-task.js')>();
  return {
    ...actual,
    deleteTask: vi.fn(),
  };
});

import { launchTask } from '../launch-service.js';
import { deleteTask } from '../use-cases/delete-task.js';
import { registerTaskRoutes } from './task-routes.js';

function mkApp(deps: Partial<RouteDeps>): Hono {
  const app = new Hono();
  registerTaskRoutes(app, deps as unknown as RouteDeps);
  return app;
}

function broadcastNoop(_msg: ServerMessage): void {
  /* no-op */
}

function mkLoopDeps(taskStore = new TaskStore()): RouteDeps {
  const queue = new AttentionQueue();
  const monitor = new Monitor(taskStore, queue);
  return {
    taskStore,
    monitor,
    queue,
    broadcastToAll: broadcastNoop,
    serverCwd: '/server',
    launchServiceDeps: { taskStore, adapterRegistry: {}, lifecycleDeps: {} } as never,
    adapter: {} as never,
  } as RouteDeps;
}

function mockRouteLaunchTask(taskStore: TaskStore) {
  vi.mocked(launchTask).mockImplementation(async (_deps, opts) => {
    const task = taskStore.createTask({
      prompt: opts.prompt,
      cwd: opts.cwd,
      playbookParameterValues: opts.playbookParameterValues,
    });
    if (opts.name) task.name = opts.name;
    if (opts.playbookId) task.playbookId = opts.playbookId;
    if (opts.projectId) taskStore.setProjectId(task.id, opts.projectId);
    return { task, queued: false };
  });
}

describe('GET /api/tasks worktree health', () => {
  test('normalizes completed missing worktree health to cleaned_up', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Ship implementation PR', '/repo');
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-cleaned',
      agentType: 'claude-code',
      cwd: '/repo-wt',
      createdAt: new Date(),
      worktreeHealth: 'missing',
    });
    taskStore.completeTask(task.id);

    const app = mkApp(mkLoopDeps(taskStore));
    const res = await app.request('/api/tasks');
    const tasks = await res.json();

    expect(tasks[0].sessions[0].worktreeHealth).toBe('cleaned_up');
  });

  test('keeps terminated missing worktree health actionable', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Investigate lost session', '/repo');
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-missing',
      agentType: 'claude-code',
      cwd: '/repo-wt',
      createdAt: new Date(),
      worktreeHealth: 'missing_unexpectedly',
    });
    taskStore.terminateTask(task.id);

    const app = mkApp(mkLoopDeps(taskStore));
    const res = await app.request('/api/tasks');
    const tasks = await res.json();

    expect(tasks[0].sessions[0].worktreeHealth).toBe('missing_unexpectedly');
  });
});

describe('GET /api/playbooks', () => {
  let tempDir: string;
  let originalUserEnv: string | undefined;
  let originalPluginEnv: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'playbooks-test-'));
    // Isolate the user + plugin tiers — these tests assert exact playbook
    // counts and would flap if the running machine has populated `~/.kookr/`
    // or a real plugin tree alongside the project.
    originalUserEnv = process.env.KOOKR_USER_PLAYBOOKS_DIR;
    originalPluginEnv = process.env.KOOKR_PLUGIN_DIR;
    process.env.KOOKR_USER_PLAYBOOKS_DIR = '/nonexistent/kookr-user-playbooks';
    process.env.KOOKR_PLUGIN_DIR = '/nonexistent/kookr-plugin';
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (originalUserEnv === undefined) delete process.env.KOOKR_USER_PLAYBOOKS_DIR;
    else process.env.KOOKR_USER_PLAYBOOKS_DIR = originalUserEnv;
    if (originalPluginEnv === undefined) delete process.env.KOOKR_PLUGIN_DIR;
    else process.env.KOOKR_PLUGIN_DIR = originalPluginEnv;
  });

  test('returns [] when the cwd has no .kookr/playbooks directory', async () => {
    const res = await mkApp({ serverCwd: tempDir }).request('/api/playbooks');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test('returns parsed playbooks from the provided cwd', async () => {
    const dir = join(tempDir, '.kookr', 'playbooks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'review.md'), `---
name: Daily review
parameters: []
---
Review the queue.
`);

    const res = await mkApp({ serverCwd: tempDir }).request('/api/playbooks');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe('Daily review');
  });

  test('accepts an explicit ?cwd= query parameter', async () => {
    const dir = join(tempDir, 'other-project');
    mkdirSync(join(dir, '.kookr', 'playbooks'), { recursive: true });
    writeFileSync(join(dir, '.kookr', 'playbooks', 'alt.md'), `---
name: Alt playbook
parameters: []
---
Do something else.
`);

    const res = await mkApp({ serverCwd: '/does-not-matter' })
      .request(`/api/playbooks?cwd=${encodeURIComponent(dir)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe('Alt playbook');
  });
});

describe('PATCH /api/tasks/:id/name', () => {
  test('renames a task and broadcasts a snapshot', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask({ prompt: 'Implement GitHub Issue', cwd: '/repo' });
    const broadcastToAll = vi.fn();
    const app = mkApp({ ...mkLoopDeps(taskStore), broadcastToAll });

    const res = await app.request(`/api/tasks/${task.id}/name`, {
      method: 'PATCH',
      body: JSON.stringify({ name: '  #224 Name GitHub issue tasks  ' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(taskStore.getTask(task.id)?.name).toBe('#224 Name GitHub issue tasks');
    expect(broadcastToAll).toHaveBeenCalledOnce();
    const body = await res.json() as { task: { name?: string } };
    expect(body.task.name).toBe('#224 Name GitHub issue tasks');
  });

  test('rejects non-string names', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask({ prompt: 'Implement GitHub Issue', cwd: '/repo' });
    const app = mkApp(mkLoopDeps(taskStore));

    const res = await app.request(`/api/tasks/${task.id}/name`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 224 }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/tasks/:id/edges', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'task-edges-route-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('updates declared edges, broadcasts, and persists them to tasks.json', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask({ prompt: 'Current task', cwd: '/repo' });
    const broadcastToAll = vi.fn();
    const tasksFile = join(tempDir, 'tasks.json');
    const app = mkApp({ ...mkLoopDeps(taskStore), broadcastToAll, tasksFile });

    const res = await app.request(`/api/tasks/${task.id}/edges`, {
      method: 'PATCH',
      body: JSON.stringify({
        blocks: ['task:downstream', 'milestone: docs published', 'task:downstream'],
        blocked_by: ['task:upstream'],
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(taskStore.getTask(task.id)).toMatchObject({
      blocks: ['task:downstream', 'milestone:docs published'],
      blocked_by: ['task:upstream'],
    });
    expect(broadcastToAll).toHaveBeenCalledOnce();

    const persisted = await loadTasks(tasksFile);
    expect(persisted.tasks[0]).toMatchObject({
      id: task.id,
      blocks: ['task:downstream', 'milestone:docs published'],
      blocked_by: ['task:upstream'],
    });
  });

  test('patches only the supplied edge side', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask({ prompt: 'Current task', cwd: '/repo' });
    taskStore.setTaskEdges(task.id, { blocks: ['task:old'], blocked_by: ['task:upstream'] });
    const app = mkApp(mkLoopDeps(taskStore));

    const res = await app.request(`/api/tasks/${task.id}/edges`, {
      method: 'PATCH',
      body: JSON.stringify({ blocks: [] }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(taskStore.getTask(task.id)).toMatchObject({
      blocks: [],
      blocked_by: ['task:upstream'],
    });
  });

  test('rejects malformed edge payloads', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask({ prompt: 'Current task', cwd: '/repo' });
    const app = mkApp(mkLoopDeps(taskStore));

    const res = await app.request(`/api/tasks/${task.id}/edges`, {
      method: 'PATCH',
      body: JSON.stringify({ blocked_by: ['not-prefixed'] }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('blocked_by entries must start with task: or milestone:');
  });
});

describe('POST /api/coordinator/acknowledgements', () => {
  test('acknowledges one done-not-cleared task without hiding peer recommendations', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'coordinator-ack-route-'));
    const taskStore = new TaskStore();
    const first = taskStore.createTask('First done task', '/repo');
    const second = taskStore.createTask('Second done task', '/repo');
    taskStore.startTask(first.id);
    taskStore.startTask(second.id);
    taskStore.completeTask(first.id);
    taskStore.completeTask(second.id);
    taskStore.getTaskForMutation(first.id)!.completionDigest = { bullets: ['done'], filesChanged: [] };
    taskStore.getTaskForMutation(second.id)!.completionDigest = { bullets: ['done'], filesChanged: [] };
    const broadcastToAll = vi.fn();
    try {
      const app = mkApp({ ...mkLoopDeps(taskStore), broadcastToAll, kookrDir: tempDir });

      const res = await app.request('/api/coordinator/acknowledgements', {
        method: 'POST',
        body: JSON.stringify({
          taskId: first.id,
          detectorId: 'done_not_cleared',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(res.status).toBe(200);
      const message = broadcastToAll.mock.calls[0]?.[0] as Extract<ServerMessage, { type: 'snapshot' }>;
      expect(message.type).toBe('snapshot');
      expect(message.coordinator?.chips.map((chip) => chip.taskId)).toEqual([second.id]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('POST /api/coordinator/mark-prior-done', () => {
  function mergedPrState(taskId: string) {
    return {
      taskId,
      prs: [{
        status: 'merged',
        checks: [{ name: 'CI', status: 'completed', conclusion: 'success' }],
      }],
      issues: [],
      changes: [],
      lastScanAt: new Date(),
    };
  }

  test('rejects prior tasks that are not safely terminal', async () => {
    const taskStore = new TaskStore();
    const parent = taskStore.createTask('Parent task', '/repo');
    const child = taskStore.createTask('Child task', '/repo', undefined, parent.id);
    const chain = buildCoordinatorSnapshotState({
      tasks: buildCoordinatorDetectorTasks(taskStore.listTasks(), []),
    }, []).chains[child.id]!;
    const githubScanner = { refreshTaskState: vi.fn().mockResolvedValue(undefined) };
    const app = mkApp({
      ...mkLoopDeps(taskStore),
      githubScanner,
      githubStateStore: { getTaskState: vi.fn() } as never,
    });

    const res = await app.request('/api/coordinator/mark-prior-done', {
      method: 'POST',
      body: JSON.stringify({
        taskId: child.id,
        priorTaskIds: [parent.id],
        concurrencyToken: chain.concurrencyToken,
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining('only terminated tasks can be marked done automatically'),
    });
    expect(githubScanner.refreshTaskState).toHaveBeenCalledWith(parent.id);
  });

  test('rejects submitted prior ids that do not match the refreshed chain strip', async () => {
    const taskStore = new TaskStore();
    const parent = taskStore.createTask('Parent task', '/repo');
    const child = taskStore.createTask('Child task', '/repo', undefined, parent.id);
    const unrelated = taskStore.createTask('Unrelated task', '/repo');
    taskStore.startTask(parent.id);
    taskStore.startTask(unrelated.id);
    taskStore.terminateTask(parent.id);
    taskStore.terminateTask(unrelated.id);
    const chain = buildCoordinatorSnapshotState({
      tasks: buildCoordinatorDetectorTasks(taskStore.listTasks(), []),
    }, []).chains[child.id]!;
    const app = mkApp({
      ...mkLoopDeps(taskStore),
      githubScanner: { refreshTaskState: vi.fn().mockResolvedValue(undefined) } as never,
      githubStateStore: { getTaskState: vi.fn(() => mergedPrState(unrelated.id)) } as never,
    });

    const res = await app.request('/api/coordinator/mark-prior-done', {
      method: 'POST',
      body: JSON.stringify({
        taskId: child.id,
        priorTaskIds: [unrelated.id],
        concurrencyToken: chain.concurrencyToken,
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: 'Submitted prior tasks no longer match the refreshed chain strip.',
    });
    expect(taskStore.getTask(unrelated.id)?.status).toBe('terminated');
  });

  test('rejects duplicate submitted prior ids even when every id belongs to the chain', async () => {
    const taskStore = new TaskStore();
    const parent = taskStore.createTask('Parent task', '/repo');
    const blocker = taskStore.createTask('Blocker task', '/repo');
    const child = taskStore.createTask('Child task', '/repo', undefined, parent.id);
    taskStore.setTaskEdges(child.id, { blocked_by: [`task:${blocker.id}`] });
    taskStore.startTask(parent.id);
    taskStore.startTask(blocker.id);
    taskStore.terminateTask(parent.id);
    taskStore.terminateTask(blocker.id);
    const chain = buildCoordinatorSnapshotState({
      tasks: buildCoordinatorDetectorTasks(taskStore.listTasks(), []),
    }, []).chains[child.id]!;
    expect(chain.priorTaskIds.sort()).toEqual([blocker.id, parent.id].sort());
    const app = mkApp({
      ...mkLoopDeps(taskStore),
      githubScanner: { refreshTaskState: vi.fn().mockResolvedValue(undefined) } as never,
      githubStateStore: { getTaskState: vi.fn(() => mergedPrState(parent.id)) } as never,
    });

    const res = await app.request('/api/coordinator/mark-prior-done', {
      method: 'POST',
      body: JSON.stringify({
        taskId: child.id,
        priorTaskIds: [parent.id, parent.id],
        concurrencyToken: chain.concurrencyToken,
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: 'Submitted prior tasks no longer match the refreshed chain strip.',
    });
    expect(taskStore.getTask(parent.id)?.status).toBe('terminated');
    expect(taskStore.getTask(blocker.id)?.status).toBe('terminated');
  });

  test.each([
    {
      name: 'non-passing post-merge CI',
      taskPatch: (_taskStore: TaskStore, _parentId: string) => {},
      state: (taskId: string) => ({
        ...mergedPrState(taskId),
        prs: [{
          status: 'merged',
          checks: [{ name: 'CI', status: 'completed', conclusion: 'failure' }],
        }],
      }),
      error: 'non-passing post-merge CI: CI',
    },
    {
      name: 'dirty worktree health',
      taskPatch: (taskStore: TaskStore, parentId: string) => {
        taskStore.addSession(parentId, {
          tmuxSession: 'dirty-session',
          agentType: 'claude-code',
          cwd: '/repo-wt',
          createdAt: new Date(),
          worktreeHealth: 'dirty',
          lastStatus: 'completed',
        });
      },
      state: mergedPrState,
      error: 'worktree is dirty',
    },
  ])('rejects $name before completing prior tasks', async ({ taskPatch, state, error }) => {
    const taskStore = new TaskStore();
    const parent = taskStore.createTask('Parent task', '/repo');
    const child = taskStore.createTask('Child task', '/repo', undefined, parent.id);
    taskStore.startTask(parent.id);
    taskStore.terminateTask(parent.id);
    taskPatch(taskStore, parent.id);
    const chain = buildCoordinatorSnapshotState({
      tasks: buildCoordinatorDetectorTasks(taskStore.listTasks(), []),
    }, []).chains[child.id]!;
    const app = mkApp({
      ...mkLoopDeps(taskStore),
      githubScanner: { refreshTaskState: vi.fn().mockResolvedValue(undefined) } as never,
      githubStateStore: { getTaskState: vi.fn(() => state(parent.id)) } as never,
    });

    const res = await app.request('/api/coordinator/mark-prior-done', {
      method: 'POST',
      body: JSON.stringify({
        taskId: child.id,
        priorTaskIds: [parent.id],
        concurrencyToken: chain.concurrencyToken,
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining(error) });
    expect(taskStore.getTask(parent.id)?.status).toBe('terminated');
  });

  test('marks matching terminated prior tasks done through the lifecycle path after click-time GitHub verification passes', async () => {
    const taskStore = new TaskStore();
    const parent = taskStore.createTask('Parent task', '/repo');
    const child = taskStore.createTask('Child task', '/repo', undefined, parent.id);
    taskStore.startTask(parent.id);
    taskStore.terminateTask(parent.id);
    const chain = buildCoordinatorSnapshotState({
      tasks: buildCoordinatorDetectorTasks(taskStore.listTasks(), []),
    }, []).chains[child.id]!;
    const broadcastToAll = vi.fn();
    const app = mkApp({
      ...mkLoopDeps(taskStore),
      broadcastToAll,
      githubScanner: { refreshTaskState: vi.fn().mockResolvedValue(undefined) } as never,
      githubStateStore: { getTaskState: vi.fn(() => mergedPrState(parent.id)) } as never,
    });

    const res = await app.request('/api/coordinator/mark-prior-done', {
      method: 'POST',
      body: JSON.stringify({
        taskId: child.id,
        priorTaskIds: [parent.id],
        concurrencyToken: chain.concurrencyToken,
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, completedTaskIds: [parent.id] });
    expect(taskStore.getTask(parent.id)?.status).toBe('completed');
    expect(broadcastToAll).toHaveBeenCalledOnce();
  });
});

describe('POST /api/tasks error paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('accepts a 500 KB launch prompt body', async () => {
    const taskStore = new TaskStore();
    mockRouteLaunchTask(taskStore);
    const prompt = 'x'.repeat(500_000);

    const res = await mkApp(mkLoopDeps(taskStore)).request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, cwd: '/cwd' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.prompt).toHaveLength(prompt.length);
    expect(launchTask).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      prompt,
      cwd: '/cwd',
    }));
  });

  test('returns 500 when launchTask throws', async () => {
    vi.mocked(launchTask).mockRejectedValueOnce(new Error('adapter blew up'));

    const taskStore = new TaskStore();
    const monitor = new Monitor(taskStore, new AttentionQueue());
    const res = await mkApp({
      taskStore,
      monitor,
      broadcastToAll: broadcastNoop,
      serverCwd: '/cwd',
      launchServiceDeps: {} as never,
    }).request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'fail me', cwd: '/cwd' }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('adapter blew up');
  });
});

describe('DELETE /api/tasks/:id error paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns 500 when the delete use-case throws', async () => {
    vi.mocked(deleteTask).mockRejectedValueOnce(new Error('session kill failed'));

    const taskStore = new TaskStore();
    const task = taskStore.createTask('Doomed', '/cwd');
    const monitor = new Monitor(taskStore, new AttentionQueue());

    const res = await mkApp({
      taskStore,
      monitor,
      broadcastToAll: broadcastNoop,
      serverCwd: '/cwd',
    }).request(`/api/tasks/${task.id}`, { method: 'DELETE' });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('session kill failed');
  });

  test('still 404s when the task is unknown even with mocks wired', async () => {
    const taskStore = new TaskStore();
    const monitor = new Monitor(taskStore, new AttentionQueue());
    const res = await mkApp({
      taskStore,
      monitor,
      broadcastToAll: broadcastNoop,
      serverCwd: '/cwd',
    }).request('/api/tasks/does-not-exist', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(vi.mocked(deleteTask)).not.toHaveBeenCalled();
  });
});

describe('GET /api/sessions/:sessionId/effective-hook-settings', () => {
  function mkAdapterReturning(effective: unknown) {
    return {
      agentType: 'claude-code' as const,
      launch: vi.fn(),
      sendInput: vi.fn(),
      sendKeystroke: vi.fn(),
      stop: vi.fn(),
      captureDisplay: vi.fn(),
      onEvent: vi.fn(),
      onRefreshNeeded: vi.fn(),
      injectHookEvent: vi.fn(),
      getEffectiveHookSettings: vi.fn(() => effective as ReturnType<typeof vi.fn>['_type']),
    };
  }

  test('returns 200 with adapter payload for a known session id', async () => {
    const payload = {
      content: { hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'x' }] }] } },
      agentType: 'claude-code',
      settingsPath: '/home/u/.kookr/settings/kookr-abc.json',
    };
    const adapter = mkAdapterReturning(payload);
    const res = await mkApp({ adapter: adapter as never }).request(
      '/api/sessions/kookr-abc/effective-hook-settings',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
    expect(adapter.getEffectiveHookSettings).toHaveBeenCalledWith('kookr-abc');
  });

  test('returns 404 for an unknown session id', async () => {
    const adapter = mkAdapterReturning(undefined);
    const res = await mkApp({ adapter: adapter as never }).request(
      '/api/sessions/kookr-nope/effective-hook-settings',
    );
    expect(res.status).toBe(404);
  });

  test.each([
    { label: 'space (decoded)', id: 'has%20space' },
    { label: 'encoded traversal', id: '..%2F..%2Fetc%2Fpasswd' },
    { label: 'null byte', id: 'good%00' },
    { label: 'tilde', id: '~root' },
  ])('rejects invalid session id without calling the adapter: $label', async ({ id }) => {
    const adapter = mkAdapterReturning(undefined);
    const res = await mkApp({ adapter: adapter as never }).request(
      `/api/sessions/${id}/effective-hook-settings`,
    );
    // 400 when the regex rejects the decoded id; 404 when the URL router
    // normalizes/strips the path before the handler matches. Either is a
    // safe outcome — the adapter must never be consulted.
    expect([400, 404]).toContain(res.status);
    expect(adapter.getEffectiveHookSettings).not.toHaveBeenCalled();
  });

  test('returns 400 for session ids that exceed the length cap', async () => {
    const adapter = mkAdapterReturning(undefined);
    const long = 'a'.repeat(129);
    const res = await mkApp({ adapter: adapter as never }).request(
      `/api/sessions/${long}/effective-hook-settings`,
    );
    expect(res.status).toBe(400);
    expect(adapter.getEffectiveHookSettings).not.toHaveBeenCalled();
  });
});

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../../core/tasks.js';
import { loadTasks } from '../../core/task-persistence.js';
import { AttentionQueue } from '../../core/attention-queue.js';
import { Monitor } from '../../core/monitor.js';
import type { TaskRouteDeps } from './shared.js';
import type { ServerMessage } from '../../shared/contracts/messages.js';
import { DEFAULT_STALE_COMPLETION_READY_THRESHOLD_MS } from '../../core/completion-ready-cleanup.js';

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

import { launchTask, CwdValidationError, DrainModeError, EffortValidationError } from '../launch-service.js';
import { deleteTask } from '../use-cases/delete-task.js';
import { registerTaskRoutes } from './task-routes.js';
import { buildCoordinatorSnapshotState } from '../coordinator/detectors.js';

function mkApp(deps: Partial<TaskRouteDeps>): Hono {
  const app = new Hono();
  registerTaskRoutes(app, deps as unknown as TaskRouteDeps);
  return app;
}

function broadcastNoop(_msg: ServerMessage): void {
  /* no-op */
}

function mkLoopDeps(taskStore = new TaskStore()): TaskRouteDeps {
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
  } as TaskRouteDeps;
}

function mockRouteLaunchTask(taskStore: TaskStore) {
  vi.mocked(launchTask).mockImplementation(async (_deps, opts) => {
    const task = taskStore.createTask({
      prompt: opts.prompt,
      cwd: opts.cwd,
      autoCloseOnSignal: opts.autoCloseOnSignal,
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

describe('GET /api/tasks aggregate token usage (issue #1307)', () => {
  const usage = (costUsd: number) => ({
    inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 0, costUsd,
    provider: 'openai' as const, model: 'gpt-5.3-codex',
  });

  test('surfaces rolled-up child usage on the parent and omits it on leaves', async () => {
    const taskStore = new TaskStore();
    const parent = taskStore.createTask({ prompt: 'batch', cwd: '/repo' });
    const childA = taskStore.createTask({ prompt: 'a', cwd: '/repo', parentTaskId: parent.id });
    const childB = taskStore.createTask({ prompt: 'b', cwd: '/repo', parentTaskId: parent.id });
    taskStore.updateTokenUsage(childA.id, usage(0.50));
    taskStore.updateTokenUsage(childB.id, usage(0.30));

    const app = mkApp(mkLoopDeps(taskStore));
    const tasks = await (await app.request('/api/tasks')).json();

    const parentRow = tasks.find((t: { id: string }) => t.id === parent.id);
    expect(parentRow.aggregateTokenUsage).toMatchObject({
      inputTokens: 200, outputTokens: 100, cacheReadTokens: 20, provider: 'openai', model: 'gpt-5.3-codex',
    });
    expect(parentRow.aggregateTokenUsage.costUsd).toBeCloseTo(0.80);

    // Leaf tasks stay byte-identical to before — no aggregate field.
    const childRow = tasks.find((t: { id: string }) => t.id === childA.id);
    expect(childRow.aggregateTokenUsage).toBeUndefined();
  });

  test('GET /api/tasks/:id also carries the aggregate on a parent', async () => {
    const taskStore = new TaskStore();
    const parent = taskStore.createTask({ prompt: 'batch', cwd: '/repo' });
    const child = taskStore.createTask({ prompt: 'c', cwd: '/repo', parentTaskId: parent.id });
    taskStore.updateTokenUsage(child.id, usage(1.25));

    const app = mkApp(mkLoopDeps(taskStore));
    const body = await (await app.request(`/api/tasks/${parent.id}`)).json();

    expect(body.aggregateTokenUsage.costUsd).toBeCloseTo(1.25);
  });
});

describe('GET /api/tasks/completion-ready/stale', () => {
  test('returns stale completion-ready tasks as a cleanup queue', async () => {
    const taskStore = new TaskStore();
    const stale = taskStore.createTask({ prompt: 'Ready but open', cwd: '/repo' });
    const fresh = taskStore.createTask({ prompt: 'Fresh ready', cwd: '/repo' });
    const autoCloseEligible = taskStore.createTask({
      prompt: 'Auto-close ready',
      cwd: '/repo',
      autoCloseOnSignal: true,
      deliveryAuthorization: 'ask-first',
    });
    for (const task of [stale, fresh, autoCloseEligible]) {
      taskStore.addSession(task.id, {
        tmuxSession: `kookr-${task.id}`,
        agentType: 'claude-code',
        cwd: '/repo-wt',
        createdAt: new Date('2026-06-20T00:00:00.000Z'),
      });
    }
    taskStore.setPendingSignal(stale.id, { kind: 'completion_ready', raisedAt: '2026-06-20T00:30:00.000Z' });
    taskStore.setPendingSignal(fresh.id, { kind: 'completion_ready', raisedAt: new Date().toISOString() });
    taskStore.setPendingSignal(autoCloseEligible.id, { kind: 'completion_ready', raisedAt: '2026-06-20T01:00:00.000Z' });

    const app = mkApp(mkLoopDeps(taskStore));
    const res = await app.request('/api/tasks/completion-ready/stale?thresholdMs=3600000');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      schemaVersion: 'stale-completion-ready-tasks.v1',
      thresholdMs: 3600000,
      count: 2,
      tasks: [{
        task: expect.objectContaining({ id: stale.id, taskId: stale.id, status: 'inProgress' }),
        signal: { kind: 'completion_ready', raisedAt: '2026-06-20T00:30:00.000Z' },
        canAutoClose: false,
        manualActionRequiredReason: 'auto_close_not_enabled',
      }, {
        task: expect.objectContaining({ id: autoCloseEligible.id, taskId: autoCloseEligible.id, status: 'inProgress' }),
        signal: { kind: 'completion_ready', raisedAt: '2026-06-20T01:00:00.000Z' },
        canAutoClose: true,
      }],
    });
    expect(body.tasks[0].ageMs).toBeGreaterThan(0);
    expect(body.tasks[1]).not.toHaveProperty('manualActionRequiredReason');
  });

  test('rejects invalid thresholdMs values', async () => {
    const app = mkApp(mkLoopDeps(new TaskStore()));
    const res = await app.request('/api/tasks/completion-ready/stale?thresholdMs=soon');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'thresholdMs must be a non-negative integer' });
  });

  test('uses the default stale threshold when thresholdMs is omitted', async () => {
    const app = mkApp(mkLoopDeps(new TaskStore()));
    const res = await app.request('/api/tasks/completion-ready/stale');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.thresholdMs).toBe(DEFAULT_STALE_COMPLETION_READY_THRESHOLD_MS);
  });

  test('rejects unsafe thresholdMs values', async () => {
    const app = mkApp(mkLoopDeps(new TaskStore()));
    const res = await app.request('/api/tasks/completion-ready/stale?thresholdMs=9007199254740992');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'thresholdMs must be a safe integer' });
  });
});

describe('GET /api/tasks/:id', () => {
  test('returns the normalized task for a known id', async () => {
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
    const res = await app.request(`/api/tasks/${task.id}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(task.id);
    expect(body.prompt).toBe('Ship implementation PR');
    // Same worktree-health normalization as the list endpoint.
    expect(body.sessions[0].worktreeHealth).toBe('cleaned_up');
  });

  test('404s with a JSON error body for an unknown id', async () => {
    const app = mkApp(mkLoopDeps(new TaskStore()));
    const res = await app.request('/api/tasks/does-not-exist');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Task not found' });
  });

  test('marks the task suppressed when a live session is snooze-suppressed', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Long-running helper', '/repo');
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-suppressed',
      agentType: 'claude-code',
      cwd: '/repo-wt',
      createdAt: new Date(),
    });

    const app = mkApp({
      ...mkLoopDeps(taskStore),
      suppressionTracker: { isSuppressed: (s: string) => s === 'kookr-suppressed' } as never,
    });
    const res = await app.request(`/api/tasks/${task.id}`);

    expect(res.status).toBe(200);
    expect((await res.json()).suppressed).toBe(true);
  });

  test('does not shadow static sibling routes like /api/tasks list', async () => {
    const taskStore = new TaskStore();
    taskStore.createTask('A task', '/repo');
    const app = mkApp(mkLoopDeps(taskStore));
    const res = await app.request('/api/tasks');
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
  });
});

describe('taskId alias (id/taskId consistency)', () => {
  test('GET /api/tasks list items carry taskId === id', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Aliased', '/repo');
    const app = mkApp(mkLoopDeps(taskStore));

    const tasks = await (await app.request('/api/tasks')).json();
    expect(tasks[0].id).toBe(task.id);
    expect(tasks[0].taskId).toBe(task.id);
  });

  test('GET /api/tasks/:id carries taskId === id', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Aliased', '/repo');
    const app = mkApp(mkLoopDeps(taskStore));

    const body = await (await app.request(`/api/tasks/${task.id}`)).json();
    expect(body.id).toBe(task.id);
    expect(body.taskId).toBe(task.id);
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

  test('uses the coalesced task-state saver when it is provided', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask({ prompt: 'Current task', cwd: '/repo' });
    const requestSave = vi.fn();
    const tasksFile = join(tempDir, 'tasks.json');
    const app = mkApp({
      ...mkLoopDeps(taskStore),
      tasksFile,
      taskStateSaveScheduler: {
        requestSave,
        flush: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      },
    });

    const res = await app.request(`/api/tasks/${task.id}/edges`, {
      method: 'PATCH',
      body: JSON.stringify({ blocks: ['task:downstream'] }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(requestSave).toHaveBeenCalledWith('task_edges_mutation');
    expect(existsSync(tasksFile)).toBe(false);
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

  test('persists autoCloseOnSignal when creating a task', async () => {
    const taskStore = new TaskStore();
    mockRouteLaunchTask(taskStore);

    const res = await mkApp(mkLoopDeps(taskStore)).request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'p', cwd: '/cwd', autoCloseOnSignal: true }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.autoCloseOnSignal).toBe(true);
    expect(launchTask).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      autoCloseOnSignal: true,
    }));
  });

  test('returns 503 with code "draining" when launchTask is gated by drain mode (issue #659)', async () => {
    vi.mocked(launchTask).mockRejectedValueOnce(new DrainModeError());

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
      body: JSON.stringify({ prompt: 'while draining', cwd: '/cwd' }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'draining' });
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

  test('returns 400 when effort is not a string (#681)', async () => {
    for (const bad of [3, null, ['high'], { level: 'high' }]) {
      vi.mocked(launchTask).mockClear();
      const res = await mkApp(mkLoopDeps(new TaskStore())).request('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'p', cwd: '/cwd', effort: bad }),
      });
      expect(res.status, `effort=${JSON.stringify(bad)}`).toBe(400);
      expect((await res.json()).error).toMatch(/effort must be a string/);
      // Shape check rejects before launch is attempted.
      expect(launchTask).not.toHaveBeenCalled();
    }
  });

  test('maps CwdValidationError to 400 with code invalid_cwd and the cause-first message (RFC F12)', async () => {
    vi.mocked(launchTask).mockRejectedValueOnce(
      new CwdValidationError('Working directory does not exist: /no/such/dir'),
    );
    const taskStore = new TaskStore();
    const res = await mkApp(mkLoopDeps(taskStore)).request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'p', cwd: '/no/such/dir' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: 'invalid_cwd',
      error: 'Working directory does not exist: /no/such/dir',
    });
  });

  test('maps EffortValidationError to 400 with code invalid_effort (#681)', async () => {
    vi.mocked(launchTask).mockRejectedValueOnce(new EffortValidationError('Invalid effort "max" for agent codex-cli'));
    const taskStore = new TaskStore();
    const res = await mkApp(mkLoopDeps(taskStore)).request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'p', cwd: '/cwd', agentType: 'codex-cli', effort: 'max' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_effort' });
  });

  test('forwards a valid string effort to launchTask (#681)', async () => {
    const taskStore = new TaskStore();
    mockRouteLaunchTask(taskStore);
    const res = await mkApp(mkLoopDeps(taskStore)).request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'p', cwd: '/cwd', effort: 'max' }),
    });
    expect(res.status).toBe(201);
    expect(launchTask).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ effort: 'max' }));
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

  test('writes an API actor audit row to kookrDir/audit.jsonl', async () => {
    vi.mocked(deleteTask).mockResolvedValueOnce(true);
    const kookrDir = mkdtempSync(join(tmpdir(), 'kookr-api-delete-audit-'));
    try {
      const taskStore = new TaskStore();
      const task = taskStore.createTask({ prompt: 'Doomed', cwd: '/cwd', projectId: 'github.com/org/repo' });
      const monitor = new Monitor(taskStore, new AttentionQueue());

      const res = await mkApp({
        taskStore,
        monitor,
        broadcastToAll: broadcastNoop,
        serverCwd: '/cwd',
        kookrDir,
      }).request(`/api/tasks/${task.id}`, { method: 'DELETE' });

      expect(res.status).toBe(200);
      const row = JSON.parse(readFileSync(join(kookrDir, 'audit.jsonl'), 'utf-8').trim()) as {
        type: string;
        actor: { source: string };
        scope: { kind: string; projectId?: string };
        count: number;
        deletedTaskIds: string[];
      };
      expect(row).toEqual(expect.objectContaining({
        type: 'task.deleteTask',
        actor: { source: 'api' },
        scope: { kind: 'project', projectId: 'github.com/org/repo' },
        count: 1,
        deletedTaskIds: [task.id],
      }));
    } finally {
      rmSync(kookrDir, { recursive: true, force: true });
    }
  });
});

describe('POST /api/tasks/:id/complete (issue #691)', () => {
  function mkCompleteDeps(taskStore: TaskStore): { deps: TaskRouteDeps; stop: ReturnType<typeof vi.fn> } {
    const queue = new AttentionQueue();
    const monitor = new Monitor(taskStore, queue);
    const stop = vi.fn(async () => {});
    const deps = {
      taskStore,
      monitor,
      queue,
      adapter: { stop } as never,
      hookWatcher: { stop: vi.fn(), isWatching: () => false, watch: vi.fn() } as never,
      watchdog: { unregisterAgent: vi.fn() } as never,
      broadcastToAll: vi.fn(),
      serverCwd: '/server',
    } as unknown as TaskRouteDeps;
    return { deps, stop };
  }

  function addLiveSession(taskStore: TaskStore, taskId: string, tmuxSession = 'kookr-live'): void {
    taskStore.addSession(taskId, {
      tmuxSession,
      agentType: 'claude-code',
      cwd: '/repo-wt',
      createdAt: new Date(),
    });
  }

  test('REST complete releases issue-ownership claims (RFC R8 — dogfood regression)', async () => {
    // Regression: task-routes builds getLifecycleDeps() field-by-field and
    // silently dropped issueClaimRegistry — REST-driven completion left the
    // claim to the orphan backstop instead of releasing it (found dogfooding
    // PR 1a: completed task kept its issueClaim; audit showed orphan_reclaim,
    // not released).
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Implement issue #1215', '/repo');
    addLiveSession(taskStore, task.id);

    const { deps } = mkCompleteDeps(taskStore);
    const safeReleaseAllFor = vi.fn(() => [] as Array<{ repo: string; number: number }>);
    (deps as { issueClaimRegistry?: unknown }).issueClaimRegistry = { safeReleaseAllFor };

    const res = await mkApp(deps).request(`/api/tasks/${task.id}/complete`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(safeReleaseAllFor).toHaveBeenCalledWith(task.id, 'released');
  });

  test('REST complete notifies task outcome callback', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Telegram-spawned task', '/repo');
    addLiveSession(taskStore, task.id);

    const { deps } = mkCompleteDeps(taskStore);
    const onTaskOutcome = vi.fn();
    deps.onTaskOutcome = onTaskOutcome;

    const res = await mkApp(deps).request(`/api/tasks/${task.id}/complete`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(onTaskOutcome).toHaveBeenCalledWith(task.id, { kind: 'completed' });
  });

  test('marks an in-progress task completed and tears down its live session', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Shipped the PR', '/repo');
    addLiveSession(taskStore, task.id);
    expect(taskStore.getTask(task.id)!.status).toBe('inProgress');

    const { deps, stop } = mkCompleteDeps(taskStore);
    const res = await mkApp(deps).request(`/api/tasks/${task.id}/complete`, { method: 'POST' });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; task: { status: string } };
    expect(body.ok).toBe(true);
    expect(body.task.status).toBe('completed');
    expect(taskStore.getTask(task.id)!.status).toBe('completed');
    // The idle dtach session is torn down through the lifecycle handler.
    expect(stop).toHaveBeenCalledWith('kookr-live');
    // No completion digest is set, so the task never trips done_not_cleared.
    expect(taskStore.getTask(task.id)!.completionDigest).toBeUndefined();
  });

  test('is idempotent: completing an already-terminal task is a no-op 200', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Already done', '/repo');
    addLiveSession(taskStore, task.id);
    taskStore.completeTask(task.id);
    expect(taskStore.getTask(task.id)!.status).toBe('completed');

    const { deps, stop } = mkCompleteDeps(taskStore);
    const res = await mkApp(deps).request(`/api/tasks/${task.id}/complete`, { method: 'POST' });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; alreadyTerminal?: boolean };
    expect(body.ok).toBe(true);
    expect(body.alreadyTerminal).toBe(true);
    // No teardown work on a task that was already terminal.
    expect(stop).not.toHaveBeenCalled();
  });

  test('acknowledges a terminated task by completing it (terminated → completed)', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Sessions died mid-run', '/repo');
    addLiveSession(taskStore, task.id);
    // terminateTask stops the live session (lastStatus: completed) and moves the
    // task to the terminal `terminated` state — the dead-session-awaiting-ack case.
    taskStore.terminateTask(task.id);
    expect(taskStore.getTask(task.id)!.status).toBe('terminated');

    const { deps } = mkCompleteDeps(taskStore);
    const res = await mkApp(deps).request(`/api/tasks/${task.id}/complete`, { method: 'POST' });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; alreadyTerminal?: boolean; task: { status: string } };
    expect(body.ok).toBe(true);
    expect(body.alreadyTerminal).toBeUndefined();
    expect(body.task.status).toBe('completed');
    expect(taskStore.getTask(task.id)!.status).toBe('completed');
  });

  test('a cancelled task is an idempotent no-op (cannot transition to completed)', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Deliberately killed', '/repo');
    addLiveSession(taskStore, task.id);
    taskStore.cancelTask(task.id);
    expect(taskStore.getTask(task.id)!.status).toBe('cancelled');

    const { deps } = mkCompleteDeps(taskStore);
    const res = await mkApp(deps).request(`/api/tasks/${task.id}/complete`, { method: 'POST' });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; alreadyTerminal?: boolean; task: { status: string } };
    expect(body.alreadyTerminal).toBe(true);
    expect(taskStore.getTask(task.id)!.status).toBe('cancelled');
  });

  test('404s for an unknown task id', async () => {
    const taskStore = new TaskStore();
    const { deps } = mkCompleteDeps(taskStore);
    const res = await mkApp(deps).request('/api/tasks/does-not-exist/complete', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  test('409s for a task that never started (cannot skip inProgress)', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Queued helper', '/repo'); // status: open
    const { deps, stop } = mkCompleteDeps(taskStore);
    const res = await mkApp(deps).request(`/api/tasks/${task.id}/complete`, { method: 'POST' });

    expect(res.status).toBe(409);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('not_in_progress');
    expect(taskStore.getTask(task.id)!.status).toBe('open');
    expect(stop).not.toHaveBeenCalled();
  });

  test('uses the shared active-Ralph partial completion policy', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Ralph root', '/repo');
    addLiveSession(taskStore, task.id);
    taskStore.getTaskForMutation(task.id)!.ralphLoop = {
      status: 'running',
      iteration: 1,
    } as never;

    const { deps, stop } = mkCompleteDeps(taskStore);
    const res = await mkApp(deps).request(`/api/tasks/${task.id}/complete`, { method: 'POST' });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; partialRalphCompletion?: boolean; task: { status: string } };
    expect(body.ok).toBe(true);
    expect(body.partialRalphCompletion).toBe(true);
    expect(body.task.status).toBe('inProgress');
    expect(taskStore.getTask(task.id)!.status).toBe('inProgress');
    expect(taskStore.getTask(task.id)!.sessions[0].lastStatus).toBe('completed');
    expect(stop).toHaveBeenCalledWith('kookr-live');
  });

  test('403s for remote-owned SharedTask ids', async () => {
    const taskStore = new TaskStore();
    const { deps } = mkCompleteDeps(taskStore);
    const res = await mkApp(deps).request('/api/tasks/shared:abc123/complete', { method: 'POST' });
    expect(res.status).toBe(403);
  });

  test('a task completed via this route without monitor events stays digestless', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Helper that finished', '/repo');
    addLiveSession(taskStore, task.id);

    const { deps } = mkCompleteDeps(taskStore);
    await mkApp(deps).request(`/api/tasks/${task.id}/complete`, { method: 'POST' });

    const completed = taskStore.getTask(task.id)!;
    expect(completed.status).toBe('completed');
    const state = buildCoordinatorSnapshotState({ tasks: [completed] }, []);
    expect(state.outputs.some((o) => o.detectorId === 'done_not_cleared')).toBe(false);

    // Control: shared completion may set a digest when monitor events exist, and
    // the detector DOES fire on a completed task that carries one.
    // proving the exclusion above is due to the absent digest, not a no-op setup.
    taskStore.setCompletionDigest(task.id, { bullets: ['did the thing'], filesChanged: [] });
    const withDigest = buildCoordinatorSnapshotState({ tasks: [taskStore.getTask(task.id)!] }, []);
    expect(withDigest.outputs.some((o) => o.detectorId === 'done_not_cleared')).toBe(true);
  });

  test('promotes a pending task after REST completion frees capacity', async () => {
    const taskStore = new TaskStore();
    const active = taskStore.createTask('Active work', '/repo');
    addLiveSession(taskStore, active.id, 'kookr-active');
    const pending = taskStore.createTask('Queued work', '/repo');
    taskStore.pendTask(pending.id);
    const { deps } = mkCompleteDeps(taskStore);
    const launch = vi.fn(async (taskId: string, _prompt: string, cwd: string) => {
      taskStore.addSession(taskId, {
        tmuxSession: 'kookr-promoted',
        agentType: 'claude-code',
        cwd,
        createdAt: new Date(),
      });
      return 'kookr-promoted';
    });
    deps.launchServiceDeps = {
      taskStore,
      adapterRegistry: { get: vi.fn(() => ({ launch, agentType: 'claude-code' })) },
      lifecycleDeps: {
        monitor: deps.monitor,
        watchdog: { registerAgent: vi.fn() },
        hookWatcher: { isWatching: vi.fn(() => false), watch: vi.fn() },
        interactionLog: { append: vi.fn() },
        githubScanner: { isActive: vi.fn(() => false), processTaskPrompt: vi.fn() },
        autoNameTask: vi.fn(),
      },
      getMaxActiveTasks: () => 1,
    } as never;

    const res = await mkApp(deps).request(`/api/tasks/${active.id}/complete`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(launch).toHaveBeenCalledWith(pending.id, 'Queued work', '/repo');
    expect(taskStore.getTask(pending.id)?.status).toBe('inProgress');
  });
});

describe('POST /api/tasks/:id/signal', () => {
  test('raises a pending signal for an active task', async () => {
    const taskStore = new TaskStore();
    const app = mkApp(mkLoopDeps(taskStore));
    const task = taskStore.createTask('Ship it', '/repo');

    const res = await app.request(`/api/tasks/${task.id}/signal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'completion_ready', note: 'tests green' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.signal.kind).toBe('completion_ready');
    expect(body.signal.note).toBe('tests green');
    expect(typeof body.signal.raisedAt).toBe('string');
    expect(taskStore.getPendingSignal(task.id)?.kind).toBe('completion_ready');
  });

  test('notifies task outcome for completion_ready signals', async () => {
    const taskStore = new TaskStore();
    const onTaskOutcome = vi.fn();
    const app = mkApp({ ...mkLoopDeps(taskStore), onTaskOutcome });
    const task = taskStore.createTask('Ship it', '/repo');

    const res = await app.request(`/api/tasks/${task.id}/signal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'completion_ready', note: 'token ghp_0123456789abcdefghij done' }),
    });

    expect(res.status).toBe(200);
    expect(onTaskOutcome).toHaveBeenCalledWith(task.id, {
      kind: 'completion_ready',
      note: expect.stringContaining('[REDACTED]'),
    });
  });

  test('records completion_ready signal when task outcome notification throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const taskStore = new TaskStore();
    const app = mkApp({
      ...mkLoopDeps(taskStore),
      onTaskOutcome: vi.fn(() => { throw new Error('telegram down'); }),
    });
    const task = taskStore.createTask('Ship it', '/repo');

    const res = await app.request(`/api/tasks/${task.id}/signal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'completion_ready', note: 'tests green' }),
    });

    expect(res.status).toBe(200);
    expect(taskStore.getPendingSignal(task.id)?.kind).toBe('completion_ready');
    warn.mockRestore();
  });

  test('redacts secrets without truncating short notes', async () => {
    const taskStore = new TaskStore();
    const app = mkApp(mkLoopDeps(taskStore));
    const task = taskStore.createTask('Ship it', '/repo');

    const res = await app.request(`/api/tasks/${task.id}/signal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'completion_ready', note: 'token ghp_0123456789abcdefghij done' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.signal.note).toContain('[REDACTED]');
    expect(body.signal.note).not.toContain('ghp_0123456789abcdefghij');
    expect(body.truncated).toBe(false);
  });

  test('preserves notes longer than the old 280-char cap', async () => {
    const taskStore = new TaskStore();
    const app = mkApp(mkLoopDeps(taskStore));
    const task = taskStore.createTask('Ship it', '/repo');
    const note = `${'status '.repeat(50)}final detail kept`;

    const res = await app.request(`/api/tasks/${task.id}/signal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'completion_ready', note }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.signal.note).toBe(note.trim());
    expect(body.signal.note.length).toBeGreaterThan(280);
    expect(body.truncated).toBe(false);
  });

  test('visibly truncates over-limit notes at a word boundary and reports it', async () => {
    const taskStore = new TaskStore();
    const app = mkApp(mkLoopDeps(taskStore));
    const task = taskStore.createTask('Ship it', '/repo');
    const note = `${'word '.repeat(399)}supercalifragilisticexpialidocious important-tail`;

    const res = await app.request(`/api/tasks/${task.id}/signal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'completion_ready', note }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.truncated).toBe(true);
    expect(body.signal.note).toMatch(/…$/);
    expect(body.signal.note).not.toContain('supercalifragilisticexpialidocious');
    expect(body.signal.note).not.toContain('important-tail');
    expect(body.signal.note.length).toBeLessThanOrEqual(2_000);
  });

  test('rejects an unknown kind with 400', async () => {
    const taskStore = new TaskStore();
    const app = mkApp(mkLoopDeps(taskStore));
    const task = taskStore.createTask('Ship it', '/repo');

    const res = await app.request(`/api/tasks/${task.id}/signal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'bogus' }),
    });
    expect(res.status).toBe(400);
    expect(taskStore.getPendingSignal(task.id)).toBeUndefined();
  });

  test('returns 404 for an unknown task', async () => {
    const taskStore = new TaskStore();
    const app = mkApp(mkLoopDeps(taskStore));
    const res = await app.request('/api/tasks/missing/signal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'completion_ready' }),
    });
    expect(res.status).toBe(404);
  });

  test('rejects a terminal task with 409', async () => {
    const taskStore = new TaskStore();
    const app = mkApp(mkLoopDeps(taskStore));
    const task = taskStore.createTask('Ship it', '/repo');
    taskStore.startTask(task.id);
    taskStore.cancelTask(task.id);

    const res = await app.request(`/api/tasks/${task.id}/signal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'completion_ready' }),
    });
    expect(res.status).toBe(409);
    expect(taskStore.getPendingSignal(task.id)).toBeUndefined();
  });

  test('rejects a SharedTask id with 403', async () => {
    const app = mkApp(mkLoopDeps());
    const res = await app.request('/api/tasks/shared:abc/signal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'completion_ready' }),
    });
    expect(res.status).toBe(403);
  });

  test('rejects malformed JSON with 400', async () => {
    const taskStore = new TaskStore();
    const app = mkApp(mkLoopDeps(taskStore));
    const task = taskStore.createTask('Ship it', '/repo');
    const res = await app.request(`/api/tasks/${task.id}/signal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    expect(taskStore.getPendingSignal(task.id)).toBeUndefined();
  });

  test('rejects a non-string note with 400', async () => {
    const taskStore = new TaskStore();
    const app = mkApp(mkLoopDeps(taskStore));
    const task = taskStore.createTask('Ship it', '/repo');
    const res = await app.request(`/api/tasks/${task.id}/signal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'completion_ready', note: 123 }),
    });
    expect(res.status).toBe(400);
  });

  test('omits a whitespace-only note', async () => {
    const taskStore = new TaskStore();
    const app = mkApp(mkLoopDeps(taskStore));
    const task = taskStore.createTask('Ship it', '/repo');
    const res = await app.request(`/api/tasks/${task.id}/signal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'completion_ready', note: '   ' }),
    });
    expect(res.status).toBe(200);
    expect(taskStore.getPendingSignal(task.id)?.note).toBeUndefined();
  });

  test('replaces a secret-only note with the redaction placeholder', async () => {
    const taskStore = new TaskStore();
    const app = mkApp(mkLoopDeps(taskStore));
    const task = taskStore.createTask('Ship it', '/repo');
    const res = await app.request(`/api/tasks/${task.id}/signal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'completion_ready', note: 'ghp_0123456789abcdefghij' }),
    });
    expect(res.status).toBe(200);
    const note = taskStore.getPendingSignal(task.id)?.note;
    expect(note).toBe('[REDACTED]');
    expect(note).not.toContain('ghp_');
  });

  test('broadcasts a snapshot on success', async () => {
    const taskStore = new TaskStore();
    const broadcastToAll = vi.fn();
    const app = mkApp({ ...mkLoopDeps(taskStore), broadcastToAll });
    const task = taskStore.createTask('Ship it', '/repo');
    const res = await app.request(`/api/tasks/${task.id}/signal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'completion_ready' }),
    });
    expect(res.status).toBe(200);
    expect(broadcastToAll).toHaveBeenCalled();
  });

  describe('autoCloseOnSignal', () => {
    function mkAutoCloseDeps(taskStore: TaskStore): TaskRouteDeps {
      const queue = new AttentionQueue();
      const monitor = new Monitor(taskStore, queue);
      return {
        taskStore,
        monitor,
        queue,
        adapter: { stop: vi.fn(async () => {}) } as never,
        hookWatcher: { stop: vi.fn(), isWatching: () => false, watch: vi.fn() } as never,
        watchdog: { unregisterAgent: vi.fn() } as never,
        broadcastToAll: vi.fn(),
        serverCwd: '/server',
      } as unknown as TaskRouteDeps;
    }

    function startActiveTask(taskStore: TaskStore, opts: { autoCloseOnSignal?: boolean } = {}): string {
      const task = taskStore.createTask({ prompt: 'Ship it', cwd: '/repo', ...opts });
      taskStore.addSession(task.id, {
        tmuxSession: 'kookr-live',
        agentType: 'claude-code',
        cwd: '/repo',
        createdAt: new Date(),
      });
      expect(taskStore.getTask(task.id)!.status).toBe('inProgress');
      return task.id;
    }

    test('schedules an opted-in task for delayed auto-close on completion_ready', async () => {
      const taskStore = new TaskStore();
      const id = startActiveTask(taskStore, { autoCloseOnSignal: true });
      const res = await mkApp(mkAutoCloseDeps(taskStore)).request(`/api/tasks/${id}/signal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'completion_ready' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.autoClosed).toBe(false);
      expect(body.autoCloseScheduled).toBe(true);
      expect(body.autoCloseAfterMs).toBe(DEFAULT_STALE_COMPLETION_READY_THRESHOLD_MS);
      expect(body).not.toHaveProperty('outcome');
      expect(taskStore.getTask(id)!.status).toBe('inProgress');
      expect(taskStore.getPendingSignal(id)?.kind).toBe('completion_ready');
    });

    test('does not advertise delayed auto-close for an active Ralph-loop task', async () => {
      const taskStore = new TaskStore();
      const id = startActiveTask(taskStore, { autoCloseOnSignal: true });
      taskStore.getTaskForMutation(id)!.ralphLoop = {
        status: 'running',
        iteration: 1,
      } as never;

      const res = await mkApp(mkAutoCloseDeps(taskStore)).request(`/api/tasks/${id}/signal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'completion_ready' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.autoClosed).toBe(false);
      expect(body).not.toHaveProperty('autoCloseScheduled');
      expect(body).not.toHaveProperty('autoCloseAfterMs');
      expect(taskStore.getTask(id)!.status).toBe('inProgress');
      expect(taskStore.getPendingSignal(id)?.kind).toBe('completion_ready');
    });

    test('falls back to recording the signal when the opted-in task is not in progress', async () => {
      const taskStore = new TaskStore();
      // Opted in, but never started (status 'open', no session) — the signal
      // still surfaces for manual review, but is not scheduled for auto-close.
      const task = taskStore.createTask({ prompt: 'Ship it', cwd: '/repo', autoCloseOnSignal: true });
      expect(taskStore.getTask(task.id)!.status).toBe('open');

      const res = await mkApp(mkAutoCloseDeps(taskStore)).request(`/api/tasks/${task.id}/signal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'completion_ready' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.autoClosed).toBe(false);
      expect(body).not.toHaveProperty('autoCloseScheduled');
      expect(taskStore.getTask(task.id)!.status).toBe('open');
      expect(taskStore.getPendingSignal(task.id)?.kind).toBe('completion_ready');
    });

    test('does not auto-complete a task that did not opt in', async () => {
      const taskStore = new TaskStore();
      const id = startActiveTask(taskStore);
      const res = await mkApp(mkAutoCloseDeps(taskStore)).request(`/api/tasks/${id}/signal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'completion_ready' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.autoClosed).toBe(false);
      expect(body.manualActionRequiredReason).toBe('auto_close_not_enabled');
      expect(taskStore.getTask(id)!.status).toBe('inProgress');
      // The signal still surfaces for manual review.
      expect(taskStore.getPendingSignal(id)?.kind).toBe('completion_ready');
    });

    test('schedules an opted-in task with the default ask-first launch stamp', async () => {
      const taskStore = new TaskStore();
      const task = taskStore.createTask({
        prompt: 'Ship it',
        cwd: '/repo',
        autoCloseOnSignal: true,
        deliveryAuthorization: 'ask-first',
      });
      taskStore.addSession(task.id, {
        tmuxSession: 'kookr-ask-first-auto-close',
        agentType: 'claude-code',
        cwd: '/repo',
        createdAt: new Date(),
      });

      const res = await mkApp(mkAutoCloseDeps(taskStore)).request(`/api/tasks/${task.id}/signal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'completion_ready' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.autoClosed).toBe(false);
      expect(body.autoCloseScheduled).toBe(true);
      expect(body.autoCloseAfterMs).toBe(DEFAULT_STALE_COMPLETION_READY_THRESHOLD_MS);
      expect(taskStore.getTask(task.id)!.status).toBe('inProgress');
    });
  });
});

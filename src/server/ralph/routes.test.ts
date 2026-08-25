import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../../core/tasks.js';
import { AttentionQueue } from '../../core/attention-queue.js';
import { Monitor } from '../../core/monitor.js';
import type { RouteDeps } from '../routes/shared.js';
import type { RalphLoopService } from '../ralph-loop-service.js';

vi.mock('../launch-service.js', async (importActual) => {
  const actual = await importActual<typeof import('../launch-service.js')>();
  return {
    ...actual,
    launchTask: vi.fn(),
  };
});

vi.mock('../agent-lifecycle.js', async (importActual) => {
  const actual = await importActual<typeof import('../agent-lifecycle.js')>();
  return {
    ...actual,
    cancelTask: vi.fn(async (taskId: string, deps: { taskStore: TaskStore }) => {
      deps.taskStore.cancelTask(taskId);
      const task = deps.taskStore.getTask(taskId);
      if (task?.ralphLoop) task.ralphLoop.status = 'cancelled';
    }),
  };
});

import { launchTask, DrainModeError } from '../launch-service.js';
import { registerRalphRoutes } from './routes.js';

function mkApp(deps: Partial<RouteDeps>): Hono {
  const app = new Hono();
  registerRalphRoutes(app, deps as unknown as RouteDeps);
  return app;
}

function createTaskForMutation(targetStore: TaskStore, ...args: unknown[]) {
  const created = (targetStore.createTask as (...innerArgs: unknown[]) => { id: string })(...args);
  const task = targetStore.getTaskForMutation(created.id);
  if (!task) throw new Error(`missing task ${created.id}`);
  return task;
}

function mkRalphDeps(
  taskStore = new TaskStore(),
  overrides: {
    ralphLoopService?: Partial<RalphLoopService>;
    requestSnapshotBroadcast?: () => void;
  } = {},
): RouteDeps {
  const monitor = new Monitor(taskStore, new AttentionQueue());
  const ralphLoopService = {
    startLoop: vi.fn(async (task) => {
      taskStore.getTaskForMutation(task.id)!.ralphLoop = {
        prompt: task.prompt,
        iterationCap: 10,
        currentIteration: 0,
        status: 'running',
        lastIterationStartedAt: Date.now(),
        cumulativeIterations: 0,
      };
      return { ok: true, changed: true, value: undefined };
    }),
    cancelLoop: vi.fn((task) => {
      const mutableTask = taskStore.getTaskForMutation(task.id);
      if (mutableTask?.ralphLoop) mutableTask.ralphLoop.status = 'cancelled';
      return { ok: true, changed: true, value: 'cancelled' };
    }),
    modifyBurnedTargets: vi.fn((taskId) => {
      return { ok: true, changed: true, value: taskStore.getTask(taskId)?.ralphLoop?.burnedOutTargets ?? [] };
    }),
    ...overrides.ralphLoopService,
  } as unknown as RalphLoopService;

  return {
    taskStore,
    monitor,
    ralphLoopService,
    // #2096: routes request a coalesced snapshot; tests inject a spy.
    requestSnapshotBroadcast: overrides.requestSnapshotBroadcast ?? vi.fn(),
    broadcastToAll: vi.fn(),
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
      name: opts.name,
      playbookId: opts.playbookId,
      projectId: opts.projectId,
      playbookParameterValues: opts.playbookParameterValues,
    });
    return { task: taskStore.getTask(task.id)!, queued: false };
  });
}

describe('legacy Ralph task entrypoints', () => {
  test('generic Ralph launch is removed', async () => {
    vi.clearAllMocks();
    const taskStore = new TaskStore();
    const res = await mkApp(mkRalphDeps(taskStore)).request('/api/tasks/ralph-loop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'go', cwd: '/cwd', iterationCap: 2 }),
    });

    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({
      code: 'generic_ralph_removed',
    });
    expect(launchTask).not.toHaveBeenCalled();
  });

  test('attach Ralph is removed', async () => {
    vi.clearAllMocks();
    const taskStore = new TaskStore();
    const task = createTaskForMutation(taskStore, 'go', '/cwd');
    const res = await mkApp(mkRalphDeps(taskStore)).request(`/api/tasks/${task.id}/ralph-loop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'go', iterationCap: 2 }),
    });

    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ code: 'generic_ralph_removed' });
  });
});

describe('PATCH /api/tasks/:id/ralph-loop/burned-targets', () => {
  test('delegates burned-target updates to RalphLoopService and broadcasts changed results', async () => {
    const taskStore = new TaskStore();
    const task = createTaskForMutation(taskStore, 'loop', '/cwd');
    task.status = 'pending';
    task.ralphLoop = {
      prompt: 'loop',
      iterationCap: 10,
      currentIteration: 2,
      status: 'running',
      lastIterationStartedAt: Date.now(),
      cumulativeIterations: 2,
      burnedOutTargets: [
        {
          target: 'src/a.ts',
          consecutiveStallCount: 1,
          totalStallCount: 1,
          firstStalledAtIteration: 1,
          lastStallReason: 'no_diff',
          lastStallBlockers: ['src/a.ts'],
          burned: true,
          lastAttemptedIteration: 1,
        },
      ],
    };
    const modifyBurnedTargets = vi.fn(() => {
      const mutableTask = taskStore.getTaskForMutation(task.id);
      if (!mutableTask?.ralphLoop) throw new Error('missing Ralph loop');
      mutableTask.ralphLoop.burnedOutTargets = [];
      return {
        ok: true,
        changed: true,
        value: [],
      };
    });
    const requestSnapshotBroadcast = vi.fn();

    const res = await mkApp(mkRalphDeps(taskStore, {
      ralphLoopService: { modifyBurnedTargets } as never,
      requestSnapshotBroadcast,
    })).request(`/api/tasks/${task.id}/ralph-loop/burned-targets`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remove: ['src/a.ts'] }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, burnedOutTargets: [] });
    expect(modifyBurnedTargets).toHaveBeenCalledWith(task.id, { remove: ['src/a.ts'], clear: false });
    // #2096: mutate path requests one coalesced snapshot; does not build payloads here.
    expect(requestSnapshotBroadcast).toHaveBeenCalledTimes(1);
  });

  test('forwards clear-all burned-target updates to RalphLoopService', async () => {
    const taskStore = new TaskStore();
    const task = createTaskForMutation(taskStore, 'loop', '/cwd');
    task.ralphLoop = {
      prompt: 'loop',
      iterationCap: 10,
      currentIteration: 2,
      status: 'running',
      lastIterationStartedAt: Date.now(),
      cumulativeIterations: 2,
      burnedOutTargets: [],
    };
    const modifyBurnedTargets = vi.fn(() => ({
      ok: true,
      changed: true,
      value: [],
    }));

    const res = await mkApp(mkRalphDeps(taskStore, {
      ralphLoopService: { modifyBurnedTargets } as never,
    })).request(`/api/tasks/${task.id}/ralph-loop/burned-targets`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clear: true }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, burnedOutTargets: [] });
    expect(modifyBurnedTargets).toHaveBeenCalledWith(task.id, { remove: [], clear: true });
  });

  test.each([
    { remove: [42] },
    { remove: 'src/a.ts' },
  ])('rejects malformed remove values before calling the service: %j', async (body) => {
    const taskStore = new TaskStore();
    const task = createTaskForMutation(taskStore, 'loop', '/cwd');
    task.ralphLoop = {
      prompt: 'loop',
      iterationCap: 10,
      currentIteration: 2,
      status: 'running',
      lastIterationStartedAt: Date.now(),
      cumulativeIterations: 2,
    };
    const modifyBurnedTargets = vi.fn();
    const requestSnapshotBroadcast = vi.fn();

    const res = await mkApp(mkRalphDeps(taskStore, {
      ralphLoopService: { modifyBurnedTargets } as never,
      requestSnapshotBroadcast,
    })).request(`/api/tasks/${task.id}/ralph-loop/burned-targets`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'remove, when present, must be an array of strings' });
    expect(modifyBurnedTargets).not.toHaveBeenCalled();
    expect(requestSnapshotBroadcast).not.toHaveBeenCalled();
  });

  test('returns service errors without broadcasting', async () => {
    const taskStore = new TaskStore();
    const task = createTaskForMutation(taskStore, 'loop', '/cwd');
    task.ralphLoop = {
      prompt: 'loop',
      iterationCap: 10,
      currentIteration: 2,
      status: 'running',
      lastIterationStartedAt: Date.now(),
      cumulativeIterations: 2,
    };
    const modifyBurnedTargets = vi.fn(() => ({
      ok: false,
      status: 404,
      body: { error: 'task has no Ralph loop attached' },
    }));
    const requestSnapshotBroadcast = vi.fn();

    const res = await mkApp(mkRalphDeps(taskStore, {
      ralphLoopService: { modifyBurnedTargets } as never,
      requestSnapshotBroadcast,
    })).request(`/api/tasks/${task.id}/ralph-loop/burned-targets`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remove: ['src/a.ts'] }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'task has no Ralph loop attached' });
    expect(modifyBurnedTargets).toHaveBeenCalledWith(task.id, { remove: ['src/a.ts'], clear: false });
    expect(requestSnapshotBroadcast).not.toHaveBeenCalled();
  });

  test('does not broadcast unchanged burned-target updates', async () => {
    const taskStore = new TaskStore();
    const task = createTaskForMutation(taskStore, 'loop', '/cwd');
    task.ralphLoop = {
      prompt: 'loop',
      iterationCap: 6,
      currentIteration: 2,
      status: 'running',
      lastIterationStartedAt: Date.now(),
      cumulativeIterations: 2,
      burnedOutTargets: [],
    };
    const modifyBurnedTargets = vi.fn(() => ({
      ok: true,
      changed: false,
      value: [],
    }));
    const requestSnapshotBroadcast = vi.fn();

    const res = await mkApp(mkRalphDeps(taskStore, {
      ralphLoopService: { modifyBurnedTargets } as never,
      requestSnapshotBroadcast,
    })).request(`/api/tasks/${task.id}/ralph-loop/burned-targets`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, burnedOutTargets: [] });
    expect(modifyBurnedTargets).toHaveBeenCalledWith(task.id, { remove: [], clear: false });
    expect(requestSnapshotBroadcast).not.toHaveBeenCalled();
  });
});

describe('POST /api/playbooks/ralph-loop', () => {
  let sourceCwd: string;
  let targetCwd: string;

  beforeEach(() => {
    vi.clearAllMocks();
    sourceCwd = mkdtempSync(join(tmpdir(), 'playbook-route-source-'));
    targetCwd = mkdtempSync(join(tmpdir(), 'playbook-route-target-'));
    mkdirSync(join(sourceCwd, '.kookr', 'playbooks'), { recursive: true });
    writeFileSync(join(sourceCwd, '.kookr', 'playbooks', 'workflow.md'), `---
name: Route workflow
tags: [workflow, loopable]
---

Loop route.
`);
  });

  afterEach(() => {
    rmSync(sourceCwd, { recursive: true, force: true });
    rmSync(targetCwd, { recursive: true, force: true });
  });

  test('accepts split playbook source and task target without legacy cwd', async () => {
    const taskStore = new TaskStore();
    mockRouteLaunchTask(taskStore);

    const res = await mkApp(mkRalphDeps(taskStore)).request('/api/playbooks/ralph-loop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playbookPath: 'workflow.md',
        playbookSourceCwd: sourceCwd,
        taskTargetCwd: targetCwd,
        projectId: `local/${basename(targetCwd)}`,
        parameterValues: {},
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.cwd).toBe(targetCwd);
    expect(body.projectId).toBe(`local/${basename(targetCwd)}`);
    expect(launchTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        cwd: targetCwd,
        projectId: `local/${basename(targetCwd)}`,
        playbookId: 'workflow.md',
      }),
      { deliveryPolicy: 'pre-authorized' },
    );
  });

  test('returns 503 with code "draining" when launchTask is gated by drain mode (issue #659)', async () => {
    const taskStore = new TaskStore();
    vi.mocked(launchTask).mockRejectedValue(new DrainModeError());

    const res = await mkApp(mkRalphDeps(taskStore)).request('/api/playbooks/ralph-loop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playbookPath: 'workflow.md',
        cwd: sourceCwd,
        parameterValues: {},
      }),
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'draining' });
  });

  test('keeps accepting legacy cwd payloads', async () => {
    const taskStore = new TaskStore();
    mockRouteLaunchTask(taskStore);

    const res = await mkApp(mkRalphDeps(taskStore)).request('/api/playbooks/ralph-loop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playbookPath: 'workflow.md',
        cwd: sourceCwd,
        parameterValues: {},
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.cwd).toBe(sourceCwd);
  });

  test('rejects malformed split fields even when legacy cwd is present', async () => {
    const taskStore = new TaskStore();
    mockRouteLaunchTask(taskStore);

    const res = await mkApp(mkRalphDeps(taskStore)).request('/api/playbooks/ralph-loop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playbookPath: 'workflow.md',
        cwd: sourceCwd,
        playbookSourceCwd: sourceCwd,
        taskTargetCwd: 42,
        parameterValues: {},
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('taskTargetCwd') });
    expect(launchTask).not.toHaveBeenCalled();
  });
});

describe('POST /api/tasks/:taskId/ralph-loop/replace-with-new', () => {
  let sourceCwd: string;
  let targetCwd: string;

  beforeEach(() => {
    vi.clearAllMocks();
    sourceCwd = mkdtempSync(join(tmpdir(), 'replace-route-source-'));
    targetCwd = mkdtempSync(join(tmpdir(), 'replace-route-target-'));
    mkdirSync(join(sourceCwd, '.kookr', 'playbooks'), { recursive: true });
    writeFileSync(join(sourceCwd, '.kookr', 'playbooks', 'workflow.md'), `---
name: Route workflow
tags: [workflow, loopable]
---

Loop {{target}}.
`);
  });

  afterEach(() => {
    rmSync(sourceCwd, { recursive: true, force: true });
    rmSync(targetCwd, { recursive: true, force: true });
  });

  test('keeps playbook replace available by default and matches keys against target cwd', async () => {
    const taskStore = new TaskStore();
    const old = createTaskForMutation(taskStore, {
      prompt: 'old loop',
      cwd: targetCwd,
      playbookParameterValues: { target: 'repo' },
    });
    taskStore.getTaskForMutation(old.id)!.playbookId = 'workflow.md';
    taskStore.getTaskForMutation(old.id)!.ralphLoop = {
      prompt: 'old loop',
      iterationCap: 6,
      currentIteration: 2,
      status: 'running',
      lastIterationStartedAt: Date.now(),
      cumulativeIterations: 2,
    };
    mockRouteLaunchTask(taskStore);

    const mismatch = await mkApp(mkRalphDeps(taskStore)).request(
      `/api/tasks/${old.id}/ralph-loop/replace-with-new`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playbookPath: 'workflow.md',
          playbookSourceCwd: sourceCwd,
          taskTargetCwd: sourceCwd,
          projectId: `local/${basename(sourceCwd)}`,
          parameterValues: { target: 'repo' },
        }),
      },
    );
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({ code: 'replacedTaskId_key_mismatch' });

    const success = await mkApp(mkRalphDeps(taskStore)).request(
      `/api/tasks/${old.id}/ralph-loop/replace-with-new`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playbookPath: 'workflow.md',
          playbookSourceCwd: sourceCwd,
          taskTargetCwd: targetCwd,
          projectId: `local/${basename(targetCwd)}`,
          parameterValues: { target: 'repo' },
        }),
      },
    );

    expect(success.status).toBe(201);
    const body = await success.json();
    expect(body.cwd).toBe(targetCwd);
    expect(body.projectId).toBe(`local/${basename(targetCwd)}`);
  });
});

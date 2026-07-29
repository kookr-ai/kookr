import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../../core/tasks.js';
import { loadTasks } from '../../core/task-persistence.js';
import { AttentionQueue } from '../../core/attention-queue.js';
import { Monitor } from '../../core/monitor.js';
import { Watchdog } from '../../core/watchdog.js';
import { getStuckFlagPrecision, resetStuckFlagPrecision } from '../../core/stuck-flag-precision.js';
import type { TaskRouteDeps } from './shared.js';
import type { ServerMessage, SystemResourceStatus } from '../../shared/contracts/messages.js';
import { performance } from 'node:perf_hooks';
import type { Anomaly } from '../../core/types.js';
import { DEFAULT_STALE_COMPLETION_READY_THRESHOLD_MS } from '../../core/completion-ready-cleanup.js';
import { SUPERVISOR_TOKEN_ENV } from '../supervisor-auth.js';

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

import { launchTask, CwdValidationError, DrainModeError, EffortValidationError, ModelValidationError, PendingQueueFullError, SpawnBurstLimitError } from '../launch-service.js';
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

describe('GET /api/tasks?view=compact', () => {
  const bigPrompt = 'X'.repeat(50_000);

  function seedTaskWithBodies(taskStore: TaskStore) {
    const task = taskStore.createTask({
      prompt: bigPrompt,
      userPrompt: 'Original user prompt body',
      cwd: '/repo',
      criteria: 'A moderately long acceptance criteria body '.repeat(20),
      // Seed the advisory launch bodies so the compact-omission assertions
      // below are meaningful (an unset field is trivially absent in both views).
      launchNote: 'Prepended launch warning that should not ship in the list',
      launchHealthSummary: {
        degradedDependencies: ['gh'],
        findings: [{
          dependency: 'gh', status: 'failed', category: 'auth',
          summary: 'not logged in', recommendedAction: 'run gh auth login',
        }],
      },
    });
    taskStore.setCompletionDigest(task.id, {
      bullets: ['Did the thing', 'Verified the thing'],
      filesChanged: ['src/a.ts', 'src/b.ts'],
    });
    return task;
  }

  test('omits heavy prompt bodies but keeps list-row fields', async () => {
    const taskStore = new TaskStore();
    const task = seedTaskWithBodies(taskStore);
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-compact',
      agentType: 'claude-code',
      cwd: '/repo-wt',
      createdAt: new Date(),
      lastStatus: 'working',
      worktreeHealth: 'healthy',
    });

    const app = mkApp(mkLoopDeps(taskStore));
    const rows = await (await app.request('/api/tasks?view=compact')).json();
    const row = rows.find((t: { id: string }) => t.id === task.id);

    // Heavy bodies are gone.
    expect(row.prompt).toBeUndefined();
    expect(row.userPrompt).toBeUndefined();
    expect(row.criteria).toBeUndefined();
    expect(row.completionDigest).toBeUndefined();
    expect(row.launchHealthSummary).toBeUndefined();
    expect(row.launchNote).toBeUndefined();
    // The full view carries these seeded bodies — proving the omission above is
    // the projection dropping them, not a task that never had them.
    const fullRow = (await (await app.request('/api/tasks')).json())
      .find((t: { id: string }) => t.id === task.id);
    expect(fullRow.launchHealthSummary).toBeDefined();
    expect(fullRow.launchNote).toBeDefined();
    expect(Object.keys(row)).not.toContain('prompt');
    expect(Object.keys(row)).not.toContain('userPrompt');

    // List-row fields survive.
    expect(row.id).toBe(task.id);
    expect(row.taskId).toBe(task.id);
    expect(row.status).toBe(taskStore.getTask(task.id)!.status);
    expect(row.cwd).toBe('/repo');
    expect(row.agentType).toBe(task.agentType);
    expect(typeof row.createdAt).toBe('string');
    expect(typeof row.updatedAt).toBe('string');

    // Session health stub carries tmuxSession + normalized worktree health.
    expect(row.sessions[0].tmuxSession).toBe('kookr-compact');
    expect(row.sessions[0].lastStatus).toBe('working');
    expect(row.sessions[0].worktreeHealth).toBe('healthy');
    expect(row.sessions[0].transcriptPath).toBeUndefined();
  });

  test('normalizes terminal worktree health in the compact session stub', async () => {
    const taskStore = new TaskStore();
    const completed = taskStore.createTask('Ship PR', '/repo');
    taskStore.addSession(completed.id, {
      tmuxSession: 'kookr-done', agentType: 'claude-code', cwd: '/repo-wt',
      createdAt: new Date(), worktreeHealth: 'missing',
    });
    taskStore.completeTask(completed.id);

    const terminated = taskStore.createTask('Lost session', '/repo');
    taskStore.addSession(terminated.id, {
      tmuxSession: 'kookr-gone', agentType: 'claude-code', cwd: '/repo-wt',
      createdAt: new Date(), worktreeHealth: 'missing_unexpectedly',
    });
    taskStore.terminateTask(terminated.id);

    const app = mkApp(mkLoopDeps(taskStore));
    const rows = await (await app.request('/api/tasks?view=compact')).json();

    // completed + missing → cleaned_up; terminated stays actionable — same rule
    // the full view applies via normalizeTaskForApi.
    const doneRow = rows.find((t: { id: string }) => t.id === completed.id);
    expect(doneRow.sessions[0].worktreeHealth).toBe('cleaned_up');
    const goneRow = rows.find((t: { id: string }) => t.id === terminated.id);
    expect(goneRow.sessions[0].worktreeHealth).toBe('missing_unexpectedly');
  });

  test('default (no view param) full list still carries the prompt', async () => {
    const taskStore = new TaskStore();
    const task = seedTaskWithBodies(taskStore);

    const app = mkApp(mkLoopDeps(taskStore));
    const rows = await (await app.request('/api/tasks')).json();
    const row = rows.find((t: { id: string }) => t.id === task.id);

    expect(row.prompt).toBe(bigPrompt);
    expect(row.userPrompt).toBe('Original user prompt body');
    expect(row.criteria).toBeDefined();
  });

  test('compact payload is dramatically smaller than the full list', async () => {
    const taskStore = new TaskStore();
    seedTaskWithBodies(taskStore);

    const app = mkApp(mkLoopDeps(taskStore));
    const full = await (await app.request('/api/tasks')).text();
    const compact = await (await app.request('/api/tasks?view=compact')).text();

    expect(compact.length).toBeLessThan(full.length / 10);
    expect(compact).not.toContain(bigPrompt);
  });

  test('GET /api/tasks/:id still returns full detail including prompt', async () => {
    const taskStore = new TaskStore();
    const task = seedTaskWithBodies(taskStore);

    const app = mkApp(mkLoopDeps(taskStore));
    const detail = await (await app.request(`/api/tasks/${task.id}`)).json();

    expect(detail.prompt).toBe(bigPrompt);
    expect(detail.userPrompt).toBe('Original user prompt body');
  });

  // issue #1562 AC2: the operator-needed flag (and the unattended marker) must be
  // visible via the tasks API — both the full list/detail and the compact list.
  test('surfaces unattended + operatorNeeded in the compact and full tasks API', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask({ prompt: 'Autonomous work', cwd: '/repo', unattended: true });
    taskStore.setOperatorNeeded(task.id, {
      reason: 'interactive_tool_denied',
      toolName: 'AskUserQuestion',
      detectedAt: new Date('2026-07-28T10:00:00Z'),
      message: 'blocked',
    });

    const app = mkApp(mkLoopDeps(taskStore));

    const compactRow = (await (await app.request('/api/tasks?view=compact')).json())
      .find((t: { id: string }) => t.id === task.id);
    expect(compactRow.unattended).toBe(true);
    expect(compactRow.operatorNeeded).toMatchObject({
      reason: 'interactive_tool_denied',
      toolName: 'AskUserQuestion',
    });

    const detail = await (await app.request(`/api/tasks/${task.id}`)).json();
    expect(detail.unattended).toBe(true);
    expect(detail.operatorNeeded).toMatchObject({ reason: 'interactive_tool_denied', toolName: 'AskUserQuestion' });
  });

  test('compact rolls up child token usage on the parent', async () => {
    const taskStore = new TaskStore();
    const parent = taskStore.createTask({ prompt: 'batch', cwd: '/repo' });
    const child = taskStore.createTask({ prompt: 'child', cwd: '/repo', parentTaskId: parent.id });
    taskStore.updateTokenUsage(child.id, {
      inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 0, costUsd: 0.5,
    });

    const app = mkApp(mkLoopDeps(taskStore));
    const rows = await (await app.request('/api/tasks?view=compact')).json();

    const parentRow = rows.find((t: { id: string }) => t.id === parent.id);
    expect(parentRow.aggregateTokenUsage).toMatchObject({
      inputTokens: 100, outputTokens: 50, cacheReadTokens: 10,
    });
    expect(parentRow.aggregateTokenUsage.costUsd).toBeCloseTo(0.5);
    const childRow = rows.find((t: { id: string }) => t.id === child.id);
    expect(childRow.aggregateTokenUsage).toBeUndefined();
  });

  test('compact flags only suppressed sessions, not healthy ones', async () => {
    const taskStore = new TaskStore();
    const suppressed = taskStore.createTask('Suppressed helper', '/repo');
    taskStore.addSession(suppressed.id, {
      tmuxSession: 'kookr-suppressed',
      agentType: 'claude-code',
      cwd: '/repo-wt',
      createdAt: new Date(),
      lastStatus: 'working',
    });
    const healthy = taskStore.createTask('Healthy helper', '/repo');
    taskStore.addSession(healthy.id, {
      tmuxSession: 'kookr-healthy',
      agentType: 'claude-code',
      cwd: '/repo-wt',
      createdAt: new Date(),
      lastStatus: 'working',
    });

    const deps = mkLoopDeps(taskStore);
    deps.suppressionTracker = {
      isSuppressed: (s: string) => s === 'kookr-suppressed',
    } as unknown as TaskRouteDeps['suppressionTracker'];

    const app = mkApp(deps);
    const rows = await (await app.request('/api/tasks?view=compact')).json();

    const suppressedRow = rows.find((t: { id: string }) => t.id === suppressed.id);
    expect(suppressedRow.suppressed).toBe(true);
    expect(suppressedRow.prompt).toBeUndefined();

    // Negative control: a non-suppressed session must NOT carry the flag, so a
    // projection that unconditionally set `suppressed` would fail here.
    const healthyRow = rows.find((t: { id: string }) => t.id === healthy.id);
    expect(healthyRow.suppressed).toBeUndefined();
  });

  test('issue #1588: a pre-session disposition is queryable via both the full and compact API views', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask({ prompt: 'launch aborted', cwd: '/repo' });
    // A launch-timeout cleanup disposed it before any session attached.
    taskStore.setDisposition(task.id, {
      reason: 'launch_timeout',
      at: '2026-07-27T00:00:00.000Z',
      source: 'launch-service',
      detail: 'adapter launch timed out',
    });
    taskStore.terminateTask(task.id);

    const app = mkApp(mkLoopDeps(taskStore));

    // Full detail view surfaces the disposition (reason + timestamp).
    const detail = await (await app.request(`/api/tasks/${task.id}`)).json();
    expect(detail.status).toBe('terminated');
    expect(detail.disposition).toMatchObject({
      reason: 'launch_timeout',
      at: '2026-07-27T00:00:00.000Z',
      source: 'launch-service',
    });

    // Compact list view carries it too, so a dashboard row can show WHY.
    const rows = await (await app.request('/api/tasks?view=compact')).json();
    const row = rows.find((t: { id: string }) => t.id === task.id);
    expect(row.disposition?.reason).toBe('launch_timeout');
  });
});

describe('stuckReason projection (issue #1526 Phase B)', () => {
  function anomaly(overrides: Partial<Anomaly> = {}): Anomaly {
    return {
      agentId: 'kookr-stuck',
      type: 'needs_input',
      severity: 'info',
      explanation: 'test anomaly',
      detectedAt: new Date('2026-07-24T10:00:00.000Z'),
      ...overrides,
    };
  }

  function seedInProgressTask(taskStore: TaskStore, tmuxSession: string) {
    const task = taskStore.createTask('Do the thing', '/repo');
    taskStore.addSession(task.id, {
      tmuxSession,
      agentType: 'claude-code',
      cwd: '/repo-wt',
      createdAt: new Date(),
      lastStatus: 'working',
    });
    return taskStore.getTask(task.id)!;
  }

  function findRow(rows: Array<{ id: string }>, id: string) {
    return rows.find((t) => t.id === id);
  }

  // The precision counter (#1653) is a process-local singleton mutated by the
  // stuckReason projection on every /api/tasks poll — reset it so the
  // liveness-cross-check assertions below start from zero.
  beforeEach(() => resetStuckFlagPrecision());

  test('pendingSignal completion_ready → stuckReason awaiting_completion_ack, on both full and compact views', async () => {
    const taskStore = new TaskStore();
    const task = seedInProgressTask(taskStore, 'kookr-ack');
    taskStore.setPendingSignal(task.id, { kind: 'completion_ready', raisedAt: '2026-07-24T10:00:00.000Z' });

    const app = mkApp(mkLoopDeps(taskStore));
    const full = findRow(await (await app.request('/api/tasks')).json(), task.id);
    expect(full.stuckReason).toBe('awaiting_completion_ack');

    const compact = findRow(await (await app.request('/api/tasks?view=compact')).json(), task.id);
    expect(compact.stuckReason).toBe('awaiting_completion_ack');

    const detail = await (await app.request(`/api/tasks/${task.id}`)).json();
    expect(detail.stuckReason).toBe('awaiting_completion_ack');
  });

  test('queued needs_input anomaly → stuckReason waiting_on_input', async () => {
    const taskStore = new TaskStore();
    const task = seedInProgressTask(taskStore, 'kookr-needs-input');
    const queue = new AttentionQueue();
    queue.enqueue('kookr-needs-input', anomaly({ agentId: 'kookr-needs-input', type: 'needs_input' }));

    const deps = mkLoopDeps(taskStore);
    deps.queue = queue;
    const app = mkApp(deps);
    const row = findRow(await (await app.request('/api/tasks')).json(), task.id);
    expect(row.stuckReason).toBe('waiting_on_input');
    // No watchdog liveness for this agent → nothing to cross-check → real flag.
    expect(getStuckFlagPrecision()).toMatchObject({ flags: 1, suppressed: 0 });
  });

  test('#1653: needs_input on an agent with recent watchdog liveness is suppressed (no false alarm) and recorded as a suppression', async () => {
    const taskStore = new TaskStore();
    const task = seedInProgressTask(taskStore, 'kookr-live');
    const queue = new AttentionQueue();
    queue.enqueue('kookr-live', anomaly({ agentId: 'kookr-live', type: 'needs_input' }));

    const deps = mkLoopDeps(taskStore);
    deps.queue = queue;
    // Spinner/token counter animating in the same minute the anomaly queued:
    // register the agent with a hook event ~now so the liveness cross-check fires.
    const watchdog = new Watchdog();
    watchdog.registerAgent('kookr-live', Date.now());
    deps.watchdog = watchdog;

    const app = mkApp(deps);
    const row = findRow(await (await app.request('/api/tasks')).json(), task.id);
    expect(row.stuckReason).toBeUndefined();
    expect(Object.keys(row)).not.toContain('stuckReason');
    // The would-be false positive is counted, so the fix is measurable.
    expect(getStuckFlagPrecision()).toMatchObject({ flags: 0, suppressed: 1 });
  });

  test('#1653: polling the same suppressed agent repeatedly counts one episode, not one per poll', async () => {
    const taskStore = new TaskStore();
    const task = seedInProgressTask(taskStore, 'kookr-poll');
    const queue = new AttentionQueue();
    queue.enqueue('kookr-poll', anomaly({ agentId: 'kookr-poll', type: 'needs_input' }));

    const deps = mkLoopDeps(taskStore);
    deps.queue = queue;
    const watchdog = new Watchdog();
    watchdog.registerAgent('kookr-poll', Date.now());
    deps.watchdog = watchdog;

    const app = mkApp(deps);
    for (let i = 0; i < 5; i++) {
      const row = findRow(await (await app.request('/api/tasks')).json(), task.id);
      expect(row.stuckReason).toBeUndefined();
    }
    // 5 polls of one suppressed episode → a single suppressed tick.
    expect(getStuckFlagPrecision()).toMatchObject({ flags: 0, suppressed: 1 });
  });

  test('queued permission_blocked anomaly → stuckReason permission_blocked', async () => {
    const taskStore = new TaskStore();
    const task = seedInProgressTask(taskStore, 'kookr-perm');
    const queue = new AttentionQueue();
    queue.enqueue('kookr-perm', anomaly({ agentId: 'kookr-perm', type: 'permission_blocked', severity: 'warning' }));

    const deps = mkLoopDeps(taskStore);
    deps.queue = queue;
    const app = mkApp(deps);
    const row = findRow(await (await app.request('/api/tasks')).json(), task.id);
    expect(row.stuckReason).toBe('permission_blocked');
  });

  test('queued stale_agent anomaly → stuckReason hung_suspect', async () => {
    const taskStore = new TaskStore();
    const task = seedInProgressTask(taskStore, 'kookr-hung');
    const queue = new AttentionQueue();
    queue.enqueue('kookr-hung', anomaly({ agentId: 'kookr-hung', type: 'stale_agent', severity: 'warning' }));

    const deps = mkLoopDeps(taskStore);
    deps.queue = queue;
    deps.watchdog = new Watchdog();
    const app = mkApp(deps);
    const row = findRow(await (await app.request('/api/tasks')).json(), task.id);
    expect(row.stuckReason).toBe('hung_suspect');
  });

  test('a genuinely healthy inProgress task carries no stuckReason field at all', async () => {
    const taskStore = new TaskStore();
    const task = seedInProgressTask(taskStore, 'kookr-healthy-row');
    const deps = mkLoopDeps(taskStore);
    deps.queue = new AttentionQueue();
    deps.watchdog = new Watchdog();

    const app = mkApp(deps);
    const row = findRow(await (await app.request('/api/tasks')).json(), task.id);
    expect(row.stuckReason).toBeUndefined();
    expect(Object.keys(row)).not.toContain('stuckReason');
  });

  test('a non-inProgress task (pending, no session) never carries stuckReason, even with queue/watchdog wired', async () => {
    const taskStore = new TaskStore();
    const pending = taskStore.createTask('Queued task', '/repo');
    const deps = mkLoopDeps(taskStore);
    deps.queue = new AttentionQueue();
    deps.watchdog = new Watchdog();

    const app = mkApp(deps);
    const row = findRow(await (await app.request('/api/tasks')).json(), pending.id);
    expect(row.status).toBe('open');
    expect(row.stuckReason).toBeUndefined();
  });

  test('watchdog state absent (deps.watchdog omitted) never crashes and treats the task as working', async () => {
    const taskStore = new TaskStore();
    const task = seedInProgressTask(taskStore, 'kookr-no-watchdog');
    const deps = mkLoopDeps(taskStore);
    deps.queue = new AttentionQueue();
    // deps.watchdog intentionally left unset.

    const app = mkApp(deps);
    const res = await app.request('/api/tasks');
    expect(res.status).toBe(200);
    const row = findRow(await res.json(), task.id);
    expect(row.stuckReason).toBeUndefined();
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

  test('threads getCompletionReadyTtlMs and reports closeReason: ttl_escalation (issue #1526 Phase A)', async () => {
    const taskStore = new TaskStore();
    // Ask-first, past a 5-minute TTL but well under the 1h thresholdMs query
    // below — only reachable via the TTL tier, proving ttlMs was threaded in.
    const ttlEligible = taskStore.createTask({
      prompt: 'Ask-first past the TTL',
      cwd: '/repo',
      deliveryAuthorization: 'ask-first',
    });
    taskStore.addSession(ttlEligible.id, {
      tmuxSession: `kookr-${ttlEligible.id}`,
      agentType: 'claude-code',
      cwd: '/repo-wt',
      createdAt: new Date(Date.now() - 20 * 60_000),
    });
    taskStore.setPendingSignal(ttlEligible.id, {
      kind: 'completion_ready',
      raisedAt: new Date(Date.now() - 10 * 60_000).toISOString(), // 10 minutes old
    });

    const app = mkApp({
      ...mkLoopDeps(taskStore),
      getCompletionReadyTtlMs: () => 5 * 60_000, // 5 minutes — past by the 10-minute-old signal
    });
    const res = await app.request('/api/tasks/completion-ready/stale?thresholdMs=3600000');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.tasks).toEqual([
      expect.objectContaining({
        task: expect.objectContaining({ id: ttlEligible.id }),
        canAutoClose: true,
        closeReason: 'ttl_escalation',
      }),
    ]);
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
    vi.mocked(launchTask).mockRejectedValueOnce(new EffortValidationError('Invalid effort "supermax" for agent codex-cli'));
    const taskStore = new TaskStore();
    const res = await mkApp(mkLoopDeps(taskStore)).request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'p', cwd: '/cwd', agentType: 'codex-cli', effort: 'supermax' }),
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

  test('returns 400 when model is not a string (#1518)', async () => {
    for (const bad of [3, null, ['claude-fable-5'], { id: 'claude-fable-5' }]) {
      vi.mocked(launchTask).mockClear();
      const res = await mkApp(mkLoopDeps(new TaskStore())).request('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'p', cwd: '/cwd', model: bad }),
      });
      expect(res.status, `model=${JSON.stringify(bad)}`).toBe(400);
      expect((await res.json()).error).toMatch(/model must be a string/);
      expect(launchTask).not.toHaveBeenCalled();
    }
  });

  test('maps ModelValidationError to 400 with code invalid_model (#1518)', async () => {
    vi.mocked(launchTask).mockRejectedValueOnce(
      new ModelValidationError('Invalid model "not-real" for agent claude-code'),
    );
    const taskStore = new TaskStore();
    const res = await mkApp(mkLoopDeps(taskStore)).request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'p', cwd: '/cwd', model: 'not-real' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_model' });
  });

  // --- Server-side backpressure (issue #1526 Phase C / C3) ---

  const backpressureLedger = {
    maxActiveTasks: 10,
    active: 10,
    free: 0,
    byClass: { working: 2, finishedAwaitingAck: 7, hungSuspect: 1, launching: 0 },
    pendingQueueDepth: 24,
    oldestPendingAgeMs: 120_000,
    oldestFinishedAwaitingAckAgeMs: 3_600_000,
  };

  test('maps PendingQueueFullError to 429 with code + full capacity ledger body (issue #1526 C3)', async () => {
    vi.mocked(launchTask).mockRejectedValueOnce(new PendingQueueFullError(backpressureLedger, 24));
    const res = await mkApp(mkLoopDeps(new TaskStore())).request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'p', cwd: '/cwd' }),
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toMatchObject({
      code: 'pending_queue_full',
      maxPendingTasks: 24,
      capacity: backpressureLedger,
    });
    expect(body.error).toMatch(/Pending queue is full/);
  });

  test('maps SpawnBurstLimitError to 429 with code, ledger, budget fields and Retry-After (issue #1526 C3)', async () => {
    vi.mocked(launchTask).mockRejectedValueOnce(new SpawnBurstLimitError(
      { allowed: false, source: 'api:actor:lucy', count: 30, limit: 30, windowMs: 600_000, retryAfterMs: 42_000 },
      backpressureLedger,
    ));
    const res = await mkApp(mkLoopDeps(new TaskStore())).request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'p', cwd: '/cwd' }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
    expect(await res.json()).toMatchObject({
      code: 'spawn_burst_limit',
      source: 'api:actor:lucy',
      limit: 30,
      windowMs: 600_000,
      retryAfterMs: 42_000,
      capacity: backpressureLedger,
    });
  });

  test('forwards the X-Kookr-Actor header as launchActorId for actor-qualified budgets (issue #1526 C3)', async () => {
    const taskStore = new TaskStore();
    mockRouteLaunchTask(taskStore);
    const res = await mkApp(mkLoopDeps(taskStore)).request('/api/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kookr-Actor': 'lucy-supervisor',
      },
      body: JSON.stringify({ prompt: 'p', cwd: '/cwd' }),
    });
    expect(res.status).toBe(201);
    expect(launchTask).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      launchActorId: 'lucy-supervisor',
    }));
  });

  test('omits launchActorId when the actor header is absent or blank', async () => {
    const taskStore = new TaskStore();
    mockRouteLaunchTask(taskStore);
    const res = await mkApp(mkLoopDeps(taskStore)).request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kookr-Actor': '   ' },
      body: JSON.stringify({ prompt: 'p', cwd: '/cwd' }),
    });
    expect(res.status).toBe(201);
    expect(launchTask).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      launchActorId: undefined,
    }));
  });

  test('forwards a valid string model to launchTask (#1518)', async () => {
    const taskStore = new TaskStore();
    mockRouteLaunchTask(taskStore);
    const res = await mkApp(mkLoopDeps(taskStore)).request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'p',
        cwd: '/cwd',
        model: 'claude-fable-5',
        effort: 'max',
      }),
    });
    expect(res.status).toBe(201);
    expect(launchTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ model: 'claude-fable-5', effort: 'max' }),
    );
  });
});

// --- Load-based admission control (issue #1590) ---
describe('POST /api/tasks event-loop saturation admission (issue #1590)', () => {
  beforeEach(() => {
    vi.mocked(launchTask).mockReset();
  });

  /** Minimal resource snapshot carrying a chosen event-loop delay p95 (ms). */
  function statusWithEventLoopP95(p95Ms: number | null) {
    return {
      source: { kind: 'server-host' as const },
      server: { eventLoopDelayP95Ms: p95Ms },
    } as unknown as SystemResourceStatus;
  }

  function admissionDeps(
    taskStore: TaskStore,
    p95Ms: number | null,
    over: Partial<TaskRouteDeps> = {},
  ): TaskRouteDeps {
    return {
      ...mkLoopDeps(taskStore),
      getLatestResourceStatus: () => statusWithEventLoopP95(p95Ms),
      admissionControlConfig: { eventLoopDelayThresholdMs: 1_000, retryAfterSeconds: 2 },
      ...over,
    };
  }

  test('sheds with 503 + Retry-After + saturation code in <2s when p95 exceeds the threshold, without launching', async () => {
    const taskStore = new TaskStore();
    // launchTask must never be reached — assert on the mock, not just the body.
    vi.mocked(launchTask).mockImplementation(async () => {
      throw new Error('launchTask must not run when the event loop is saturated');
    });
    const started = performance.now();
    const res = await mkApp(admissionDeps(taskStore, 4_000)).request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'p', cwd: '/cwd' }),
    });
    const elapsedMs = performance.now() - started;
    expect(res.status).toBe(503);
    // Timing bound (acceptance criterion). This is a smoke bound: the reject
    // path is a synchronous short-circuit, so a regression that instead moved
    // admission *after* `await c.req.json()` / into the launch path is caught by
    // the `launchTask` not-called assertion below, not by the clock. The bound
    // guards only against the reject path itself gaining an unexpected await.
    expect(elapsedMs).toBeLessThan(2_000);
    expect(res.headers.get('Retry-After')).toBe('2');
    const body = await res.json();
    expect(body).toMatchObject({
      code: 'event_loop_saturated',
      observedEventLoopDelayP95Ms: 4_000,
      thresholdMs: 1_000,
      retryAfterSeconds: 2,
    });
    // Distinguishable from the #1536 depth 429.
    expect(body.code).not.toBe('pending_queue_full');
    expect(body.code).not.toBe('spawn_burst_limit');
    expect(body.error).toMatch(/saturat/i);
    expect(launchTask).not.toHaveBeenCalled();
  });

  test('the Retry-After header tracks the configured value, not a hardcoded default', async () => {
    const res = await mkApp(
      admissionDeps(new TaskStore(), 4_000, {
        admissionControlConfig: { eventLoopDelayThresholdMs: 1_000, retryAfterSeconds: 5 },
      }),
    ).request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'p', cwd: '/cwd' }),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('5');
    expect(await res.json()).toMatchObject({ retryAfterSeconds: 5 });
  });

  test('provider wired but returning a null snapshot (pre-first-sample) fails open', async () => {
    const taskStore = new TaskStore();
    mockRouteLaunchTask(taskStore);
    const res = await mkApp(
      admissionDeps(taskStore, 4_000, { getLatestResourceStatus: () => null }),
    ).request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'p', cwd: '/cwd' }),
    });
    expect(res.status).toBe(201);
    expect(launchTask).toHaveBeenCalledTimes(1);
  });

  test('at exactly the threshold, sheds (boundary is >=)', async () => {
    const res = await mkApp(admissionDeps(new TaskStore(), 1_000)).request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'p', cwd: '/cwd' }),
    });
    expect(res.status).toBe(503);
  });

  test('below the threshold, POST is unchanged — proceeds to launch (201)', async () => {
    const taskStore = new TaskStore();
    mockRouteLaunchTask(taskStore);
    const res = await mkApp(admissionDeps(taskStore, 50)).request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'p', cwd: '/cwd' }),
    });
    expect(res.status).toBe(201);
    expect(launchTask).toHaveBeenCalledTimes(1);
  });

  test('unavailable saturation signal (null) fails open — POST proceeds', async () => {
    const taskStore = new TaskStore();
    mockRouteLaunchTask(taskStore);
    const res = await mkApp(admissionDeps(taskStore, null)).request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'p', cwd: '/cwd' }),
    });
    expect(res.status).toBe(201);
    expect(launchTask).toHaveBeenCalledTimes(1);
  });

  test('disabled gate (threshold 0) admits even under extreme lag', async () => {
    const taskStore = new TaskStore();
    mockRouteLaunchTask(taskStore);
    const res = await mkApp(
      admissionDeps(taskStore, 99_999, {
        admissionControlConfig: { eventLoopDelayThresholdMs: 0, retryAfterSeconds: 2 },
      }),
    ).request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'p', cwd: '/cwd' }),
    });
    expect(res.status).toBe(201);
    expect(launchTask).toHaveBeenCalledTimes(1);
  });

  test('no resource-status provider wired (deps omit it) fails open', async () => {
    const taskStore = new TaskStore();
    mockRouteLaunchTask(taskStore);
    // mkLoopDeps has no getLatestResourceStatus; env fallback config applies.
    const res = await mkApp(mkLoopDeps(taskStore)).request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'p', cwd: '/cwd' }),
    });
    expect(res.status).toBe(201);
    expect(launchTask).toHaveBeenCalledTimes(1);
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
        actor: { source: 'api', actorId: 'unattributed' },
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

  test('accepts a client signalId and stores it on the pending signal (issue #1541)', async () => {
    const taskStore = new TaskStore();
    const app = mkApp(mkLoopDeps(taskStore));
    const task = taskStore.createTask('Ship it', '/repo');
    const res = await app.request(`/api/tasks/${task.id}/signal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'completion_ready', signalId: 'sig-abc', note: 'done' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.signal.signalId).toBe('sig-abc');
    expect(taskStore.getPendingSignal(task.id)?.signalId).toBe('sig-abc');
  });

  test('replays the same signalId as a pure no-op without re-firing outcome hooks', async () => {
    const taskStore = new TaskStore();
    const onTaskOutcome = vi.fn();
    const broadcastToAll = vi.fn();
    const app = mkApp({ ...mkLoopDeps(taskStore), onTaskOutcome, broadcastToAll });
    const task = taskStore.createTask('Ship it', '/repo');

    const first = await app.request(`/api/tasks/${task.id}/signal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'completion_ready', signalId: 'sig-1', note: 'first' }),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    const raisedAt = firstBody.signal.raisedAt as string;
    expect(onTaskOutcome).toHaveBeenCalledTimes(1);
    const broadcastsAfterFirst = broadcastToAll.mock.calls.length;

    const second = await app.request(`/api/tasks/${task.id}/signal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'completion_ready', signalId: 'sig-1', note: 'replay' }),
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.idempotentReplay).toBe(true);
    expect(secondBody.signal.raisedAt).toBe(raisedAt);
    expect(onTaskOutcome).toHaveBeenCalledTimes(1);
    // Pure replay must not re-broadcast.
    expect(broadcastToAll.mock.calls.length).toBe(broadcastsAfterFirst);
  });

  test('rejects an empty or oversized signalId', async () => {
    const taskStore = new TaskStore();
    const app = mkApp(mkLoopDeps(taskStore));
    const task = taskStore.createTask('Ship it', '/repo');

    const empty = await app.request(`/api/tasks/${task.id}/signal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'completion_ready', signalId: '   ' }),
    });
    expect(empty.status).toBe(400);

    const oversized = await app.request(`/api/tasks/${task.id}/signal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'completion_ready', signalId: 'x'.repeat(201) }),
    });
    expect(oversized.status).toBe(400);
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

    test('reports the configured auto-close delay via getAutoCloseCompletionReadyDelayMs', async () => {
      const taskStore = new TaskStore();
      const id = startActiveTask(taskStore, { autoCloseOnSignal: true });
      const deps = mkAutoCloseDeps(taskStore);
      // Wire the live getter the way index.ts does (settings default 30m → ms).
      (deps as { getAutoCloseCompletionReadyDelayMs?: () => number }).getAutoCloseCompletionReadyDelayMs =
        () => 45 * 60 * 1000;

      const res = await mkApp(deps).request(`/api/tasks/${id}/signal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'completion_ready' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.autoCloseScheduled).toBe(true);
      // The configured value wins over the DEFAULT_STALE... fallback.
      expect(body.autoCloseAfterMs).toBe(45 * 60 * 1000);
      expect(body.autoCloseAfterMs).not.toBe(DEFAULT_STALE_COMPLETION_READY_THRESHOLD_MS);
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

  describe('lesson-decision gate (issue #1538)', () => {
    let kookrDir: string;

    beforeEach(() => {
      kookrDir = mkdtempSync(join(tmpdir(), 'kookr-lesson-gate-'));
      mkdirSync(join(kookrDir, 'hooks'), { recursive: true });
    });

    afterEach(() => {
      rmSync(kookrDir, { recursive: true, force: true });
      delete process.env.KOOKR_LESSON_DECISION_GATE;
    });

    function seedSessionWithHook(
      taskStore: TaskStore,
      command: string,
      tmuxSession = 'kookr-lesson-gate',
    ): string {
      const task = taskStore.createTask({ prompt: 'Ship it', cwd: '/repo' });
      taskStore.addSession(task.id, {
        tmuxSession,
        agentType: 'claude-code',
        cwd: '/repo',
        createdAt: new Date(),
      });
      writeFileSync(
        join(kookrDir, 'hooks', `${tmuxSession}.jsonl`),
        `${JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command },
        })}\n`,
        'utf8',
      );
      return task.id;
    }

    test('rejects completion_ready when sessions exist but no lesson decision', async () => {
      const taskStore = new TaskStore();
      const id = seedSessionWithHook(taskStore, 'ls -la');
      const deps = { ...mkLoopDeps(taskStore), kookrDir };

      const res = await mkApp(deps).request(`/api/tasks/${id}/signal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'completion_ready' }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('lesson_decision_required');
      expect(body.decision).toBe('no-kb-activity');
      expect(body.hint).toMatch(/kb remember/);
      expect(taskStore.getPendingSignal(id)).toBeUndefined();
    });

    test('allows completion_ready after a kb remember lesson write', async () => {
      const taskStore = new TaskStore();
      const id = seedSessionWithHook(
        taskStore,
        'kb remember --kb=agent-task-lessons --title="x" --stdin --yes',
      );
      const deps = { ...mkLoopDeps(taskStore), kookrDir };

      const res = await mkApp(deps).request(`/api/tasks/${id}/signal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'completion_ready', note: 'done' }),
      });

      expect(res.status).toBe(200);
      expect(taskStore.getPendingSignal(id)?.kind).toBe('completion_ready');
    });

    test('allows completion_ready after an explicit skip marker', async () => {
      const taskStore = new TaskStore();
      const id = seedSessionWithHook(
        taskStore,
        "printf 'No generic KB lesson: %s\\n' 'purely mechanical rename'",
      );
      const deps = { ...mkLoopDeps(taskStore), kookrDir };

      const res = await mkApp(deps).request(`/api/tasks/${id}/signal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'completion_ready' }),
      });

      expect(res.status).toBe(200);
      expect(taskStore.getPendingSignal(id)?.kind).toBe('completion_ready');
    });

    test('kill-switch KOOKR_LESSON_DECISION_GATE=off bypasses the gate', async () => {
      process.env.KOOKR_LESSON_DECISION_GATE = 'off';
      const taskStore = new TaskStore();
      const id = seedSessionWithHook(taskStore, 'ls -la');
      const deps = { ...mkLoopDeps(taskStore), kookrDir };

      const res = await mkApp(deps).request(`/api/tasks/${id}/signal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'completion_ready' }),
      });

      expect(res.status).toBe(200);
      expect(taskStore.getPendingSignal(id)?.kind).toBe('completion_ready');
    });
  });
});

describe('POST /api/tasks/abort (issue #1325)', () => {
  function mkAbortDeps(
    taskStore: TaskStore,
    overrides: Partial<TaskRouteDeps> = {},
  ): { deps: TaskRouteDeps; stop: ReturnType<typeof vi.fn> } {
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
      ...overrides,
    } as unknown as TaskRouteDeps;
    return { deps, stop };
  }

  function addLiveSession(taskStore: TaskStore, taskId: string, tmuxSession: string): void {
    taskStore.addSession(taskId, {
      tmuxSession,
      agentType: 'claude-code',
      cwd: '/repo-wt',
      createdAt: new Date(),
    });
  }

  async function postAbort(app: Hono, body: unknown) {
    return app.request('/api/tasks/abort', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  test('aborts a mix of live, terminal, and missing tasks and reports each', async () => {
    const taskStore = new TaskStore();
    const live = taskStore.createTask('live', '/repo');
    addLiveSession(taskStore, live.id, 'kookr-live');
    const done = taskStore.createTask('done', '/repo');
    taskStore.startTask(done.id);
    taskStore.completeTask(done.id);
    const { deps, stop } = mkAbortDeps(taskStore);

    const res = await postAbort(mkApp(deps), {
      taskIds: [live.id, done.id, 'missing'],
      reason: 'mass shutdown',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      results: Array<{ taskId: string; outcome: string; status?: string }>;
      summary: Record<string, number>;
    };
    expect(body.summary).toEqual({ total: 3, aborted: 1, already_terminal: 1, not_found: 1, failed: 0 });
    expect(body.results).toEqual([
      { taskId: live.id, outcome: 'aborted', status: 'cancelled' },
      { taskId: done.id, outcome: 'already_terminal', status: 'completed' },
      { taskId: 'missing', outcome: 'not_found' },
    ]);
    expect(taskStore.getTask(live.id)!.status).toBe('cancelled');
    expect(stop).toHaveBeenCalledWith('kookr-live');
  });

  test('is idempotent across retries', async () => {
    const taskStore = new TaskStore();
    const live = taskStore.createTask('live', '/repo');
    addLiveSession(taskStore, live.id, 'kookr-live');
    const { deps, stop } = mkAbortDeps(taskStore);
    const app = mkApp(deps);

    const first = await (await postAbort(app, { taskIds: [live.id] })).json();
    expect(first.summary).toMatchObject({ aborted: 1 });
    expect(stop).toHaveBeenCalledTimes(1);

    const second = await (await postAbort(app, { taskIds: [live.id] })).json();
    expect(second.summary).toEqual({ total: 1, aborted: 0, already_terminal: 1, not_found: 0, failed: 0 });
    expect(second.results).toEqual([{ taskId: live.id, outcome: 'already_terminal', status: 'cancelled' }]);
    // No second interruption.
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test('writes an API-actor batch-abort audit row only when something aborts', async () => {
    const kookrDir = mkdtempSync(join(tmpdir(), 'kookr-api-abort-audit-'));
    try {
      const taskStore = new TaskStore();
      const live = taskStore.createTask('live', '/repo');
      addLiveSession(taskStore, live.id, 'kookr-live');
      const { deps } = mkAbortDeps(taskStore, { kookrDir });
      const app = mkApp(deps);

      await postAbort(app, { taskIds: [live.id], reason: 'shutdown' });
      const row = JSON.parse(readFileSync(join(kookrDir, 'audit.jsonl'), 'utf-8').trim()) as Record<string, unknown>;
      expect(row).toEqual(expect.objectContaining({
        type: 'task.batchAbort',
        actor: { source: 'api', actorId: 'unattributed' },
        reason: 'shutdown',
        count: 1,
        abortedTaskIds: [live.id],
      }));

      // A retry aborts nothing and must not append a second row.
      await postAbort(app, { taskIds: [live.id], reason: 'shutdown' });
      const lines = readFileSync(join(kookrDir, 'audit.jsonl'), 'utf-8').trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
    } finally {
      rmSync(kookrDir, { recursive: true, force: true });
    }
  });

  test('rejects a non-array taskIds body', async () => {
    const res = await postAbort(mkApp(mkAbortDeps(new TaskStore()).deps), { taskIds: 'nope' });
    expect(res.status).toBe(400);
  });

  test('rejects non-string taskIds entries', async () => {
    const res = await postAbort(mkApp(mkAbortDeps(new TaskStore()).deps), { taskIds: ['ok', 42] });
    expect(res.status).toBe(400);
  });

  test('rejects a non-string reason', async () => {
    const res = await postAbort(mkApp(mkAbortDeps(new TaskStore()).deps), { taskIds: [], reason: 7 });
    expect(res.status).toBe(400);
  });

  test('rejects invalid JSON', async () => {
    const res = await mkApp(mkAbortDeps(new TaskStore()).deps).request('/api/tasks/abort', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  test('rejects a non-object JSON body (null) with 400, not 500', async () => {
    const res = await postAbort(mkApp(mkAbortDeps(new TaskStore()).deps), null);
    expect(res.status).toBe(400);
  });

  test('rejects a batch larger than the cap with 400', async () => {
    const taskIds = Array.from({ length: 501 }, (_, i) => `task-${i}`);
    const res = await postAbort(mkApp(mkAbortDeps(new TaskStore()).deps), { taskIds });
    expect(res.status).toBe(400);
  });

  test('drops remote-owned SharedTask IDs and aborts the rest', async () => {
    const taskStore = new TaskStore();
    const live = taskStore.createTask('live', '/repo');
    addLiveSession(taskStore, live.id, 'kookr-live');
    const { deps } = mkAbortDeps(taskStore);

    const res = await postAbort(mkApp(deps), { taskIds: [live.id, 'shared:abc123'] });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      results: Array<{ taskId: string; outcome: string }>;
      summary: Record<string, number>;
    };
    // The shared id is filtered before processing — never counted, never reported.
    expect(body.summary).toEqual({ total: 1, aborted: 1, already_terminal: 0, not_found: 0, failed: 0 });
    expect(body.results).toEqual([{ taskId: live.id, outcome: 'aborted', status: 'cancelled' }]);
    expect(taskStore.getTask(live.id)!.status).toBe('cancelled');
  });
});

describe('X-Kookr-Actor attribution (issue #1526 Phase B)', () => {
  function mkAttributionDeps(taskStore: TaskStore, kookrDir: string): TaskRouteDeps {
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
      kookrDir,
    } as unknown as TaskRouteDeps;
  }

  test('a supplied header flows into the batch-abort audit row actor', async () => {
    const kookrDir = mkdtempSync(join(tmpdir(), 'kookr-actor-abort-'));
    try {
      const taskStore = new TaskStore();
      const live = taskStore.createTask('live', '/repo');
      taskStore.addSession(live.id, { tmuxSession: 'kookr-live', agentType: 'claude-code', cwd: '/repo-wt', createdAt: new Date() });

      const res = await mkApp(mkAttributionDeps(taskStore, kookrDir)).request('/api/tasks/abort', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-kookr-actor': 'lucy-supervisor' },
        body: JSON.stringify({ taskIds: [live.id] }),
      });
      expect(res.status).toBe(200);

      const row = JSON.parse(readFileSync(join(kookrDir, 'audit.jsonl'), 'utf-8').trim()) as { actor: unknown };
      expect(row.actor).toEqual({ source: 'api', actorId: 'lucy-supervisor' });
    } finally {
      rmSync(kookrDir, { recursive: true, force: true });
    }
  });

  test('a supplied header flows into the complete audit row actor', async () => {
    const kookrDir = mkdtempSync(join(tmpdir(), 'kookr-actor-complete-'));
    try {
      const taskStore = new TaskStore();
      const task = taskStore.createTask('Complete me', '/repo');
      taskStore.addSession(task.id, { tmuxSession: 'kookr-live', agentType: 'claude-code', cwd: '/repo-wt', createdAt: new Date() });

      const res = await mkApp(mkAttributionDeps(taskStore, kookrDir)).request(`/api/tasks/${task.id}/complete`, {
        method: 'POST',
        headers: { 'x-kookr-actor': 'lucy-supervisor' },
      });
      expect(res.status).toBe(200);

      const row = JSON.parse(readFileSync(join(kookrDir, 'audit.jsonl'), 'utf-8').trim()) as { actor: unknown };
      expect(row.actor).toEqual({ source: 'api', actorId: 'lucy-supervisor' });
    } finally {
      rmSync(kookrDir, { recursive: true, force: true });
    }
  });

  test('an omitted header records the actor as unattributed', async () => {
    const kookrDir = mkdtempSync(join(tmpdir(), 'kookr-actor-missing-'));
    try {
      const taskStore = new TaskStore();
      const task = taskStore.createTask('Complete me', '/repo');
      taskStore.addSession(task.id, { tmuxSession: 'kookr-live', agentType: 'claude-code', cwd: '/repo-wt', createdAt: new Date() });

      const res = await mkApp(mkAttributionDeps(taskStore, kookrDir)).request(`/api/tasks/${task.id}/complete`, { method: 'POST' });
      expect(res.status).toBe(200);

      const row = JSON.parse(readFileSync(join(kookrDir, 'audit.jsonl'), 'utf-8').trim()) as { actor: unknown };
      expect(row.actor).toEqual({ source: 'api', actorId: 'unattributed' });
    } finally {
      rmSync(kookrDir, { recursive: true, force: true });
    }
  });
});

describe('KOOKR_SUPERVISOR_TOKEN gate (issue #1526 Phase B)', () => {
  const originalToken = process.env[SUPERVISOR_TOKEN_ENV];

  afterEach(() => {
    if (originalToken === undefined) delete process.env[SUPERVISOR_TOKEN_ENV];
    else process.env[SUPERVISOR_TOKEN_ENV] = originalToken;
  });

  function mkGateDeps(taskStore: TaskStore): TaskRouteDeps {
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

  function addLiveSession(taskStore: TaskStore, taskId: string, tmuxSession = 'kookr-live'): void {
    taskStore.addSession(taskId, {
      tmuxSession,
      agentType: 'claude-code',
      cwd: '/repo-wt',
      createdAt: new Date(),
    });
  }

  test('complete: env unset stays open (200), unchanged from today', async () => {
    delete process.env[SUPERVISOR_TOKEN_ENV];
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Open by default', '/repo');
    addLiveSession(taskStore, task.id);
    const res = await mkApp(mkGateDeps(taskStore)).request(`/api/tasks/${task.id}/complete`, { method: 'POST' });
    expect(res.status).toBe(200);
  });

  test('complete: env set rejects missing/wrong bearer with 401, accepts correct with 200', async () => {
    process.env[SUPERVISOR_TOKEN_ENV] = 'sup3r-secret';
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Gated', '/repo');
    addLiveSession(taskStore, task.id);
    const app = mkApp(mkGateDeps(taskStore));

    const noAuth = await app.request(`/api/tasks/${task.id}/complete`, { method: 'POST' });
    expect(noAuth.status).toBe(401);
    expect(await noAuth.json()).toEqual({ error: 'supervisor-unauthorized' });

    const wrongAuth = await app.request(`/api/tasks/${task.id}/complete`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong' },
    });
    expect(wrongAuth.status).toBe(401);

    const rightAuth = await app.request(`/api/tasks/${task.id}/complete`, {
      method: 'POST',
      headers: { authorization: 'Bearer sup3r-secret' },
    });
    expect(rightAuth.status).toBe(200);
  });

  test('abort: gated the same way', async () => {
    process.env[SUPERVISOR_TOKEN_ENV] = 'sup3r-secret';
    const app = mkApp(mkGateDeps(new TaskStore()));

    const noAuth = await app.request('/api/tasks/abort', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskIds: [] }),
    });
    expect(noAuth.status).toBe(401);

    const rightAuth = await app.request('/api/tasks/abort', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sup3r-secret' },
      body: JSON.stringify({ taskIds: [] }),
    });
    expect(rightAuth.status).toBe(200);
  });

  test('ack-all: gated the same way', async () => {
    process.env[SUPERVISOR_TOKEN_ENV] = 'sup3r-secret';
    const app = mkApp(mkGateDeps(new TaskStore()));

    const noAuth = await app.request('/api/tasks/completion-ready/ack-all', { method: 'POST' });
    expect(noAuth.status).toBe(401);

    const rightAuth = await app.request('/api/tasks/completion-ready/ack-all', {
      method: 'POST',
      headers: { authorization: 'Bearer sup3r-secret' },
    });
    expect(rightAuth.status).toBe(200);
  });

  test('GETs are unaffected by the token either way', async () => {
    process.env[SUPERVISOR_TOKEN_ENV] = 'sup3r-secret';
    const openRes = await mkApp(mkGateDeps(new TaskStore())).request('/api/tasks/completion-ready/stale');
    expect(openRes.status).toBe(200);

    delete process.env[SUPERVISOR_TOKEN_ENV];
    const stillOpenRes = await mkApp(mkGateDeps(new TaskStore())).request('/api/tasks/completion-ready/stale');
    expect(stillOpenRes.status).toBe(200);
  });
});

describe('POST /api/tasks/completion-ready/ack-all (issue #1526 Phase B)', () => {
  function mkAckAllDeps(taskStore: TaskStore, overrides: Partial<TaskRouteDeps> = {}): TaskRouteDeps {
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
      ...overrides,
    } as unknown as TaskRouteDeps;
  }

  function makeStaleTasks(taskStore: TaskStore): { autoCloseId: string; askFirstId: string } {
    const autoClose = taskStore.createTask({
      prompt: 'Opted in',
      cwd: '/repo',
      autoCloseOnSignal: true,
    });
    const askFirst = taskStore.createTask({
      prompt: 'Ask first',
      cwd: '/repo',
      deliveryAuthorization: 'ask-first',
    });
    for (const task of [autoClose, askFirst]) {
      taskStore.addSession(task.id, {
        tmuxSession: `kookr-${task.id}`,
        agentType: 'claude-code',
        cwd: '/repo-wt',
        createdAt: new Date(Date.now() - 3 * 60 * 60_000),
      });
      taskStore.setPendingSignal(task.id, {
        kind: 'completion_ready',
        raisedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      });
    }
    return { autoCloseId: autoClose.id, askFirstId: askFirst.id };
  }

  test('default scope completes only canAutoClose tasks, per-id results reported', async () => {
    const taskStore = new TaskStore();
    const { autoCloseId, askFirstId } = makeStaleTasks(taskStore);

    const res = await mkApp(mkAckAllDeps(taskStore)).request('/api/tasks/completion-ready/ack-all', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      force: boolean;
      results: Array<{ taskId: string; outcome: string }>;
      summary: Record<string, number>;
    };
    expect(body.force).toBe(false);
    expect(body.summary).toMatchObject({ matched: 1, completed: 1 });
    expect(body.results).toEqual([{ taskId: autoCloseId, outcome: 'completed', status: 'completed' }]);
    expect(taskStore.getTask(autoCloseId)!.status).toBe('completed');
    expect(taskStore.getTask(askFirstId)!.status).toBe('inProgress');
  });

  test('{ force: true } completes every stale task regardless of policy', async () => {
    const taskStore = new TaskStore();
    const { autoCloseId, askFirstId } = makeStaleTasks(taskStore);

    const res = await mkApp(mkAckAllDeps(taskStore)).request('/api/tasks/completion-ready/ack-all', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { force: boolean; summary: Record<string, number> };
    expect(body.force).toBe(true);
    expect(body.summary).toMatchObject({ matched: 2, completed: 2 });
    expect(taskStore.getTask(autoCloseId)!.status).toBe('completed');
    expect(taskStore.getTask(askFirstId)!.status).toBe('completed');
  });

  test('an empty or omitted body defaults to force: false without erroring', async () => {
    const taskStore = new TaskStore();
    makeStaleTasks(taskStore);

    const res = await mkApp(mkAckAllDeps(taskStore)).request('/api/tasks/completion-ready/ack-all', { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).force).toBe(false);
  });

  test('rejects a non-boolean force value', async () => {
    const res = await mkApp(mkAckAllDeps(new TaskStore())).request('/api/tasks/completion-ready/ack-all', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: 'yes' }),
    });
    expect(res.status).toBe(400);
  });

  test('writes an attributed audit row per completed task', async () => {
    const kookrDir = mkdtempSync(join(tmpdir(), 'kookr-ack-all-audit-'));
    try {
      const taskStore = new TaskStore();
      const { autoCloseId } = makeStaleTasks(taskStore);

      const res = await mkApp(mkAckAllDeps(taskStore, { kookrDir })).request('/api/tasks/completion-ready/ack-all', {
        method: 'POST',
        headers: { 'x-kookr-actor': 'lucy-supervisor' },
      });
      expect(res.status).toBe(200);

      const rows = readFileSync(join(kookrDir, 'audit.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
      const types = rows.map((r) => r.type).sort();
      expect(types).toEqual(['task.complete', 'task.completionReadyAckAll']);
      for (const row of rows) {
        expect(row.actor).toEqual({ source: 'api', actorId: 'lucy-supervisor' });
      }
      const summaryRow = rows.find((r) => r.type === 'task.completionReadyAckAll');
      expect(summaryRow.results).toEqual([{ taskId: autoCloseId, outcome: 'completed', status: 'completed' }]);
    } finally {
      rmSync(kookrDir, { recursive: true, force: true });
    }
  });
});

describe('GET /api/tasks/:id/tail (rfc-task-tail-retrieval)', () => {
  test('returns live capture for in-progress sessions', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Running work', '/repo');
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-live-tail',
      agentType: 'claude-code',
      cwd: '/repo-wt',
      createdAt: new Date(),
      lastStatus: 'working',
    });

    const captureDisplay = vi.fn(async () => 'line1\nline2\nline3\n');
    const deps = {
      ...mkLoopDeps(taskStore),
      adapter: { captureDisplay, stop: vi.fn(async () => {}) } as never,
    };
    const res = await mkApp(deps).request(`/api/tasks/${task.id}/tail?lines=2`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('live');
    expect(body.shownLines).toBe(2);
    expect(body.text).toBe('line2\nline3');
    expect(captureDisplay).toHaveBeenCalledWith('kookr-live-tail');
  });

  test('returns persisted tail for completed tasks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-tail-route-'));
    try {
      const { TaskTailStore } = await import('../../core/task-tail-store.js');
      const store = new TaskTailStore({ dir, retentionDays: 7, maxBytes: 4096 });
      const taskStore = new TaskStore();
      const task = taskStore.createTask('Done work', '/repo');
      taskStore.addSession(task.id, {
        tmuxSession: 'kookr-done',
        agentType: 'claude-code',
        cwd: '/repo-wt',
        createdAt: new Date(),
        lastStatus: 'completed',
      });
      taskStore.completeTask(task.id);
      await store.save({
        taskId: task.id,
        sessionId: 'kookr-done',
        text: 'done line A\ndone line B\ndone line C\n',
      });

      const deps = {
        ...mkLoopDeps(taskStore),
        taskTailStore: store,
        adapter: { captureDisplay: vi.fn(async () => { throw new Error('dead'); }), stop: vi.fn() } as never,
      };
      const res = await mkApp(deps).request(`/api/tasks/${task.id}/tail?lines=2`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.source).toBe('persisted');
      expect(body.sessionId).toBe('kookr-done');
      expect(body.text).toBe('done line B\ndone line C');
      expect(body.retentionExpiresAt).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('404 when no live or persisted tail', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Empty', '/repo');
    // open -> inProgress -> completed (valid lifecycle)
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-empty',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date(),
      lastStatus: 'completed',
    });
    taskStore.completeTask(task.id);
    const res = await mkApp(mkLoopDeps(taskStore)).request(`/api/tasks/${task.id}/tail`);
    expect(res.status).toBe(404);
  });

  test('400 on invalid lines', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('x', '/repo');
    const res = await mkApp(mkLoopDeps(taskStore)).request(`/api/tasks/${task.id}/tail?lines=abc`);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/tasks list filters & pagination (issue #1526 Phase C / C2)', () => {
  function seedListStore(): { taskStore: TaskStore; ids: string[] } {
    const taskStore = new TaskStore();
    const ids: string[] = [];
    // t0: completed, old updatedAt
    const t0 = taskStore.createTask('First task prompt', '/repo');
    taskStore.addSession(t0.id, { tmuxSession: 'list-0', agentType: 'claude-code', cwd: '/repo', createdAt: new Date() });
    taskStore.completeTask(t0.id);
    taskStore.getTaskForMutation(t0.id)!.updatedAt = new Date('2026-07-01T00:00:00Z');
    ids.push(t0.id);
    // t1: inProgress, recent updatedAt
    const t1 = taskStore.createTask('Second task prompt', '/repo');
    taskStore.addSession(t1.id, { tmuxSession: 'list-1', agentType: 'claude-code', cwd: '/repo', createdAt: new Date() });
    taskStore.getTaskForMutation(t1.id)!.updatedAt = new Date('2026-07-24T00:00:00Z');
    ids.push(t1.id);
    // t2: completed, recent updatedAt
    const t2 = taskStore.createTask('Third task prompt', '/repo');
    taskStore.addSession(t2.id, { tmuxSession: 'list-2', agentType: 'claude-code', cwd: '/repo', createdAt: new Date() });
    taskStore.completeTask(t2.id);
    taskStore.getTaskForMutation(t2.id)!.updatedAt = new Date('2026-07-25T00:00:00Z');
    ids.push(t2.id);
    return { taskStore, ids };
  }

  test('no params: response is byte-identical to the unfiltered listing and carries no X-Total-Count', async () => {
    const { taskStore } = seedListStore();
    const app = mkApp(mkLoopDeps(taskStore));
    const res = await app.request('/api/tasks');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Total-Count')).toBeNull();
    const body = await res.text();

    // Same store, same route, second request — deterministic and full.
    const again = await (await app.request('/api/tasks')).text();
    expect(body).toBe(again);
    expect((JSON.parse(body) as unknown[]).length).toBe(3);
    // Full view still ships prompts (unchanged default shape).
    expect(body).toContain('First task prompt');
  });

  test('status filter keeps only matching tasks, preserving order', async () => {
    const { taskStore, ids } = seedListStore();
    const app = mkApp(mkLoopDeps(taskStore));
    const rows = await (await app.request('/api/tasks?status=completed')).json();
    expect(rows.map((r: { id: string }) => r.id)).toEqual([ids[0], ids[2]]);
  });

  test('since filter keeps tasks with updatedAt >= since', async () => {
    const { taskStore, ids } = seedListStore();
    const app = mkApp(mkLoopDeps(taskStore));
    const rows = await (await app.request('/api/tasks?since=2026-07-20T00:00:00Z')).json();
    expect(rows.map((r: { id: string }) => r.id)).toEqual([ids[1], ids[2]]);
  });

  test('limit/offset slice the listing and expose X-Total-Count', async () => {
    const { taskStore, ids } = seedListStore();
    const app = mkApp(mkLoopDeps(taskStore));
    const res = await app.request('/api/tasks?limit=1&offset=1');
    expect(res.headers.get('X-Total-Count')).toBe('3');
    const rows = await res.json();
    expect(rows.map((r: { id: string }) => r.id)).toEqual([ids[1]]);
  });

  test('filters combine (status + since + limit) and count reflects the filtered set', async () => {
    const { taskStore, ids } = seedListStore();
    const app = mkApp(mkLoopDeps(taskStore));
    const res = await app.request('/api/tasks?status=completed&since=2026-07-20T00:00:00Z&limit=5');
    expect(res.headers.get('X-Total-Count')).toBe('1');
    const rows = await res.json();
    expect(rows.map((r: { id: string }) => r.id)).toEqual([ids[2]]);
  });

  test('filters apply to the compact view too, and compact=true aliases view=compact', async () => {
    const { taskStore, ids } = seedListStore();
    const app = mkApp(mkLoopDeps(taskStore));
    const rows = await (await app.request('/api/tasks?compact=true&status=completed')).json();
    expect(rows.map((r: { id: string }) => r.id)).toEqual([ids[0], ids[2]]);
    // Compact rows omit the heavy prompt body. (A substring check no longer
    // works: tasks are named from birth off the prompt's first line — issue
    // #1554 — so the `name` field legitimately echoes it; assert the `prompt`
    // key itself is absent.)
    expect(rows.every((r: Record<string, unknown>) => !('prompt' in r))).toBe(true);
  });

  test('malformed params return 400 rather than the full listing', async () => {
    const { taskStore } = seedListStore();
    const app = mkApp(mkLoopDeps(taskStore));
    for (const qs of ['limit=0', 'limit=abc', 'offset=-1', 'status=bogus', 'since=not-a-date']) {
      const res = await app.request(`/api/tasks?${qs}`);
      expect(res.status, qs).toBe(400);
      const body = await res.json();
      expect(body.error, qs).toBeDefined();
    }
  });
});

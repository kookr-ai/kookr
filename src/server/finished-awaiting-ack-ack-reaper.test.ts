import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Task } from '../core/tasks.js';
import { aSession, aTask } from '../core/__fixtures__/task-builders.js';
import {
  reapAwaitingPollFinishedAwaitingAckTasks,
  runFinishedAwaitingAckReapMaintenance,
  FinishedAwaitingAckAckReaperMetrics,
} from './finished-awaiting-ack-ack-reaper.js';
import { ReapWarningCoordinator } from '../core/reap-warning-coordinator.js';
import type { LifecycleDeps } from './agent-lifecycle.js';

// completeTask fires-and-forgets a worktree cleanup + reflect reclaim; mock both.
const mockCleanupTaskWorktrees = vi.fn().mockResolvedValue(undefined);
vi.mock('../adapters/git-worktree.js', () => ({
  cleanupTaskWorktrees: (...args: unknown[]) => mockCleanupTaskWorktrees(...args),
}));
vi.mock('./use-cases/request-task-reflect.js', () => ({
  removeReflectWorktree: vi.fn().mockResolvedValue(true),
}));

const NOW = new Date('2026-08-07T12:00:00.000Z');
const DEADLINE_MS = 5 * 60_000;
const GRACE_MS = 60_000;

function makeFaaTask(overrides: Partial<Task> = {}): Task {
  return aTask({
    id: 'task-1',
    status: 'inProgress',
    sessions: [aSession({ tmuxSession: 'kookr-abc', lastStatus: 'inProgress' })],
    pendingSignal: {
      kind: 'completion_ready',
      // Past the 5m deadline by a minute.
      raisedAt: new Date(NOW.getTime() - DEADLINE_MS - 60_000).toISOString(),
    },
    ...overrides,
  });
}

function makeMockTaskStore(tasks: Task[]) {
  return {
    listTasks: vi.fn(() => tasks),
    getTask: vi.fn((id: string) => tasks.find((t) => t.id === id)),
    completeTask: vi.fn(),
    updateSession: vi.fn(),
    updateSessionWorktreeHealth: vi.fn(),
    setCriteriaVerdict: vi.fn(),
    clearPendingSignal: vi.fn(),
  } as any;
}

function makeLifecycleDeps(taskStore: any, overrides: Partial<LifecycleDeps> = {}): LifecycleDeps {
  return {
    adapter: { stop: vi.fn().mockResolvedValue(undefined) },
    monitor: { unregisterAgent: vi.fn() },
    taskStore,
    interactionLog: { append: vi.fn().mockResolvedValue(undefined) } as any,
    hookWatcher: { stop: vi.fn() },
    watchdog: { unregisterAgent: vi.fn() },
    queue: { purgeTask: vi.fn() },
    issueClaimRegistry: { safeReleaseAllFor: vi.fn().mockReturnValue([]) },
    onTaskOutcome: vi.fn(),
    ...overrides,
  };
}

async function readAuditRows(auditLogPath: string): Promise<any[]> {
  const raw = await readFile(auditLogPath, 'utf8').catch(() => '');
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('reapAwaitingPollFinishedAwaitingAckTasks (issue #2170)', () => {
  let auditDir: string;
  let auditLogPath: string;

  beforeEach(async () => {
    auditDir = await mkdtemp(join(tmpdir(), 'faa-ack-reaper-'));
    auditLogPath = join(auditDir, 'audit.jsonl');
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await rm(auditDir, { recursive: true, force: true });
  });

  function baseDeps(taskStore: any, coordinator: ReapWarningCoordinator, extra: any = {}) {
    return {
      taskStore,
      coordinator,
      lifecycleDeps: makeLifecycleDeps(taskStore),
      auditLogPath,
      isHoldingOpenPr: () => false as const,
      getEnabled: () => true,
      getDeadlineMs: () => DEADLINE_MS,
      getGraceMs: () => GRACE_MS,
      ...extra,
    };
  }

  it('warns first (grace phase), does NOT close, and writes a warn audit row', async () => {
    const task = makeFaaTask();
    const taskStore = makeMockTaskStore([task]);
    const coordinator = new ReapWarningCoordinator();
    const metrics = new FinishedAwaitingAckAckReaperMetrics();

    const result = await reapAwaitingPollFinishedAwaitingAckTasks(
      baseDeps(taskStore, coordinator, { metrics }),
      { now: NOW },
    );

    expect(result.warnedTaskIds).toEqual(['task-1']);
    expect(result.reapedTaskIds).toEqual([]);
    expect(taskStore.completeTask).not.toHaveBeenCalled();
    expect(coordinator.getWarning('task-1')).toBeDefined();
    expect(metrics.getSnapshot().warnedTotal).toBe(1);

    const rows = await readAuditRows(auditLogPath);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('task.finishedAwaitingAckReapWarned');
    expect(rows[0].actor).toBe('system:finished-awaiting-ack-ack-reaper');
  });

  it('reaps once the grace deadline elapses (second pass) with a reap audit row + interaction reason', async () => {
    const task = makeFaaTask();
    const taskStore = makeMockTaskStore([task]);
    const coordinator = new ReapWarningCoordinator();
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const metrics = new FinishedAwaitingAckAckReaperMetrics();

    // Pass 1 warns.
    await reapAwaitingPollFinishedAwaitingAckTasks(
      { ...baseDeps(taskStore, coordinator, { metrics }), lifecycleDeps },
      { now: NOW },
    );
    expect(taskStore.completeTask).not.toHaveBeenCalled();

    // Pass 2, after the grace window elapses, closes.
    const later = new Date(NOW.getTime() + GRACE_MS + 1_000);
    const broadcastToAll = vi.fn();
    const result = await reapAwaitingPollFinishedAwaitingAckTasks(
      { ...baseDeps(taskStore, coordinator, { metrics }), lifecycleDeps, broadcastToAll },
      { now: later },
    );

    expect(result.reapedTaskIds).toEqual(['task-1']);
    // Reap emits one summary alert (not per-task).
    expect(broadcastToAll).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'alert',
        severity: 'warning',
        summary: expect.stringContaining('Reaped 1 finishedAwaitingAck task(s) on the ack path'),
      }),
    );
    expect(taskStore.completeTask).toHaveBeenCalledWith('task-1');
    expect(taskStore.clearPendingSignal).toHaveBeenCalledWith('task-1');
    // Warning consumed on reap.
    expect(coordinator.getWarning('task-1')).toBeUndefined();
    expect(metrics.getSnapshot().reapedTotal).toBe(1);

    expect(lifecycleDeps.interactionLog!.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'task_completed', reason: 'finished_awaiting_ack_ack_reap' }),
    );
    const rows = await readAuditRows(auditLogPath);
    const reapRow = rows.find((r) => r.type === 'task.finishedAwaitingAckReaped');
    expect(reapRow).toMatchObject({
      reason: 'finished_awaiting_ack_ack_reap',
      taskId: 'task-1',
      keptAliveCount: 0,
    });
  });

  it('is a no-op when disabled (kill switch) — the strict TTL backstop still owns the close', async () => {
    const task = makeFaaTask();
    const taskStore = makeMockTaskStore([task]);
    const coordinator = new ReapWarningCoordinator();

    const result = await reapAwaitingPollFinishedAwaitingAckTasks(
      baseDeps(taskStore, coordinator, { getEnabled: () => false }),
      { now: NOW },
    );

    expect(result).toEqual({ reapedTaskIds: [], warnedTaskIds: [], deferredTaskIds: [] });
    expect(coordinator.getWarning('task-1')).toBeUndefined();
    expect(taskStore.completeTask).not.toHaveBeenCalled();
  });

  it('never warns/reaps a task younger than the deadline', async () => {
    const fresh = makeFaaTask({
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - 60_000).toISOString(), // 1m < 5m
      },
    });
    const taskStore = makeMockTaskStore([fresh]);
    const coordinator = new ReapWarningCoordinator();

    const result = await reapAwaitingPollFinishedAwaitingAckTasks(
      baseDeps(taskStore, coordinator),
      { now: NOW },
    );
    expect(result.warnedTaskIds).toEqual([]);
    expect(coordinator.getWarning('task-1')).toBeUndefined();
  });

  it('honors the open-PR fail-safe: never warns/closes a task holding an open PR', async () => {
    const task = makeFaaTask();
    const taskStore = makeMockTaskStore([task]);
    const coordinator = new ReapWarningCoordinator();

    const result = await reapAwaitingPollFinishedAwaitingAckTasks(
      baseDeps(taskStore, coordinator, { isHoldingOpenPr: () => true }),
      { now: NOW },
    );
    expect(result.warnedTaskIds).toEqual([]);
    expect(result.reapedTaskIds).toEqual([]);
    expect(coordinator.getWarning('task-1')).toBeUndefined();
  });

  it('defers (does not close) when a session has a live turn (TOCTOU)', async () => {
    const task = makeFaaTask({
      sessions: [aSession({ tmuxSession: 'kookr-abc', lastStatus: 'inProgress', lastTurnState: 'running' })],
    });
    const taskStore = makeMockTaskStore([task]);
    const coordinator = new ReapWarningCoordinator();
    // Warm the warning so this pass would otherwise reap.
    coordinator.advance({
      taskId: 'task-1',
      agentId: 'kookr-abc',
      silentForMs: DEADLINE_MS,
      now: NOW.getTime() - GRACE_MS - 5_000,
      graceMs: GRACE_MS,
      present: false,
    });

    const result = await reapAwaitingPollFinishedAwaitingAckTasks(
      baseDeps(taskStore, coordinator),
      { now: NOW },
    );

    expect(result.deferredTaskIds).toEqual(['task-1']);
    expect(result.reapedTaskIds).toEqual([]);
    expect(taskStore.completeTask).not.toHaveBeenCalled();
  });

  it('defers (does not close) when the pane shows human-interactive markers (TOCTOU)', async () => {
    const task = makeFaaTask();
    const taskStore = makeMockTaskStore([task]);
    const coordinator = new ReapWarningCoordinator();
    // Warm the warning so this pass would otherwise reap.
    coordinator.advance({
      taskId: 'task-1',
      agentId: 'kookr-abc',
      silentForMs: DEADLINE_MS,
      now: NOW.getTime() - GRACE_MS - 5_000,
      graceMs: GRACE_MS,
      present: false,
    });

    const result = await reapAwaitingPollFinishedAwaitingAckTasks(
      baseDeps(taskStore, coordinator, {
        getTaskPaneText: async () => 'Some output\n❯\n',
      }),
      { now: NOW },
    );

    expect(result.deferredTaskIds).toEqual(['task-1']);
    expect(result.reapedTaskIds).toEqual([]);
    expect(taskStore.completeTask).not.toHaveBeenCalled();
  });

  it('holds the deadline while the operator has the task selected (presence auto-hold)', async () => {
    const task = makeFaaTask();
    const taskStore = makeMockTaskStore([task]);
    const coordinator = new ReapWarningCoordinator();

    // Pass 1 warns (present=true → deadline held forward from warn time).
    await reapAwaitingPollFinishedAwaitingAckTasks(
      baseDeps(taskStore, coordinator, { isTaskSelectedByAnyConnection: () => true }),
      { now: NOW },
    );

    // Pass 2 after the base grace window: presence keeps pushing the deadline,
    // so it must NOT reap yet.
    const later = new Date(NOW.getTime() + GRACE_MS + 1_000);
    const result = await reapAwaitingPollFinishedAwaitingAckTasks(
      baseDeps(taskStore, coordinator, { isTaskSelectedByAnyConnection: () => true }),
      { now: later },
    );
    expect(result.reapedTaskIds).toEqual([]);
    expect(coordinator.getWarning('task-1')?.heldByPresence).toBe(true);
  });

  it('an operator veto extends the deadline past the grace window', async () => {
    const task = makeFaaTask();
    const taskStore = makeMockTaskStore([task]);
    const coordinator = new ReapWarningCoordinator();

    await reapAwaitingPollFinishedAwaitingAckTasks(baseDeps(taskStore, coordinator), { now: NOW });
    // Operator clicks "Keep it alive".
    const veto = coordinator.veto('task-1', NOW.getTime());
    expect(veto.accepted).toBe(true);

    // Even after the original grace window, the veto extension keeps it alive.
    const later = new Date(NOW.getTime() + GRACE_MS + 1_000);
    const result = await reapAwaitingPollFinishedAwaitingAckTasks(
      baseDeps(taskStore, coordinator),
      { now: later },
    );
    expect(result.reapedTaskIds).toEqual([]);
    expect(coordinator.getWarning('task-1')?.keptAliveCount).toBe(1);
  });
});

describe('runFinishedAwaitingAckReapMaintenance (issue #2170)', () => {
  let auditDir: string;
  let auditLogPath: string;
  beforeEach(async () => {
    auditDir = await mkdtemp(join(tmpdir(), 'faa-ack-maint-'));
    auditLogPath = join(auditDir, 'audit.jsonl');
  });
  afterEach(async () => {
    await rm(auditDir, { recursive: true, force: true });
  });

  function warm(coordinator: ReapWarningCoordinator, now: Date): void {
    coordinator.advance({
      taskId: 'task-1',
      agentId: 'kookr-abc',
      silentForMs: DEADLINE_MS,
      now: now.getTime(),
      graceMs: GRACE_MS,
      present: false,
    });
  }

  it('clears the warning (recovered) the moment the task is acked / no longer FAA', async () => {
    const coordinator = new ReapWarningCoordinator();
    warm(coordinator, NOW);
    // Signal acked → still inProgress but no pendingSignal.
    const acked = makeFaaTask({ pendingSignal: undefined });
    const taskStore = makeMockTaskStore([acked]);

    const changed = await runFinishedAwaitingAckReapMaintenance(
      { coordinator, auditLogPath, getEnabled: () => true, getGraceMs: () => GRACE_MS },
      taskStore,
      () => NOW,
    );
    expect(changed).toBe(true);
    expect(coordinator.getWarning('task-1')).toBeUndefined();
    const rows = await readAuditRows(auditLogPath);
    expect(rows[0]).toMatchObject({
      type: 'task.finishedAwaitingAckReapWarningCleared',
      reason: 'recovered',
    });
  });

  it('clears the warning (gone) when the task left inProgress entirely', async () => {
    const coordinator = new ReapWarningCoordinator();
    warm(coordinator, NOW);
    const done = makeFaaTask({ status: 'completed' });
    const taskStore = makeMockTaskStore([done]);

    const changed = await runFinishedAwaitingAckReapMaintenance(
      { coordinator, auditLogPath, getEnabled: () => true, getGraceMs: () => GRACE_MS },
      taskStore,
      () => NOW,
    );
    expect(changed).toBe(true);
    expect(coordinator.getWarning('task-1')).toBeUndefined();
  });

  it('self-heals (stale) a warning stuck past its deadline while still an FAA candidate', async () => {
    const coordinator = new ReapWarningCoordinator();
    warm(coordinator, NOW); // deadline = NOW + grace
    const stillFaa = makeFaaTask();
    const taskStore = makeMockTaskStore([stillFaa]);

    // Past deadline + the 60s self-heal window, with the task still an FAA
    // candidate — maintenance clears the stuck countdown so a banner can never
    // freeze at 0:00.
    const later = () => new Date(NOW.getTime() + GRACE_MS + 60_000 + 1_000);
    const changed = await runFinishedAwaitingAckReapMaintenance(
      { coordinator, auditLogPath, getEnabled: () => true, getGraceMs: () => GRACE_MS },
      taskStore,
      later,
    );
    expect(changed).toBe(true);
    expect(coordinator.getWarning('task-1')).toBeUndefined();
    const rows = await readAuditRows(auditLogPath);
    expect(rows.at(-1)).toMatchObject({
      type: 'task.finishedAwaitingAckReapWarningCleared',
      reason: 'stale',
    });
  });

  it('applies the presence auto-hold in maintenance while the operator has the task selected', async () => {
    const coordinator = new ReapWarningCoordinator();
    warm(coordinator, NOW);
    const before = coordinator.getWarning('task-1')!.deadlineAt;
    const taskStore = makeMockTaskStore([makeFaaTask()]);

    // A later tick with the task selected pushes the deadline forward.
    const later = () => new Date(NOW.getTime() + 30_000);
    await runFinishedAwaitingAckReapMaintenance(
      {
        coordinator,
        auditLogPath,
        getEnabled: () => true,
        getGraceMs: () => GRACE_MS,
        isTaskSelectedByAnyConnection: () => true,
      },
      taskStore,
      later,
    );
    const held = coordinator.getWarning('task-1')!;
    expect(held.heldByPresence).toBe(true);
    expect(held.deadlineAt).toBeGreaterThan(before);
  });

  it('drops all warnings when the reaper is disabled at runtime', async () => {
    const coordinator = new ReapWarningCoordinator();
    warm(coordinator, NOW);
    const taskStore = makeMockTaskStore([makeFaaTask()]);

    const changed = await runFinishedAwaitingAckReapMaintenance(
      { coordinator, auditLogPath, getEnabled: () => false, getGraceMs: () => GRACE_MS },
      taskStore,
      () => NOW,
    );
    expect(changed).toBe(true);
    expect(coordinator.warnedTaskIds()).toEqual([]);
  });
});

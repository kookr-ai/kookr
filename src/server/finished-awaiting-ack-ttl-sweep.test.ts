import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Task } from '../core/tasks.js';
import { aSession, aTask } from '../core/__fixtures__/task-builders.js';
import {
  reclaimAgedFinishedAwaitingAckTasks,
  FinishedAwaitingAckTtlReclaimMetrics,
} from './finished-awaiting-ack-ttl-sweep.js';
import type { LifecycleDeps } from './agent-lifecycle.js';
import { reapAwaitingPollFinishedAwaitingAckTasks } from './finished-awaiting-ack-ack-reaper.js';
import { ReapWarningCoordinator } from '../core/reap-warning-coordinator.js';

// Mock cleanupTaskWorktrees (fire-and-forget in completeTask)
const mockCleanupTaskWorktrees = vi.fn().mockResolvedValue(undefined);
vi.mock('../adapters/git-worktree.js', () => ({
  cleanupTaskWorktrees: (...args: unknown[]) => mockCleanupTaskWorktrees(...args),
}));

// Mock removeReflectWorktree (fire-and-forget reflect-worktree reclaim on terminal transitions)
vi.mock('./use-cases/request-task-reflect.js', () => ({
  removeReflectWorktree: vi.fn().mockResolvedValue(true),
}));

const NOW = new Date('2026-08-02T12:00:00.000Z');
const TTL_MS = 15 * 60_000;

function makeFaaTask(overrides: Partial<Task> = {}): Task {
  return aTask({
    id: 'task-1',
    status: 'inProgress',
    sessions: [aSession({ tmuxSession: 'kookr-abc', lastStatus: 'inProgress' })],
    pendingSignal: {
      kind: 'completion_ready',
      raisedAt: new Date(NOW.getTime() - TTL_MS - 60_000).toISOString(),
    },
    ...overrides,
  });
}

function makeMockTaskStore(tasks: Task[]) {
  return {
    listTasks: vi.fn(() => tasks),
    viewTasks: vi.fn(() => tasks),
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

describe('reclaimAgedFinishedAwaitingAckTasks (issue #1884)', () => {
  let auditDir: string;
  let auditLogPath: string;

  beforeEach(async () => {
    auditDir = await mkdtemp(join(tmpdir(), 'faa-ttl-'));
    auditLogPath = join(auditDir, 'audit.jsonl');
  });

  afterEach(async () => {
    await rm(auditDir, { recursive: true, force: true });
  });

  it('force-completes an aged finishedAwaitingAck task with reason finished_awaiting_ack_ttl + system:finished-awaiting-ack-ttl audit row', async () => {
    const task = makeFaaTask();
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const broadcastToAll = vi.fn();
    const metrics = new FinishedAwaitingAckTtlReclaimMetrics();

    const result = await reclaimAgedFinishedAwaitingAckTasks(
      {
        taskStore,
        lifecycleDeps,
        auditLogPath,
        broadcastToAll,
        isHoldingOpenPr: () => false,
        metrics,
      },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual(['task-1']);
    expect(taskStore.completeTask).toHaveBeenCalledWith('task-1');
    expect(taskStore.clearPendingSignal).toHaveBeenCalledWith('task-1');

    expect(lifecycleDeps.interactionLog!.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'task_completed', taskId: 'task-1', reason: 'finished_awaiting_ack_ttl' }),
    );

    const rows = (await readFile(auditLogPath, 'utf-8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'task.finishedAwaitingAckTtlReclaimed',
      actor: 'system:finished-awaiting-ack-ttl',
      taskId: 'task-1',
      reason: 'finished_awaiting_ack_ttl',
      ttlMs: TTL_MS,
    });
    expect(rows[0].ageMs).toBeGreaterThanOrEqual(TTL_MS);

    expect(broadcastToAll).toHaveBeenCalledTimes(1);
    expect(broadcastToAll).toHaveBeenCalledWith(expect.objectContaining({ type: 'alert', severity: 'warning' }));

    expect(metrics.getSnapshot()).toMatchObject({
      reclaimedTotal: 1,
      reclaimAttempted: 1,
      reclaimSucceeded: 1,
      capacityPressureEarlyReclaimedTotal: 0,
      skippedBadRaisedAt: 0,
      skippedOpenPrFailsafe: 0,
      skippedUnderTtl: 0,
      lastCandidatesConsidered: 1,
      lastAttemptedTaskIds: ['task-1'],
      autoCompletedTotal: 0,
      autoCompleteDeferredTotal: 0,
    });
    expect(result.selection).toMatchObject({
      candidatesConsidered: 1,
      selectedCount: 1,
    });
  });

  it('capacity-pressure soft TTL reclaims awaiting_poll with distinct reason (issue #2355)', async () => {
    const softTtlMs = 5 * 60_000;
    const task = makeFaaTask({
      id: 'pressure-1',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - softTtlMs - 60_000).toISOString(),
      },
    });
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const metrics = new FinishedAwaitingAckTtlReclaimMetrics();

    const result = await reclaimAgedFinishedAwaitingAckTasks(
      {
        taskStore,
        lifecycleDeps,
        auditLogPath,
        isHoldingOpenPr: () => false,
        metrics,
      },
      {
        now: NOW,
        ttlMs: TTL_MS,
        softTtlMs,
        capacityAllowsEarlyReclaim: true,
      },
    );

    expect(result.reclaimedTaskIds).toEqual(['pressure-1']);
    expect(result.capacityPressureEarlyReclaimedTaskIds).toEqual(['pressure-1']);
    expect(lifecycleDeps.interactionLog!.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'task_completed',
        taskId: 'pressure-1',
        reason: 'finished_awaiting_ack_capacity_pressure',
      }),
    );

    const rows = (await readFile(auditLogPath, 'utf-8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(rows[0]).toMatchObject({
      type: 'task.finishedAwaitingAckCapacityPressureReclaimed',
      actor: 'system:finished-awaiting-ack-capacity-pressure',
      reason: 'finished_awaiting_ack_capacity_pressure',
      softTtlMs,
    });

    const snap = metrics.getSnapshot();
    expect(snap).toMatchObject({
      reclaimedTotal: 1,
      capacityPressureEarlyReclaimedTotal: 1,
      capacityEarlyReclaim: true,
      softTtlMs,
      lastAttemptedTaskIds: ['pressure-1'],
    });
    expect(snap.lastOutcomes[0]?.outcome).toBe('capacity_pressure_early_reclaim');
    expect(Object.values(snap.autoCompleteAgeHistogram).reduce((a, b) => a + b, 0)).toBe(1);
  });

  // Issue #3040: the exact production incident. A finished task raised
  // completion_ready, then a follow-up prompt resumed its turn (lastTurnState →
  // running) WITHOUT clearing the stale signal, so it still classifies as FAA.
  // Under capacity pressure the soft-TTL reclaim must DEFER it, not force-complete
  // it out from under live work.
  it('capacity-pressure soft TTL defers a task whose turn has resumed (issue #3040)', async () => {
    const softTtlMs = 5 * 60_000;
    const task = makeFaaTask({
      id: 'resumed-1',
      sessions: [
        aSession({
          tmuxSession: 'kookr-resumed',
          lastStatus: 'inProgress',
          lastTurnState: 'running',
        }),
      ],
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - softTtlMs - 60_000).toISOString(),
      },
    });
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const metrics = new FinishedAwaitingAckTtlReclaimMetrics();

    const result = await reclaimAgedFinishedAwaitingAckTasks(
      { taskStore, lifecycleDeps, auditLogPath, isHoldingOpenPr: () => false, metrics },
      { now: NOW, ttlMs: TTL_MS, softTtlMs, capacityAllowsEarlyReclaim: true },
    );

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(result.capacityPressureEarlyReclaimedTaskIds).toEqual([]);
    expect(result.deferredTaskIds).toEqual(['resumed-1']);
    expect(taskStore.completeTask).not.toHaveBeenCalled();
    expect(taskStore.clearPendingSignal).not.toHaveBeenCalled();
    expect(metrics.getSnapshot().reclaimDeferredTotal).toBe(1);
    // No reclaim audit row was written for a deferral.
    await expect(readFile(auditLogPath, 'utf-8')).rejects.toThrow();
  });

  it('strict hard-TTL path defers a task whose turn has resumed (issue #3040)', async () => {
    const task = makeFaaTask({
      id: 'resumed-2',
      sessions: [
        aSession({
          tmuxSession: 'kookr-resumed-2',
          lastStatus: 'inProgress',
          lastTurnState: 'running',
        }),
      ],
    });
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const metrics = new FinishedAwaitingAckTtlReclaimMetrics();

    const result = await reclaimAgedFinishedAwaitingAckTasks(
      { taskStore, lifecycleDeps, auditLogPath, isHoldingOpenPr: () => false, metrics },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(result.deferredTaskIds).toEqual(['resumed-2']);
    expect(taskStore.completeTask).not.toHaveBeenCalled();
    expect(taskStore.clearPendingSignal).not.toHaveBeenCalled();
    expect(metrics.getSnapshot().reclaimDeferredTotal).toBe(1);
  });

  it('strict path defers when the pane shows a high-confidence human interactive prompt (issue #3040)', async () => {
    const task = makeFaaTask({ id: 'interactive-strict' });
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const metrics = new FinishedAwaitingAckTtlReclaimMetrics();

    const result = await reclaimAgedFinishedAwaitingAckTasks(
      {
        taskStore,
        lifecycleDeps,
        auditLogPath,
        isHoldingOpenPr: () => false,
        getTaskPaneText: () => 'Some output\n❯\n',
        metrics,
      },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(result.deferredTaskIds).toEqual(['interactive-strict']);
    expect(taskStore.completeTask).not.toHaveBeenCalled();
    expect(taskStore.clearPendingSignal).not.toHaveBeenCalled();
    expect(metrics.getSnapshot().reclaimDeferredTotal).toBe(1);
  });

  it('strict path defers when a confirmed-open PR hold lands between selection and close (issue #3040)', async () => {
    const task = makeFaaTask({ id: 'pr-landed' });
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const metrics = new FinishedAwaitingAckTtlReclaimMetrics();

    // Selection sees no open PR (clears the candidate); by the re-check the PR
    // has landed. The stateful predicate models the TOCTOU race directly.
    let call = 0;
    const isHoldingOpenPr = vi.fn(() => (call++ === 0 ? false : true));

    const result = await reclaimAgedFinishedAwaitingAckTasks(
      { taskStore, lifecycleDeps, auditLogPath, isHoldingOpenPr, metrics },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(result.deferredTaskIds).toEqual(['pr-landed']);
    expect(taskStore.completeTask).not.toHaveBeenCalled();
    expect(taskStore.clearPendingSignal).not.toHaveBeenCalled();
    expect(metrics.getSnapshot().reclaimDeferredTotal).toBe(1);
  });

  it('strict path silently skips (no defer) a task that left the FAA class between selection and re-GET (issue #3040)', async () => {
    // True TOCTOU: selection saw a clean FAA; the fresh re-GET returns a task
    // that has since completed, so it is neither reclaimed nor counted as a
    // deferral — it is simply no longer ours to close.
    const task = makeFaaTask({ id: 'raced' });
    const taskStore = makeMockTaskStore([task]);
    taskStore.getTask = vi.fn(() => ({ ...task, status: 'completed' as const }));
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const metrics = new FinishedAwaitingAckTtlReclaimMetrics();

    const result = await reclaimAgedFinishedAwaitingAckTasks(
      { taskStore, lifecycleDeps, auditLogPath, isHoldingOpenPr: () => false, metrics },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(result.deferredTaskIds).toEqual([]);
    expect(taskStore.completeTask).not.toHaveBeenCalled();
    expect(metrics.getSnapshot().reclaimDeferredTotal).toBe(0);
  });

  it('partitions a mixed sweep: strict deferral vs meta deferral land on distinct counters (issue #3040)', async () => {
    // Task A: strict candidate (no open PR), live turn → strict path defers →
    // reclaimDeferredTotal. Task B: allowlisted meta task with an UNKNOWN PR ref
    // (strict fail-safe skips it), live turn → meta path selects then defers →
    // autoCompleteDeferredTotal. The shared deferredTaskIds holds both, but the
    // two counters must each land on exactly one — proving the strictDeferredCount
    // boundary does not double-count.
    const liveSession = (tmux: string) =>
      aSession({ tmuxSession: tmux, lastStatus: 'inProgress', lastTurnState: 'running' });
    const taskA = makeFaaTask({ id: 'A', sessions: [liveSession('kookr-a')] });
    const taskB = makeFaaTask({
      id: 'B',
      playbookId: 'cross-repo-orchestrator.md',
      sessions: [liveSession('kookr-b')],
    });
    const taskStore = makeMockTaskStore([taskA, taskB]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const metrics = new FinishedAwaitingAckTtlReclaimMetrics();

    const result = await reclaimAgedFinishedAwaitingAckTasks(
      {
        taskStore,
        lifecycleDeps,
        auditLogPath,
        // A: confirmed no PR → strict selects. B: unknown → strict skips, meta (relaxed) selects.
        isHoldingOpenPr: (t) => (t.id === 'A' ? false : undefined),
        metrics,
      },
      { now: NOW, ttlMs: TTL_MS, metaAutoCompleteTtlMs: 12 * 60_000 },
    );

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(result.autoCompletedTaskIds).toEqual([]);
    expect(result.deferredTaskIds.sort()).toEqual(['A', 'B']);
    expect(taskStore.completeTask).not.toHaveBeenCalled();
    const snap = metrics.getSnapshot();
    expect(snap.reclaimDeferredTotal).toBe(1);
    expect(snap.autoCompleteDeferredTotal).toBe(1);
  });

  // End-to-end proof that the #2695 threshold is plumbed through the sweep: an
  // actionable (non-ask-first) FAA past the actionable threshold with UNKNOWN
  // open-PR state force-completes under capacity pressure, and is audited with
  // the relaxedOpenPrFailsafe marker.
  it('actionable relaxed fail-safe reclaims an unknown-PR squatter under pressure (issue #2695)', async () => {
    const actionableTtlMs = 30 * 60_000;
    const task = makeFaaTask({
      id: 'squatter-1',
      autoCloseOnSignal: false,
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - actionableTtlMs - 60_000).toISOString(),
      },
    });
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const metrics = new FinishedAwaitingAckTtlReclaimMetrics();

    const result = await reclaimAgedFinishedAwaitingAckTasks(
      {
        taskStore,
        lifecycleDeps,
        auditLogPath,
        // Unknown open-PR state — the strict fail-safe would exempt this forever.
        isHoldingOpenPr: () => undefined,
        metrics,
      },
      {
        now: NOW,
        ttlMs: TTL_MS,
        actionableReclaimTtlMs: actionableTtlMs,
        capacityAllowsEarlyReclaim: true,
      },
    );

    expect(result.reclaimedTaskIds).toEqual(['squatter-1']);
    expect(taskStore.completeTask).toHaveBeenCalledWith('squatter-1');
    const rows = (await readFile(auditLogPath, 'utf-8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(rows[0]).toMatchObject({
      type: 'task.finishedAwaitingAckTtlReclaimed',
      taskId: 'squatter-1',
      relaxedOpenPrFailsafe: true,
    });
  });

  it('without capacity pressure, the same unknown-PR squatter is NOT reclaimed (issue #2695)', async () => {
    const actionableTtlMs = 30 * 60_000;
    const task = makeFaaTask({
      id: 'squatter-2',
      autoCloseOnSignal: false,
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - actionableTtlMs - 60_000).toISOString(),
      },
    });
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);

    const result = await reclaimAgedFinishedAwaitingAckTasks(
      {
        taskStore,
        lifecycleDeps,
        auditLogPath,
        isHoldingOpenPr: () => undefined,
      },
      {
        now: NOW,
        ttlMs: TTL_MS,
        actionableReclaimTtlMs: actionableTtlMs,
        capacityAllowsEarlyReclaim: false,
      },
    );

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(taskStore.completeTask).not.toHaveBeenCalled();
  });

  it('records open-PR failsafe skip metrics without reclaiming (issue #2084)', async () => {
    const task = makeFaaTask({ id: 'stranded' });
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const isHoldingOpenPr = vi.fn(() => true);
    const metrics = new FinishedAwaitingAckTtlReclaimMetrics();

    const result = await reclaimAgedFinishedAwaitingAckTasks(
      { taskStore, lifecycleDeps, auditLogPath, isHoldingOpenPr, metrics },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(taskStore.completeTask).not.toHaveBeenCalled();
    expect(isHoldingOpenPr).toHaveBeenCalledWith(task);
    expect(metrics.getSnapshot()).toMatchObject({
      reclaimedTotal: 0,
      reclaimAttempted: 0,
      skippedOpenPrFailsafe: 1,
      skippedOpenPrConfirmed: 1,
      skippedOpenPrUnknown: 0,
      lastCandidatesConsidered: 1,
      lastAttemptedTaskIds: [],
    });
    expect(result.selection?.skips.skipped_open_pr_confirmed).toBe(1);
    expect(result.selection?.skips.skipped_open_pr_unknown).toBe(0);
    await expect(readFile(auditLogPath, 'utf-8')).rejects.toThrow();
  });

  it('issue #2228: unknown open-PR hold increments unknown only on metrics (no reclaim)', async () => {
    const task = makeFaaTask({ id: 'unknown-pr' });
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const metrics = new FinishedAwaitingAckTtlReclaimMetrics();

    const result = await reclaimAgedFinishedAwaitingAckTasks(
      {
        taskStore,
        lifecycleDeps,
        auditLogPath,
        isHoldingOpenPr: () => undefined,
        metrics,
      },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(taskStore.completeTask).not.toHaveBeenCalled();
    expect(metrics.getSnapshot()).toMatchObject({
      reclaimedTotal: 0,
      reclaimAttempted: 0,
      skippedOpenPrConfirmed: 0,
      skippedOpenPrUnknown: 1,
      skippedOpenPrFailsafe: 1,
      lastOutcomes: [
        expect.objectContaining({
          taskId: 'unknown-pr',
          outcome: 'skipped_open_pr_unknown',
        }),
      ],
    });
  });

  it('issue #2228: metrics aggregate open-PR failsafe = confirmed + unknown', () => {
    const metrics = new FinishedAwaitingAckTtlReclaimMetrics();
    metrics.recordSelection({
      candidatesConsidered: 3,
      skips: {
        skipped_bad_raised_at: 0,
        skipped_under_ttl: 0,
        skipped_open_pr_confirmed: 1,
        skipped_open_pr_unknown: 2,
      },
    });
    const snap = metrics.getSnapshot();
    expect(snap.skippedOpenPrConfirmed).toBe(1);
    expect(snap.skippedOpenPrUnknown).toBe(2);
    expect(snap.skippedOpenPrFailsafe).toBe(3);
  });

  it('accumulates mixed skip-reason counters across a single pass (issue #2084)', async () => {
    const reclaimable = makeFaaTask({ id: 'reclaim' });
    const under = makeFaaTask({
      id: 'under',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - TTL_MS + 60_000).toISOString(),
      },
    });
    const prHold = makeFaaTask({ id: 'pr' });
    const bogus = makeFaaTask({
      id: 'bogus',
      pendingSignal: { kind: 'completion_ready', raisedAt: 'not-a-date' },
    });
    const tasks = [reclaimable, under, prHold, bogus];
    const taskStore = makeMockTaskStore(tasks);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const metrics = new FinishedAwaitingAckTtlReclaimMetrics();

    const result = await reclaimAgedFinishedAwaitingAckTasks(
      {
        taskStore,
        lifecycleDeps,
        auditLogPath,
        isHoldingOpenPr: (t) => (t.id === 'pr' ? true : false),
        metrics,
      },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual(['reclaim']);
    expect(metrics.getSnapshot()).toMatchObject({
      reclaimedTotal: 1,
      reclaimAttempted: 1,
      skippedUnderTtl: 1,
      skippedOpenPrFailsafe: 1,
      skippedOpenPrConfirmed: 1,
      skippedOpenPrUnknown: 0,
      skippedBadRaisedAt: 1,
      lastCandidatesConsidered: 4,
      lastAttemptedTaskIds: ['reclaim'],
    });
    expect(result.selection?.candidatesConsidered).toBe(4);
    expect(result.selection?.selectedCount).toBe(1);
  });

  it('exempts a stranded-PR task (isHoldingOpenPr === true) — the merge_required path is never clobbered', async () => {
    const task = makeFaaTask({ id: 'stranded' });
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const isHoldingOpenPr = vi.fn(() => true);

    const result = await reclaimAgedFinishedAwaitingAckTasks(
      { taskStore, lifecycleDeps, auditLogPath, isHoldingOpenPr },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(taskStore.completeTask).not.toHaveBeenCalled();
    expect(isHoldingOpenPr).toHaveBeenCalledWith(task);
    await expect(readFile(auditLogPath, 'utf-8')).rejects.toThrow();
  });

  it('exempts every candidate (fail-safe) when isHoldingOpenPr is not wired at all', async () => {
    const task = makeFaaTask({ id: 'no-predicate' });
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);

    const result = await reclaimAgedFinishedAwaitingAckTasks(
      { taskStore, lifecycleDeps, auditLogPath },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(taskStore.completeTask).not.toHaveBeenCalled();
  });

  it('is a no-op (and stays silent) when lifecycleDeps is absent', async () => {
    const task = makeFaaTask();
    const taskStore = makeMockTaskStore([task]);
    const broadcastToAll = vi.fn();

    const result = await reclaimAgedFinishedAwaitingAckTasks(
      { taskStore, auditLogPath, broadcastToAll, isHoldingOpenPr: () => false },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(broadcastToAll).not.toHaveBeenCalled();
  });

  it('does nothing (and stays silent) when no finishedAwaitingAck task is past the TTL', async () => {
    const fresh = makeFaaTask({
      id: 'fresh',
      pendingSignal: { kind: 'completion_ready', raisedAt: new Date(NOW.getTime() - 60_000).toISOString() },
    });
    const taskStore = makeMockTaskStore([fresh]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const broadcastToAll = vi.fn();

    const result = await reclaimAgedFinishedAwaitingAckTasks(
      { taskStore, lifecycleDeps, auditLogPath, broadcastToAll, isHoldingOpenPr: () => false },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(result.autoCompletedTaskIds).toEqual([]);
    expect(broadcastToAll).not.toHaveBeenCalled();
    await expect(readFile(auditLogPath, 'utf-8')).rejects.toThrow();
  });
});

describe('meta FAA auto-complete (issue #2070)', () => {
  let auditDir: string;
  let auditLogPath: string;
  const META_TTL = 12 * 60_000;

  beforeEach(async () => {
    auditDir = await mkdtemp(join(tmpdir(), 'faa-auto-'));
    auditLogPath = join(auditDir, 'audit.jsonl');
  });

  afterEach(async () => {
    await rm(auditDir, { recursive: true, force: true });
  });

  function makeMetaFaaTask(overrides: Partial<Task> = {}): Task {
    return makeFaaTask({
      id: 'meta-1',
      playbookId: 'cross-repo-orchestrator.md',
      name: 'Cross-Repo Autonomous Orchestrator',
      sessions: [
        aSession({
          tmuxSession: 'kookr-meta',
          lastStatus: 'inProgress',
          lastTurnState: 'completed_turn',
        }),
      ],
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - META_TTL - 60_000).toISOString(),
        source: 'http',
      },
      ...overrides,
    });
  }

  it('auto-completes an aged meta playbook FAA task when PR-hold is unknown (relaxed fail-safe)', async () => {
    const task = makeMetaFaaTask();
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const metrics = new FinishedAwaitingAckTtlReclaimMetrics();

    const result = await reclaimAgedFinishedAwaitingAckTasks(
      {
        taskStore,
        lifecycleDeps,
        auditLogPath,
        // Unknown PR state: strict path skips; meta path completes.
        isHoldingOpenPr: () => undefined,
        metrics,
      },
      { now: NOW, ttlMs: TTL_MS, metaAutoCompleteTtlMs: META_TTL },
    );

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(result.autoCompletedTaskIds).toEqual(['meta-1']);
    expect(taskStore.completeTask).toHaveBeenCalledWith('meta-1');
    expect(lifecycleDeps.interactionLog!.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'task_completed',
        taskId: 'meta-1',
        reason: 'finished_awaiting_ack_auto_complete',
      }),
    );

    const rows = (await readFile(auditLogPath, 'utf-8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'task.finishedAwaitingAckAutoCompleted',
      actor: 'system:finished-awaiting-ack-auto-complete',
      taskId: 'meta-1',
      playbookId: 'cross-repo-orchestrator.md',
    });

    const snap = metrics.getSnapshot();
    expect(snap.autoCompletedTotal).toBe(1);
    expect(snap.reclaimedTotal).toBe(0);
    expect(Object.values(snap.autoCompleteAgeHistogram).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('defers when the live turn is running (TOCTOU re-GET characterization)', async () => {
    const task = makeMetaFaaTask({
      id: 'live',
      sessions: [
        aSession({
          tmuxSession: 'kookr-live',
          lastStatus: 'inProgress',
          lastTurnState: 'running',
        }),
      ],
    });
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const metrics = new FinishedAwaitingAckTtlReclaimMetrics();

    const result = await reclaimAgedFinishedAwaitingAckTasks(
      {
        taskStore,
        lifecycleDeps,
        auditLogPath,
        isHoldingOpenPr: () => undefined,
        metrics,
      },
      { now: NOW, metaAutoCompleteTtlMs: META_TTL },
    );

    expect(result.autoCompletedTaskIds).toEqual([]);
    expect(result.deferredTaskIds).toEqual(['live']);
    expect(taskStore.completeTask).not.toHaveBeenCalled();
    expect(metrics.getSnapshot().autoCompleteDeferredTotal).toBe(1);
  });

  it('defers when pane text shows a high-confidence human interactive prompt', async () => {
    const task = makeMetaFaaTask({ id: 'interactive' });
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);

    const result = await reclaimAgedFinishedAwaitingAckTasks(
      {
        taskStore,
        lifecycleDeps,
        auditLogPath,
        isHoldingOpenPr: () => undefined,
        getTaskPaneText: () => 'Some output\n❯\n',
      },
      { now: NOW, metaAutoCompleteTtlMs: META_TTL },
    );

    expect(result.autoCompletedTaskIds).toEqual([]);
    expect(result.deferredTaskIds).toEqual(['interactive']);
    expect(taskStore.completeTask).not.toHaveBeenCalled();
  });

  it('does not auto-complete meta tasks with a confirmed-open PR', async () => {
    const task = makeMetaFaaTask({ id: 'open-pr' });
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);

    const result = await reclaimAgedFinishedAwaitingAckTasks(
      {
        taskStore,
        lifecycleDeps,
        auditLogPath,
        isHoldingOpenPr: () => true,
      },
      { now: NOW, metaAutoCompleteTtlMs: META_TTL },
    );

    expect(result.autoCompletedTaskIds).toEqual([]);
    expect(taskStore.completeTask).not.toHaveBeenCalled();
  });

  it('does not double-count a task already reclaimed by the strict TTL path', async () => {
    const task = makeMetaFaaTask({
      id: 'both-paths',
      // Clear PR state → strict path takes it.
    });
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const metrics = new FinishedAwaitingAckTtlReclaimMetrics();

    const result = await reclaimAgedFinishedAwaitingAckTasks(
      {
        taskStore,
        lifecycleDeps,
        auditLogPath,
        isHoldingOpenPr: () => false,
        metrics,
      },
      { now: NOW, ttlMs: META_TTL, metaAutoCompleteTtlMs: META_TTL },
    );

    expect(result.reclaimedTaskIds).toEqual(['both-paths']);
    expect(result.autoCompletedTaskIds).toEqual([]);
    expect(metrics.getSnapshot()).toMatchObject({
      reclaimedTotal: 1,
      autoCompletedTotal: 0,
    });
  });
});

describe('paneHasHumanInteractiveMarkers', () => {
  it('detects Claude idle input prompt and ignores empty / streaming text', async () => {
    const { paneHasHumanInteractiveMarkers } = await import('./finished-awaiting-ack-ttl-sweep.js');
    expect(paneHasHumanInteractiveMarkers('Some output\n❯\n')).toBe(true);
    expect(paneHasHumanInteractiveMarkers('')).toBe(false);
    expect(paneHasHumanInteractiveMarkers(undefined)).toBe(false);
    expect(paneHasHumanInteractiveMarkers('just some agent output')).toBe(false);
  });
});

// Issue #4266: under capacity pressure the soft TTL (5m) and the ack-path
// reaper's deadline (5m) fall due on the same liveness tick. The ack reaper
// runs first and warns "close in 60s unless acked/kept"; the soft TTL used to
// close the task ~30 ms later, so the countdown was false and "Keep it alive"
// could not keep anything. These tests drive both passes in tick order over
// one store and one coordinator, as `lifecycle-timers.ts` does.
describe('soft/hard TTL honours the ack-path reaper grace and keep-alive (issue #4266)', () => {
  const SOFT_TTL_MS = 5 * 60_000;
  const ACK_DEADLINE_MS = 5 * 60_000;
  const ACK_GRACE_MS = 60_000;
  // The first tick that sees the task past both 5-minute gates.
  const T0 = NOW.getTime();
  let auditDir: string;
  let auditLogPath: string;

  beforeEach(async () => {
    auditDir = await mkdtemp(join(tmpdir(), 'faa-ack-grace-'));
    auditLogPath = join(auditDir, 'audit.jsonl');
  });

  afterEach(async () => {
    await rm(auditDir, { recursive: true, force: true });
  });

  /** Mock store whose completeTask / clearPendingSignal actually change the task, so a close is visible to the next pass. */
  function makeLiveStore(tasks: Task[]) {
    const store = makeMockTaskStore(tasks);
    store.completeTask = vi.fn((id: string) => {
      const t = tasks.find((x) => x.id === id);
      if (t) t.status = 'completed';
    });
    store.clearPendingSignal = vi.fn((id: string) => {
      const t = tasks.find((x) => x.id === id);
      if (t) delete t.pendingSignal;
    });
    return store;
  }

  function pressureTask(overrides: Partial<Task> = {}): Task {
    return makeFaaTask({
      id: 'faa-1',
      sessions: [aSession({ tmuxSession: 'kookr-faa', lastStatus: 'inProgress', lastTurnState: 'completed_turn' })],
      pendingSignal: {
        kind: 'completion_ready',
        // 30 ms past both 5-minute gates, as in the issue's evidence table.
        raisedAt: new Date(T0 - SOFT_TTL_MS - 30).toISOString(),
      },
      ...overrides,
    });
  }

  /** One liveness tick: ack reaper first, then the soft/hard TTL sweep (lifecycle-timers order). */
  async function tick(
    taskStore: any,
    coordinator: ReapWarningCoordinator,
    atMs: number,
    sweepExtra: Record<string, unknown> = {},
  ) {
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const now = new Date(atMs);
    const ack = await reapAwaitingPollFinishedAwaitingAckTasks(
      {
        taskStore,
        coordinator,
        lifecycleDeps,
        auditLogPath,
        isHoldingOpenPr: () => false,
        getEnabled: () => true,
        getDeadlineMs: () => ACK_DEADLINE_MS,
        getGraceMs: () => ACK_GRACE_MS,
      },
      { now },
    );
    const sweep = await reclaimAgedFinishedAwaitingAckTasks(
      {
        taskStore,
        lifecycleDeps,
        auditLogPath,
        isHoldingOpenPr: () => false,
        ackReapWarnings: coordinator,
        ...sweepExtra,
      },
      { now, ttlMs: TTL_MS, softTtlMs: SOFT_TTL_MS, capacityAllowsEarlyReclaim: true },
    );
    return { ack, sweep };
  }

  async function auditTypes(): Promise<string[]> {
    const raw = await readFile(auditLogPath, 'utf-8').catch(() => '');
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l).type);
  }

  it('same tick: the ack reaper warns and the soft TTL does not close the task inside the 60 s grace', async () => {
    const task = pressureTask();
    const taskStore = makeLiveStore([task]);
    const coordinator = new ReapWarningCoordinator();

    const first = await tick(taskStore, coordinator, T0);
    expect(first.ack.warnedTaskIds).toEqual(['faa-1']);
    expect(first.sweep.capacityPressureEarlyReclaimedTaskIds).toEqual([]);
    expect(first.sweep.reclaimedTaskIds).toEqual([]);
    expect(first.sweep.ackGraceHeldTaskIds).toEqual(['faa-1']);
    // A hold is not a live-work deferral.
    expect(first.sweep.deferredTaskIds).toEqual([]);
    expect(task.status).toBe('inProgress');

    // Mid-grace: still held.
    const mid = await tick(taskStore, coordinator, T0 + 30_000);
    expect(mid.sweep.ackGraceHeldTaskIds).toEqual(['faa-1']);
    expect(task.status).toBe('inProgress');

    // Grace over: the ack reaper owns the close; the soft TTL finds nothing left.
    const last = await tick(taskStore, coordinator, T0 + ACK_GRACE_MS);
    expect(last.ack.reapedTaskIds).toEqual(['faa-1']);
    expect(last.sweep.reclaimedTaskIds).toEqual([]);
    expect(task.status).toBe('completed');
    expect(taskStore.completeTask).toHaveBeenCalledTimes(1);

    expect(await auditTypes()).toEqual([
      'task.finishedAwaitingAckReapWarned',
      'task.finishedAwaitingAckReaped',
    ]);
  });

  it('Keep it alive holds the task past the original deadline and past the 15m hard TTL', async () => {
    const task = pressureTask();
    const taskStore = makeLiveStore([task]);
    const coordinator = new ReapWarningCoordinator();

    await tick(taskStore, coordinator, T0);
    // Operator clicks "Keep it alive" 20 s into the countdown (+10 min).
    const keptAt = T0 + 20_000;
    expect(coordinator.veto('faa-1', keptAt).accepted).toBe(true);
    const keptDeadline = coordinator.getWarning('faa-1')!.deadlineAt;

    // Past the original 60 s grace: still alive.
    const afterGrace = await tick(taskStore, coordinator, T0 + ACK_GRACE_MS + 1_000);
    expect(afterGrace.ack.reapedTaskIds).toEqual([]);
    expect(afterGrace.sweep.ackGraceHeldTaskIds).toEqual(['faa-1']);
    expect(task.status).toBe('inProgress');

    // Past the 15m hard TTL (age 15m + 10 s) but inside the keep-alive: still alive.
    const pastHardTtl = T0 + (TTL_MS - SOFT_TTL_MS) + 10_000;
    expect(pastHardTtl).toBeLessThan(keptDeadline);
    const hard = await tick(taskStore, coordinator, pastHardTtl);
    expect(hard.sweep.selection?.selectedCount).toBe(1);
    expect(hard.sweep.reclaimedTaskIds).toEqual([]);
    expect(hard.sweep.ackGraceHeldTaskIds).toEqual(['faa-1']);
    expect(task.status).toBe('inProgress');

    // Keep-alive over: the ack reaper closes it, not the TTL sweep.
    const end = await tick(taskStore, coordinator, keptDeadline);
    expect(end.ack.reapedTaskIds).toEqual(['faa-1']);
    expect(task.status).toBe('completed');
    expect(await auditTypes()).not.toContain('task.finishedAwaitingAckCapacityPressureReclaimed');
    expect(await auditTypes()).not.toContain('task.finishedAwaitingAckTtlReclaimed');
  });

  it('a warning already past its deadline does not shield the task from the TTL backstop', async () => {
    const task = pressureTask();
    const taskStore = makeLiveStore([task]);
    const coordinator = new ReapWarningCoordinator();
    // A countdown that ran out without a reap (e.g. the ack reaper kept deferring it).
    coordinator.advance({
      taskId: 'faa-1', agentId: 'kookr-faa', silentForMs: 0, now: T0 - 2 * ACK_GRACE_MS, graceMs: ACK_GRACE_MS, present: false,
    });

    const result = await reclaimAgedFinishedAwaitingAckTasks(
      { taskStore, lifecycleDeps: makeLifecycleDeps(taskStore), auditLogPath, isHoldingOpenPr: () => false, ackReapWarnings: coordinator },
      { now: NOW, ttlMs: TTL_MS, softTtlMs: SOFT_TTL_MS, capacityAllowsEarlyReclaim: true },
    );

    expect(result.ackGraceHeldTaskIds).toEqual([]);
    expect(result.capacityPressureEarlyReclaimedTaskIds).toEqual(['faa-1']);
    expect(task.status).toBe('completed');
  });

  it('without the ack-reaper coordinator wired, the soft TTL closes at 5m as before', async () => {
    const task = pressureTask();
    const taskStore = makeLiveStore([task]);
    const coordinator = new ReapWarningCoordinator();
    coordinator.advance({
      taskId: 'faa-1', agentId: 'kookr-faa', silentForMs: 0, now: T0, graceMs: ACK_GRACE_MS, present: false,
    });

    const result = await reclaimAgedFinishedAwaitingAckTasks(
      { taskStore, lifecycleDeps: makeLifecycleDeps(taskStore), auditLogPath, isHoldingOpenPr: () => false },
      { now: NOW, ttlMs: TTL_MS, softTtlMs: SOFT_TTL_MS, capacityAllowsEarlyReclaim: true },
    );

    expect(result.capacityPressureEarlyReclaimedTaskIds).toEqual(['faa-1']);
    expect(result.ackGraceHeldTaskIds).toEqual([]);
  });

  it('the meta auto-complete path also leaves a task under an unexpired ack-reaper warning alone', async () => {
    const META_TTL = 12 * 60_000;
    const task = makeFaaTask({
      id: 'meta-1',
      playbookId: 'cross-repo-orchestrator.md',
      name: 'Cross-Repo Autonomous Orchestrator',
      sessions: [aSession({ tmuxSession: 'kookr-meta', lastStatus: 'inProgress', lastTurnState: 'completed_turn' })],
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(T0 - META_TTL - 60_000).toISOString(),
        source: 'http',
      },
    });
    const taskStore = makeLiveStore([task]);
    const coordinator = new ReapWarningCoordinator();
    coordinator.advance({
      taskId: 'meta-1', agentId: 'kookr-meta', silentForMs: 0, now: T0, graceMs: ACK_GRACE_MS, present: false,
    });

    const result = await reclaimAgedFinishedAwaitingAckTasks(
      {
        taskStore,
        lifecycleDeps: makeLifecycleDeps(taskStore),
        auditLogPath,
        // Unknown PR state: the strict path skips it; only the meta path could close it.
        isHoldingOpenPr: () => undefined,
        ackReapWarnings: coordinator,
      },
      { now: NOW, ttlMs: TTL_MS, metaAutoCompleteTtlMs: META_TTL },
    );

    expect(result.autoCompletedTaskIds).toEqual([]);
    expect(result.ackGraceHeldTaskIds).toEqual(['meta-1']);
    expect(task.status).toBe('inProgress');
  });
});

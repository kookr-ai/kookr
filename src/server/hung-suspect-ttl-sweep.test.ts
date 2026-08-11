import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Task } from '../core/tasks.js';
import { aSession, aTask } from '../core/__fixtures__/task-builders.js';
import {
  reclaimAgedHungSuspectTasks,
  HungSuspectTtlReclaimMetrics,
  buildHungSuspectTtlDisposition,
} from './hung-suspect-ttl-sweep.js';
import type { LifecycleDeps } from './agent-lifecycle.js';
import type { HungTaskLivenessEvidence } from '../core/hung-task-reaper.js';

// Mock cleanupTaskWorktrees (fire-and-forget in terminateTask)
const mockCleanupTaskWorktrees = vi.fn().mockResolvedValue(undefined);
vi.mock('../adapters/git-worktree.js', () => ({
  cleanupTaskWorktrees: (...args: unknown[]) => mockCleanupTaskWorktrees(...args),
}));

vi.mock('./use-cases/request-task-reflect.js', () => ({
  removeReflectWorktree: vi.fn().mockResolvedValue(true),
}));

const NOW = new Date('2026-08-03T12:00:00.000Z');
const TTL_MS = 25 * 60_000;

function silentFor(ms: number): HungTaskLivenessEvidence {
  const last = NOW.getTime() - ms;
  return {
    lastHookEventAt: last,
    lastPaneChangeAt: last - 1_000,
    lastTokenActivityAt: last - 2_000,
  };
}

function makeHungTask(overrides: Partial<Task> = {}): Task {
  return aTask({
    id: 'task-1',
    status: 'inProgress',
    sessions: [aSession({ tmuxSession: 'kookr-hung', lastStatus: 'inProgress' })],
    ...overrides,
  });
}

function makeMockTaskStore(tasks: Task[]) {
  return {
    listTasks: vi.fn(() => tasks),
    getTask: vi.fn((id: string) => tasks.find((t) => t.id === id)),
    terminateTask: vi.fn(),
    updateSession: vi.fn(),
    updateSessionWorktreeHealth: vi.fn(),
    setCriteriaVerdict: vi.fn(),
    setDisposition: vi.fn(),
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

describe('reclaimAgedHungSuspectTasks (issue #1935)', () => {
  let auditDir: string;
  let auditLogPath: string;
  let dispositionLedgerPath: string;

  beforeEach(async () => {
    auditDir = await mkdtemp(join(tmpdir(), 'hung-suspect-ttl-'));
    auditLogPath = join(auditDir, 'audit.jsonl');
    dispositionLedgerPath = join(auditDir, 'dispositions.jsonl');
  });

  afterEach(async () => {
    await rm(auditDir, { recursive: true, force: true });
  });

  it('terminates an aged hungSuspect task with hung_suspect_ttl disposition + audit + ledger', async () => {
    const task = makeHungTask();
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const broadcastToAll = vi.fn();
    const metrics = new HungSuspectTtlReclaimMetrics();

    const result = await reclaimAgedHungSuspectTasks(
      {
        taskStore,
        lifecycleDeps,
        auditLogPath,
        dispositionLedgerPath,
        broadcastToAll,
        isHungSuspect: () => true,
        getLiveness: () => silentFor(TTL_MS + 60_000),
        isHoldingOpenPr: () => false,
        metrics,
      },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual(['task-1']);
    expect(taskStore.terminateTask).toHaveBeenCalledWith('task-1', expect.anything());
    expect(taskStore.setDisposition).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        reason: 'hung_suspect_ttl',
        source: 'hung-suspect-ttl',
        outcome: 'terminated',
      }),
    );

    const rows = (await readFile(auditLogPath, 'utf-8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'task.hungSuspectTtlReclaimed',
      actor: 'system:hung-suspect-ttl',
      taskId: 'task-1',
      reason: 'hung_suspect_ttl',
      ttlMs: TTL_MS,
      outcome: 'terminated',
    });
    expect(rows[0].silentForMs).toBeGreaterThanOrEqual(TTL_MS);

    const ledgerRows = (await readFile(dispositionLedgerPath, 'utf-8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]).toMatchObject({
      taskId: 'task-1',
      disposition: 'needs-human',
      source: 'hung-suspect-ttl',
    });

    expect(broadcastToAll).toHaveBeenCalledTimes(1);
    expect(broadcastToAll).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'alert', severity: 'warning' }),
    );
    expect(metrics.getSnapshot()).toMatchObject({
      reclaimedTotal: 1,
      reclaimAttempted: 1,
      reclaimSucceeded: 1,
      lastCandidatesConsidered: 1,
    });
  });

  it('records delivered_then_hung + obsolete when a merged PR is attributed', async () => {
    const task = makeHungTask({ id: 'delivered' });
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);

    const result = await reclaimAgedHungSuspectTasks(
      {
        taskStore,
        lifecycleDeps,
        auditLogPath,
        dispositionLedgerPath,
        isHungSuspect: () => true,
        getLiveness: () => silentFor(TTL_MS + 60_000),
        isHoldingOpenPr: () => false,
        resolveMergedPr: () => ({ prNumber: 42, prUrl: 'https://example/pr/42' }),
      },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual(['delivered']);
    expect(taskStore.setDisposition).toHaveBeenCalledWith(
      'delivered',
      expect.objectContaining({
        reason: 'hung_suspect_ttl',
        outcome: 'delivered_then_hung',
        deliveredPr: { number: 42, url: 'https://example/pr/42' },
      }),
    );
    const ledgerRows = (await readFile(dispositionLedgerPath, 'utf-8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(ledgerRows[0].disposition).toBe('obsolete');
  });

  it('exempts a stranded-PR task (isHoldingOpenPr === true)', async () => {
    const task = makeHungTask({ id: 'stranded' });
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const isHoldingOpenPr = vi.fn(() => true);

    const result = await reclaimAgedHungSuspectTasks(
      {
        taskStore,
        lifecycleDeps,
        auditLogPath,
        isHungSuspect: () => true,
        getLiveness: () => silentFor(TTL_MS + 60_000),
        isHoldingOpenPr,
      },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(taskStore.terminateTask).not.toHaveBeenCalled();
    expect(isHoldingOpenPr).toHaveBeenCalledWith(task);
  });

  it('is a no-op when lifecycleDeps is absent', async () => {
    const task = makeHungTask();
    const taskStore = makeMockTaskStore([task]);
    const broadcastToAll = vi.fn();

    const result = await reclaimAgedHungSuspectTasks(
      {
        taskStore,
        auditLogPath,
        broadcastToAll,
        isHungSuspect: () => true,
        getLiveness: () => silentFor(TTL_MS + 60_000),
        isHoldingOpenPr: () => false,
      },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(broadcastToAll).not.toHaveBeenCalled();
  });

  it('does nothing when no hungSuspect task is past the TTL', async () => {
    const fresh = makeHungTask({ id: 'fresh' });
    const taskStore = makeMockTaskStore([fresh]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const broadcastToAll = vi.fn();

    const result = await reclaimAgedHungSuspectTasks(
      {
        taskStore,
        lifecycleDeps,
        auditLogPath,
        broadcastToAll,
        isHungSuspect: () => true,
        getLiveness: () => silentFor(60_000),
        isHoldingOpenPr: () => false,
      },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(broadcastToAll).not.toHaveBeenCalled();
  });

  it('with 7 synthetic hungSuspect fixtures, reclaim frees all of them', async () => {
    const tasks = Array.from({ length: 7 }, (_, i) => makeHungTask({ id: `h${i}` }));
    const taskStore = makeMockTaskStore(tasks);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const metrics = new HungSuspectTtlReclaimMetrics();

    const result = await reclaimAgedHungSuspectTasks(
      {
        taskStore,
        lifecycleDeps,
        auditLogPath,
        dispositionLedgerPath,
        isHungSuspect: () => true,
        getLiveness: () => silentFor(TTL_MS + 5_000),
        isHoldingOpenPr: () => false,
        metrics,
      },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toHaveLength(7);
    expect(taskStore.terminateTask).toHaveBeenCalledTimes(7);
    expect(metrics.getSnapshot()).toMatchObject({
      reclaimedTotal: 7,
      reclaimAttempted: 7,
      reclaimSucceeded: 7,
    });
  });

  it('accumulates skip-reason counters; past-TTL needs_input reclaims (issues #2045 / #2072)', async () => {
    const underTtl = makeHungTask({ id: 'under' });
    const noLiveness = makeHungTask({ id: 'noliv' });
    const openPr = makeHungTask({ id: 'pr' });
    const needsInput = makeHungTask({ id: 'needs' });
    const taskStore = makeMockTaskStore([underTtl, noLiveness, openPr, needsInput]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const metrics = new HungSuspectTtlReclaimMetrics();

    const liveness = new Map<string, HungTaskLivenessEvidence | undefined>([
      ['under', silentFor(60_000)],
      ['noliv', undefined],
      ['pr', silentFor(TTL_MS + 60_000)],
      ['needs', silentFor(TTL_MS + 60_000)],
    ]);

    const result = await reclaimAgedHungSuspectTasks(
      {
        taskStore,
        lifecycleDeps,
        auditLogPath,
        isHungSuspect: () => true,
        getLiveness: (t) => liveness.get(t.id),
        getQueuedAnomalyType: (t) => (t.id === 'needs' ? 'needs_input' : null),
        isHoldingOpenPr: (t) => (t.id === 'pr' ? true : false),
        metrics,
      },
      { now: NOW, ttlMs: TTL_MS },
    );

    // #2072: past-TTL needs_input is attempted/reclaimed; open-PR failsafe stays.
    expect(result.reclaimedTaskIds).toEqual(['needs']);
    expect(taskStore.terminateTask).toHaveBeenCalledWith('needs', expect.anything());
    const snap = metrics.getSnapshot();
    expect(snap).toMatchObject({
      reclaimedTotal: 1,
      reclaimAttempted: 1,
      reclaimSucceeded: 1,
      skippedUnderTtl: 1,
      skippedNoLiveness: 1,
      skippedOpenPrFailsafe: 1,
      skippedOpenPrConfirmed: 1,
      skippedOpenPrUnknown: 0,
      skippedExemptAnomaly: 0,
      lastCandidatesConsidered: 4,
      lastAttemptedTaskIds: ['needs'],
    });
    expect(snap.lastOutcomes.find((o) => o.taskId === 'pr')?.outcome).toBe(
      'skipped_open_pr_confirmed',
    );
    expect(snap.lastOutcomes.find((o) => o.taskId === 'needs')?.outcome).toBe('selected');
    expect(result.selection?.skips.skipped_under_ttl).toBe(1);
  });

  it('issue #2072 fixture: non-exempt hungSuspect → reclaimAttempted ≥ 1 and reclaimed', async () => {
    const task = makeHungTask({ id: 'non-exempt-l1' });
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const metrics = new HungSuspectTtlReclaimMetrics();

    const result = await reclaimAgedHungSuspectTasks(
      {
        taskStore,
        lifecycleDeps,
        auditLogPath,
        isHungSuspect: () => true,
        getLiveness: () => silentFor(TTL_MS + 60_000),
        getQueuedAnomalyType: () => 'stale_agent',
        isHoldingOpenPr: () => false,
        metrics,
      },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual(['non-exempt-l1']);
    const snap = metrics.getSnapshot();
    expect(snap.reclaimAttempted).toBeGreaterThanOrEqual(1);
    expect(snap.reclaimedTotal).toBe(1);
    expect(snap.lastAttemptedTaskIds).toEqual(['non-exempt-l1']);
    expect(snap.lastOutcomes).toEqual([
      expect.objectContaining({ taskId: 'non-exempt-l1', outcome: 'selected' }),
    ]);
  });

  it('issue #2072: terminal skip records task id (open-PR failsafe, no attempt)', async () => {
    const task = makeHungTask({ id: 'stranded-pr' });
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const metrics = new HungSuspectTtlReclaimMetrics();

    const result = await reclaimAgedHungSuspectTasks(
      {
        taskStore,
        lifecycleDeps,
        auditLogPath,
        isHungSuspect: () => true,
        getLiveness: () => silentFor(TTL_MS + 60_000),
        isHoldingOpenPr: () => true,
        metrics,
      },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(metrics.getSnapshot().reclaimAttempted).toBe(0);
    expect(metrics.getSnapshot().lastOutcomes).toEqual([
      expect.objectContaining({
        taskId: 'stranded-pr',
        outcome: 'skipped_open_pr_confirmed',
      }),
    ]);
    expect(metrics.getSnapshot()).toMatchObject({
      skippedOpenPrConfirmed: 1,
      skippedOpenPrUnknown: 0,
      skippedOpenPrFailsafe: 1,
    });
  });

  it('issue #2228: unknown open-PR hold increments unknown only on metrics (no attempt)', async () => {
    const task = makeHungTask({ id: 'unknown-pr' });
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const metrics = new HungSuspectTtlReclaimMetrics();

    const result = await reclaimAgedHungSuspectTasks(
      {
        taskStore,
        lifecycleDeps,
        auditLogPath,
        isHungSuspect: () => true,
        getLiveness: () => silentFor(TTL_MS + 60_000),
        isHoldingOpenPr: () => undefined,
        metrics,
      },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(metrics.getSnapshot().reclaimAttempted).toBe(0);
    expect(metrics.getSnapshot()).toMatchObject({
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
    const metrics = new HungSuspectTtlReclaimMetrics();
    metrics.recordSelection({
      candidatesConsidered: 3,
      skips: {
        skipped_no_liveness: 0,
        skipped_open_pr_confirmed: 1,
        skipped_open_pr_unknown: 2,
        skipped_under_ttl: 0,
        skipped_exempt_anomaly: 0,
        skipped_provider_paused: 0,
      },
    });
    const snap = metrics.getSnapshot();
    expect(snap.skippedOpenPrConfirmed).toBe(1);
    expect(snap.skippedOpenPrUnknown).toBe(2);
    expect(snap.skippedOpenPrFailsafe).toBe(3);
  });

  it('does not reclaim a task that is not classified hungSuspect', async () => {
    const task = makeHungTask({ id: 'working' });
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);

    const result = await reclaimAgedHungSuspectTasks(
      {
        taskStore,
        lifecycleDeps,
        auditLogPath,
        isHungSuspect: () => false,
        getLiveness: () => silentFor(TTL_MS + 60_000),
        isHoldingOpenPr: () => false,
      },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(taskStore.terminateTask).not.toHaveBeenCalled();
  });
});

describe('buildHungSuspectTtlDisposition', () => {
  it('marks terminated when no merged PR', () => {
    const d = buildHungSuspectTtlDisposition(null, '2026-08-03T12:00:00.000Z');
    expect(d).toMatchObject({
      reason: 'hung_suspect_ttl',
      source: 'hung-suspect-ttl',
      outcome: 'terminated',
    });
    expect(d.deliveredPr).toBeUndefined();
  });

  it('marks delivered_then_hung when a merged PR is present', () => {
    const d = buildHungSuspectTtlDisposition(
      { prNumber: 99, prUrl: 'https://example/99' },
      '2026-08-03T12:00:00.000Z',
    );
    expect(d.outcome).toBe('delivered_then_hung');
    expect(d.deliveredPr).toEqual({ number: 99, url: 'https://example/99' });
  });
});

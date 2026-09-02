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
  classifyHungSuspectSweepFailure,
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
    viewTasks: vi.fn(() => tasks),
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

  it('issue #2897: a post-terminate throw (broadcast) keeps the reclaimed task terminated — no rollback', async () => {
    // The sweep's summary broadcast runs AFTER the per-task terminate loop and
    // its metrics.recordReclaimed. If it throws, the tick's local boundary
    // catches it — but the already-terminated task must stay terminated and its
    // reclaim must stay counted (issue #2897 Risks: never roll back partial
    // progress or fabricate an all-or-nothing result).
    const task = makeHungTask();
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const metrics = new HungSuspectTtlReclaimMetrics();
    const broadcastToAll = vi.fn(() => {
      throw new Error('broadcast socket exploded');
    });

    await expect(
      reclaimAgedHungSuspectTasks(
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
      ),
    ).rejects.toThrow('broadcast socket exploded');

    // Partial progress survives the throw: the task was terminated + dispositioned
    // and the reclaim counted before the broadcast failed.
    expect(taskStore.terminateTask).toHaveBeenCalledWith('task-1', expect.anything());
    expect(taskStore.setDisposition).toHaveBeenCalledWith('task-1', expect.anything());
    expect(metrics.getSnapshot()).toMatchObject({ reclaimedTotal: 1, reclaimSucceeded: 1 });
  });

  it('issue #2897: sweep-failure metrics count, expose a sanitized category+timestamp, and clear on a later success', () => {
    const metrics = new HungSuspectTtlReclaimMetrics();
    // Baseline: no failure recorded.
    expect(metrics.getSnapshot()).toMatchObject({
      sweepFailuresTotal: 0,
      lastFailureCategory: null,
      lastFailureAtMs: null,
    });

    class SelectorBoom extends Error {
      override name = 'SelectorBoom';
    }
    metrics.recordSweepFailure(new SelectorBoom('raw secret detail'), 1_000);
    let snap = metrics.getSnapshot();
    expect(snap.sweepFailuresTotal).toBe(1);
    expect(snap.lastFailureCategory).toBe('SelectorBoom');
    expect(snap.lastFailureAtMs).toBe(1_000);
    // The raw exception message must never leak into the failure category.
    expect(snap.lastFailureCategory).not.toContain('raw secret detail');

    // A second failure bumps the cumulative count and refreshes current-error.
    metrics.recordSweepFailure(new TypeError('x'), 2_000);
    snap = metrics.getSnapshot();
    expect(snap.sweepFailuresTotal).toBe(2);
    expect(snap.lastFailureCategory).toBe('TypeError');
    expect(snap.lastFailureAtMs).toBe(2_000);

    // A later successful pass clears the current-error state but retains the count.
    metrics.recordSweepSuccess();
    snap = metrics.getSnapshot();
    expect(snap.sweepFailuresTotal).toBe(2);
    expect(snap.lastFailureCategory).toBeNull();
    expect(snap.lastFailureAtMs).toBeNull();
  });

  it('issue #2897: classifyHungSuspectSweepFailure sanitizes to the error class name, no raw text', () => {
    expect(classifyHungSuspectSweepFailure(new TypeError('boom'))).toBe('TypeError');
    // Non-Error throws fall back to a bounded token.
    expect(classifyHungSuspectSweepFailure('some string')).toBe('unknown');
    expect(classifyHungSuspectSweepFailure(null)).toBe('unknown');
    // Weird characters in the name are stripped; empty result falls back.
    const weird = new Error('m');
    weird.name = '!@#$%';
    expect(classifyHungSuspectSweepFailure(weird)).toBe('unknown');
    const spaced = new Error('m');
    spaced.name = 'My Custom Error!';
    expect(classifyHungSuspectSweepFailure(spaced)).toBe('MyCustomError');
    // Empty error name falls back rather than producing an empty category.
    const noName = new Error('m');
    noName.name = '';
    expect(classifyHungSuspectSweepFailure(noName)).toBe('unknown');
    // The category is length-capped (48 chars) so health/metrics stay bounded.
    const longName = new Error('m');
    longName.name = 'A'.repeat(200);
    const cat = classifyHungSuspectSweepFailure(longName);
    expect(cat).toBe('A'.repeat(48));
    expect(cat.length).toBe(48);
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

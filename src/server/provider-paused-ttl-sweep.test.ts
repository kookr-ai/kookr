import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Task } from '../core/tasks.js';
import { aSession, aTask } from '../core/__fixtures__/task-builders.js';
import {
  reclaimAgedProviderPausedTasks,
  ProviderPausedOccupancyMetrics,
  ProviderPausedStartTracker,
  buildProviderPausedTtlDisposition,
} from './provider-paused-ttl-sweep.js';
import type { LifecycleDeps } from './agent-lifecycle.js';
import {
  DEFAULT_PROVIDER_PAUSED_HARD_TTL_MS,
  DEFAULT_PROVIDER_PAUSED_SOFT_TTL_MS,
} from '../core/provider-paused-ttl.js';

const mockCleanupTaskWorktrees = vi.fn().mockResolvedValue(undefined);
vi.mock('../adapters/git-worktree.js', () => ({
  cleanupTaskWorktrees: (...args: unknown[]) => mockCleanupTaskWorktrees(...args),
}));

vi.mock('./use-cases/request-task-reflect.js', () => ({
  removeReflectWorktree: vi.fn().mockResolvedValue(true),
}));

const NOW = new Date('2026-08-05T12:00:00.000Z');
const TTL_MS = DEFAULT_PROVIDER_PAUSED_HARD_TTL_MS;

function makePausedTask(overrides: Partial<Task> = {}): Task {
  return aTask({
    id: 'task-1',
    status: 'inProgress',
    sessions: [aSession({ tmuxSession: 'kookr-paused', lastStatus: 'inProgress' })],
    ...overrides,
  });
}

function makeMockTaskStore(tasks: Task[]) {
  return {
    listTasks: vi.fn(() => tasks),
    viewTasks: vi.fn(() => tasks),
    getTask: vi.fn((id: string) => tasks.find((t) => t.id === id)),
    terminateTask: vi.fn((id: string) => {
      const t = tasks.find((x) => x.id === id);
      if (t) t.status = 'terminated';
    }),
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

describe('ProviderPausedStartTracker (issue #2079)', () => {
  it('latches first-observed pause start and keeps it across observe', () => {
    const tracker = new ProviderPausedStartTracker();
    const task = makePausedTask();
    const t0 = NOW.getTime();
    expect(tracker.observe(task, true, t0)).toBe(t0);
    expect(tracker.observe(task, true, t0 + 60_000)).toBe(t0);
    expect(tracker.getPauseStartedAtMs(task.id)).toBe(t0);
  });

  it('clears when pause ends so a later pause gets a fresh clock', () => {
    const tracker = new ProviderPausedStartTracker();
    const task = makePausedTask();
    const t0 = NOW.getTime();
    tracker.observe(task, true, t0);
    expect(tracker.observe(task, false, t0 + 10_000)).toBeUndefined();
    expect(tracker.observe(task, true, t0 + 20_000)).toBe(t0 + 20_000);
  });
});

describe('reclaimAgedProviderPausedTasks (issue #2079)', () => {
  let auditDir: string;
  let auditLogPath: string;
  let dispositionLedgerPath: string;

  beforeEach(async () => {
    auditDir = await mkdtemp(join(tmpdir(), 'provider-paused-ttl-'));
    auditLogPath = join(auditDir, 'audit.jsonl');
    dispositionLedgerPath = join(auditDir, 'dispositions.jsonl');
  });

  afterEach(async () => {
    await rm(auditDir, { recursive: true, force: true });
  });

  it('terminates past hard TTL with provider_paused_ttl disposition + needs-human ledger', async () => {
    const task = makePausedTask();
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const broadcastToAll = vi.fn();
    const metrics = new ProviderPausedOccupancyMetrics();
    const tracker = new ProviderPausedStartTracker();
    // Pre-latch pause start past TTL
    tracker.observe(task, true, NOW.getTime() - (TTL_MS + 60_000));

    const result = await reclaimAgedProviderPausedTasks(
      {
        taskStore,
        lifecycleDeps,
        auditLogPath,
        dispositionLedgerPath,
        broadcastToAll,
        isProviderPaused: () => true,
        pauseStartTracker: tracker,
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
        reason: 'provider_paused_ttl',
        source: 'provider-paused-ttl',
        outcome: 'terminated',
      }),
    );

    const ledger = (await readFile(dispositionLedgerPath, 'utf8')).trim();
    expect(ledger).toContain('needs-human');
    expect(ledger).toContain('provider-paused-ttl');
    expect(ledger).not.toContain('"disposition":"delivered"');

    const audit = (await readFile(auditLogPath, 'utf8')).trim();
    expect(audit).toContain('task.providerPausedTtlReclaimed');
    expect(audit).toContain('provider_paused_ttl');

    const snap = metrics.getSnapshot();
    expect(snap.reclaimedTotal).toBe(1);
    expect(snap.reclaimAttempted).toBe(1);
    expect(broadcastToAll).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'alert',
        summary: expect.stringContaining('provider_paused'),
      }),
    );
  });

  it('does not reclaim under hard TTL (skip vs escalate)', async () => {
    const task = makePausedTask();
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const metrics = new ProviderPausedOccupancyMetrics();
    const tracker = new ProviderPausedStartTracker();
    tracker.observe(task, true, NOW.getTime() - (TTL_MS - 60_000));

    const result = await reclaimAgedProviderPausedTasks(
      {
        taskStore,
        lifecycleDeps,
        isProviderPaused: () => true,
        pauseStartTracker: tracker,
        isHoldingOpenPr: () => false,
        metrics,
      },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(taskStore.terminateTask).not.toHaveBeenCalled();
    expect(metrics.getSnapshot().skippedUnderTtl).toBe(1);
    expect(metrics.getSnapshot().count).toBe(1);
    expect(metrics.getSnapshot().oldestPauseAgeMs).toBe(TTL_MS - 60_000);
  });

  it('issue #2225 AC3: soft TTL + capacity gate reclaims before hard 2h bound', async () => {
    const soft = DEFAULT_PROVIDER_PAUSED_SOFT_TTL_MS;
    const task = makePausedTask({ id: 'soft-reclaim' });
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const metrics = new ProviderPausedOccupancyMetrics();
    const tracker = new ProviderPausedStartTracker();
    // Aged past soft (40m) but still under hard (2h).
    tracker.observe(task, true, NOW.getTime() - (soft + 5 * 60_000));

    const result = await reclaimAgedProviderPausedTasks(
      {
        taskStore,
        lifecycleDeps,
        auditLogPath,
        dispositionLedgerPath,
        isProviderPaused: () => true,
        pauseStartTracker: tracker,
        isHoldingOpenPr: () => false,
        metrics,
      },
      {
        now: NOW,
        ttlMs: TTL_MS,
        softTtlMs: soft,
        capacityAllowsEarlyReclaim: true,
      },
    );

    expect(result.reclaimedTaskIds).toEqual(['soft-reclaim']);
    expect(taskStore.terminateTask).toHaveBeenCalledWith('soft-reclaim', expect.anything());
    const snap = metrics.getSnapshot();
    expect(snap.reclaimAttempted).toBe(1);
    expect(snap.reclaimedTotal).toBe(1);
    expect(snap.capacityEarlyReclaim).toBe(true);
    expect(snap.effectiveTtlMs).toBe(soft);
    expect(snap.softTtlMs).toBe(soft);
  });

  it('issue #2225: past soft TTL without capacity gate still waits for hard TTL', async () => {
    const soft = DEFAULT_PROVIDER_PAUSED_SOFT_TTL_MS;
    const task = makePausedTask({ id: 'hard-only' });
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const metrics = new ProviderPausedOccupancyMetrics();
    const tracker = new ProviderPausedStartTracker();
    tracker.observe(task, true, NOW.getTime() - (soft + 5 * 60_000));

    const result = await reclaimAgedProviderPausedTasks(
      {
        taskStore,
        lifecycleDeps,
        isProviderPaused: () => true,
        pauseStartTracker: tracker,
        isHoldingOpenPr: () => false,
        metrics,
      },
      {
        now: NOW,
        ttlMs: TTL_MS,
        softTtlMs: soft,
        capacityAllowsEarlyReclaim: false,
      },
    );

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(taskStore.terminateTask).not.toHaveBeenCalled();
    const snap = metrics.getSnapshot();
    expect(snap.skippedUnderTtl).toBe(1);
    expect(snap.capacityEarlyReclaim).toBe(false);
    expect(snap.effectiveTtlMs).toBe(TTL_MS);
  });

  it('open-PR fail-safe: past TTL but holding open PR is not terminated', async () => {
    const task = makePausedTask();
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const metrics = new ProviderPausedOccupancyMetrics();
    const tracker = new ProviderPausedStartTracker();
    tracker.observe(task, true, NOW.getTime() - (TTL_MS + 60_000));

    const result = await reclaimAgedProviderPausedTasks(
      {
        taskStore,
        lifecycleDeps,
        isProviderPaused: () => true,
        pauseStartTracker: tracker,
        isHoldingOpenPr: () => true,
        metrics,
      },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(taskStore.terminateTask).not.toHaveBeenCalled();
    expect(metrics.getSnapshot()).toMatchObject({
      skippedOpenPrFailsafe: 1,
      skippedOpenPrConfirmed: 1,
      skippedOpenPrUnknown: 0,
      // Issue #3115: end-to-end through the real sweep — the hold age reaches
      // the snapshot (proving recordHardTtlMs runs before recordSelection), and
      // a hold 1m past the hard TTL counts as over-TTL while reclaim still skips.
      oldestOpenPrFailsafeHoldMs: TTL_MS + 60_000,
      openPrFailsafeOverHardTtlCount: 1,
    });
  });

  it('issue #2228: unknown open-PR hold increments unknown only on metrics (no reclaim)', async () => {
    const task = makePausedTask({ id: 'unknown-pr' });
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const metrics = new ProviderPausedOccupancyMetrics();
    const tracker = new ProviderPausedStartTracker();
    tracker.observe(task, true, NOW.getTime() - (TTL_MS + 60_000));

    const result = await reclaimAgedProviderPausedTasks(
      {
        taskStore,
        lifecycleDeps,
        isProviderPaused: () => true,
        pauseStartTracker: tracker,
        isHoldingOpenPr: () => undefined,
        metrics,
      },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(taskStore.terminateTask).not.toHaveBeenCalled();
    expect(metrics.getSnapshot()).toMatchObject({
      skippedOpenPrFailsafe: 1,
      skippedOpenPrConfirmed: 0,
      skippedOpenPrUnknown: 1,
      lastOutcomes: [
        expect.objectContaining({
          taskId: 'unknown-pr',
          outcome: 'skipped_open_pr_unknown',
        }),
      ],
    });
  });

  it('issue #2228: metrics aggregate open-PR failsafe = confirmed + unknown', () => {
    const metrics = new ProviderPausedOccupancyMetrics();
    metrics.recordSelection({
      candidatesConsidered: 3,
      skips: {
        skipped_under_ttl: 0,
        skipped_open_pr_confirmed: 1,
        skipped_open_pr_unknown: 2,
        skipped_no_pause_start: 0,
        skipped_awaiting_provider_reset: 0,
      },
    });
    const snap = metrics.getSnapshot();
    expect(snap.skippedOpenPrConfirmed).toBe(1);
    expect(snap.skippedOpenPrUnknown).toBe(2);
    expect(snap.skippedOpenPrFailsafe).toBe(3);
  });

  it('issue #3115: snapshot surfaces oldest open-PR failsafe hold age + over-TTL count', () => {
    const metrics = new ProviderPausedOccupancyMetrics();
    // Default snapshot: nothing held yet.
    expect(metrics.getSnapshot()).toMatchObject({
      oldestOpenPrFailsafeHoldMs: null,
      openPrFailsafeOverHardTtlCount: 0,
    });

    metrics.recordHardTtlMs(2 * 60 * 60_000); // 2h hard TTL
    metrics.recordSelection({
      candidatesConsidered: 3,
      skips: {
        skipped_under_ttl: 0,
        skipped_open_pr_confirmed: 1,
        skipped_open_pr_unknown: 1,
        skipped_no_pause_start: 0,
        skipped_awaiting_provider_reset: 0,
      },
      outcomes: [
        { taskId: 'a', outcome: 'skipped_open_pr_confirmed', pausedForMs: 5 * 60 * 60_000 },
        { taskId: 'b', outcome: 'skipped_open_pr_unknown', pausedForMs: 90 * 60_000 },
        { taskId: 'c', outcome: 'selected', pausedForMs: 6 * 60 * 60_000 },
      ],
    });

    const snap = metrics.getSnapshot();
    expect(snap.oldestOpenPrFailsafeHoldMs).toBe(5 * 60 * 60_000);
    // Only the 5h hold is past the 2h hard TTL; the 90m one is not.
    expect(snap.openPrFailsafeOverHardTtlCount).toBe(1);
  });

  it('without delivery attribution the disposition is terminated/needs-human', () => {
    const d = buildProviderPausedTtlDisposition(NOW.toISOString());
    expect(d.reason).toBe('provider_paused_ttl');
    expect(d.outcome).toBe('terminated');
    expect(d.deliveredPr).toBeUndefined();
    expect(d.detail).toContain('not delivered');
  });

  it('issue #3578: a merged PR labels the disposition delivered_then_hung, not "not delivered"', () => {
    const d = buildProviderPausedTtlDisposition(NOW.toISOString(), {
      prNumber: 3577,
      prUrl: 'https://github.com/o/r/pull/3577',
    });
    expect(d.reason).toBe('provider_paused_ttl');
    expect(d.outcome).toBe('delivered_then_hung');
    expect(d.deliveredPr).toEqual({ number: 3577, url: 'https://github.com/o/r/pull/3577' });
    expect(d.detail).toContain('#3577');
    expect(d.detail).not.toContain('not delivered');
  });

  // Issue #3578 (tasks e5427450 / 16dec794): the reap labelled already-merged
  // work "billing/quota hold, not delivered".
  it('issue #3578: already-merged task is still terminated but recorded delivered (ledger obsolete)', async () => {
    const task = makePausedTask();
    const taskStore = makeMockTaskStore([task]);
    const broadcastToAll = vi.fn();
    const tracker = new ProviderPausedStartTracker();
    tracker.observe(task, true, NOW.getTime() - (TTL_MS + 60_000));

    const result = await reclaimAgedProviderPausedTasks(
      {
        taskStore,
        lifecycleDeps: makeLifecycleDeps(taskStore),
        auditLogPath,
        dispositionLedgerPath,
        broadcastToAll,
        isProviderPaused: () => true,
        pauseStartTracker: tracker,
        isHoldingOpenPr: () => false,
        resolveMergedPr: () => ({ prNumber: 3577, prUrl: 'https://github.com/o/r/pull/3577' }),
      },
      { now: NOW, ttlMs: TTL_MS },
    );

    // Still reclaimed: a billing hold never auto-completes, even when delivered.
    expect(result.reclaimedTaskIds).toEqual(['task-1']);
    expect(taskStore.terminateTask).toHaveBeenCalledWith('task-1', expect.anything());
    expect(task.status).toBe('terminated');
    expect(taskStore.setDisposition).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        reason: 'provider_paused_ttl',
        outcome: 'delivered_then_hung',
        deliveredPr: { number: 3577, url: 'https://github.com/o/r/pull/3577' },
      }),
    );

    const ledgerRows = (await readFile(dispositionLedgerPath, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]).toMatchObject({ disposition: 'obsolete', source: 'provider-paused-ttl' });
    expect(ledgerRows[0].detail).toContain('#3577');

    const auditRows = (await readFile(auditLogPath, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(auditRows[0]).toMatchObject({
      type: 'task.providerPausedTtlReclaimed',
      outcome: 'delivered_then_hung',
      deliveredPr: { number: 3577 },
    });

    const alert = broadcastToAll.mock.calls[0][0];
    expect(alert.details).toContain('1 had already merged their PR');
    expect(alert.details).toContain('0 need human review');
  });

  it('issue #3578: branch probe supplies the label when the in-memory attribution is empty', async () => {
    const task = makePausedTask();
    const taskStore = makeMockTaskStore([task]);
    const tracker = new ProviderPausedStartTracker();
    tracker.observe(task, true, NOW.getTime() - (TTL_MS + 60_000));
    let terminatedBeforeProbe: boolean | undefined;
    const resolveMergedPrByBranch = vi.fn(async () => {
      terminatedBeforeProbe = taskStore.terminateTask.mock.calls.length > 0;
      return { prNumber: 996 };
    });

    await reclaimAgedProviderPausedTasks(
      {
        taskStore,
        lifecycleDeps: makeLifecycleDeps(taskStore),
        dispositionLedgerPath,
        isProviderPaused: () => true,
        pauseStartTracker: tracker,
        isHoldingOpenPr: () => false,
        resolveMergedPr: () => null,
        resolveMergedPrByBranch,
      },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(resolveMergedPrByBranch).toHaveBeenCalledWith(task);
    expect(terminatedBeforeProbe).toBe(true);
    expect(taskStore.setDisposition).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ outcome: 'delivered_then_hung', deliveredPr: { number: 996 } }),
    );
    const ledger = JSON.parse((await readFile(dispositionLedgerPath, 'utf8')).trim());
    expect(ledger.disposition).toBe('obsolete');
  });

  it('issue #3578: terminates every selected task before any branch probe; probe errors keep needs-human', async () => {
    const first = makePausedTask({ id: 'first' });
    const second = makePausedTask({
      id: 'second',
      sessions: [aSession({ tmuxSession: 'kookr-paused-2', lastStatus: 'inProgress' })],
    });
    const taskStore = makeMockTaskStore([first, second]);
    const events: string[] = [];
    const baseTerminate = taskStore.terminateTask.getMockImplementation();
    taskStore.terminateTask.mockImplementation((id: string, ...rest: unknown[]) => {
      events.push(`terminate:${id}`);
      return baseTerminate?.(id, ...rest);
    });
    const tracker = new ProviderPausedStartTracker();
    tracker.observe(first, true, NOW.getTime() - (TTL_MS + 60_000));
    tracker.observe(second, true, NOW.getTime() - (TTL_MS + 60_000));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await reclaimAgedProviderPausedTasks(
      {
        taskStore,
        lifecycleDeps: makeLifecycleDeps(taskStore),
        dispositionLedgerPath,
        isProviderPaused: () => true,
        pauseStartTracker: tracker,
        isHoldingOpenPr: () => false,
        resolveMergedPr: () => null,
        resolveMergedPrByBranch: async (task) => {
          events.push(`probe:${task.id}`);
          if (task.id === 'first') throw new Error('gh exploded');
          return { prNumber: 7 };
        },
      },
      { now: NOW, ttlMs: TTL_MS },
    );
    warn.mockRestore();

    expect(result.reclaimedTaskIds).toEqual(['first', 'second']);
    expect(events).toEqual(['terminate:first', 'terminate:second', 'probe:first', 'probe:second']);
    const byId = new Map(taskStore.setDisposition.mock.calls.map(([id, d]: [string, any]) => [id, d]));
    expect(byId.get('first')).toMatchObject({ outcome: 'terminated' });
    expect(byId.get('first').deliveredPr).toBeUndefined();
    expect(byId.get('second')).toMatchObject({ outcome: 'delivered_then_hung', deliveredPr: { number: 7 } });
  });

  it('issue #3578: with no merged PR found the label stays needs-human and the alert says all need review', async () => {
    const task = makePausedTask();
    const taskStore = makeMockTaskStore([task]);
    const broadcastToAll = vi.fn();
    const tracker = new ProviderPausedStartTracker();
    tracker.observe(task, true, NOW.getTime() - (TTL_MS + 60_000));

    await reclaimAgedProviderPausedTasks(
      {
        taskStore,
        lifecycleDeps: makeLifecycleDeps(taskStore),
        auditLogPath,
        dispositionLedgerPath,
        broadcastToAll,
        isProviderPaused: () => true,
        pauseStartTracker: tracker,
        isHoldingOpenPr: () => false,
        resolveMergedPr: () => null,
        resolveMergedPrByBranch: async () => null,
      },
      { now: NOW, ttlMs: TTL_MS },
    );

    const disposition = taskStore.setDisposition.mock.calls[0][1];
    expect(disposition.outcome).toBe('terminated');
    expect(disposition.deliveredPr).toBeUndefined();
    const ledger = JSON.parse((await readFile(dispositionLedgerPath, 'utf8')).trim());
    expect(ledger.disposition).toBe('needs-human');
    const audit = JSON.parse((await readFile(auditLogPath, 'utf8')).trim());
    expect(audit.outcome).toBe('terminated');
    expect(audit.deliveredPr).toBeUndefined();
    expect(broadcastToAll.mock.calls[0][0].details).toContain('All need human review');
  });

  it('skips under hard TTL when claim-backed recordProviderPause says holdForResume (#1896 / #2423)', async () => {
    const task = makePausedTask({
      issueClaim: { repo: 'kookr-ai/kookr', number: 2079 },
    });
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const metrics = new ProviderPausedOccupancyMetrics();
    const tracker = new ProviderPausedStartTracker();
    const softTtlMs = DEFAULT_PROVIDER_PAUSED_SOFT_TTL_MS;
    // Past soft TTL so the candidate is eligible, still under hard TTL.
    tracker.observe(task, true, NOW.getTime() - (softTtlMs + 60_000));
    const recordProviderPause = vi.fn(() => ({ holdForResume: true }));

    const result = await reclaimAgedProviderPausedTasks(
      {
        taskStore,
        lifecycleDeps,
        isProviderPaused: () => true,
        pauseStartTracker: tracker,
        recordProviderPause,
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

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(taskStore.terminateTask).not.toHaveBeenCalled();
    expect(recordProviderPause).toHaveBeenCalled();
    expect(metrics.getSnapshot().skippedAwaitingProviderReset).toBe(1);
  });

  it('reclaims after hard TTL even when holdForResume is still true (#2423)', async () => {
    const task = makePausedTask({
      issueClaim: { repo: 'kookr-ai/kookr', number: 2079 },
    });
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const metrics = new ProviderPausedOccupancyMetrics();
    const tracker = new ProviderPausedStartTracker();
    tracker.observe(task, true, NOW.getTime() - TTL_MS);
    const recordProviderPause = vi.fn(() => ({ holdForResume: true }));

    const result = await reclaimAgedProviderPausedTasks(
      {
        taskStore,
        lifecycleDeps,
        isProviderPaused: () => true,
        pauseStartTracker: tracker,
        recordProviderPause,
        isHoldingOpenPr: () => false,
        metrics,
      },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual(['task-1']);
    expect(taskStore.terminateTask).toHaveBeenCalled();
    // After the hard bound the selector must not consult the reset hold —
    // a missing reset is no longer a reason to keep the slot.
    expect(recordProviderPause).not.toHaveBeenCalled();
    expect(metrics.getSnapshot().skippedAwaitingProviderReset).toBe(0);
    expect(result.selection?.outcomes[0]?.outcome).toBe('selected');
  });

  it('reclaims after recordProviderPause returns holdForResume false (reset elapsed)', async () => {
    const task = makePausedTask({
      issueClaim: { repo: 'kookr-ai/kookr', number: 2079 },
    });
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const tracker = new ProviderPausedStartTracker();
    tracker.observe(task, true, NOW.getTime() - (TTL_MS + 60_000));

    const result = await reclaimAgedProviderPausedTasks(
      {
        taskStore,
        lifecycleDeps,
        isProviderPaused: () => true,
        pauseStartTracker: tracker,
        recordProviderPause: () => ({ holdForResume: false }),
        isHoldingOpenPr: () => false,
      },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual(['task-1']);
  });

  it('reclaims no-claim free-form tasks even when recordProviderPause would hold forever', async () => {
    // Production wiring returns holdForResume:true when issueClaim is missing
    // (no #1896 resume to schedule). Hard TTL must still free those slots.
    const task = makePausedTask(); // no issueClaim
    expect(task.issueClaim).toBeUndefined();
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const tracker = new ProviderPausedStartTracker();
    tracker.observe(task, true, NOW.getTime() - (TTL_MS + 60_000));
    const recordProviderPause = vi.fn(() => ({ holdForResume: true }));

    const result = await reclaimAgedProviderPausedTasks(
      {
        taskStore,
        lifecycleDeps,
        isProviderPaused: () => true,
        pauseStartTracker: tracker,
        recordProviderPause,
        isHoldingOpenPr: () => false,
      },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual(['task-1']);
    // No-claim short-circuit must not call recordProviderPause.
    expect(recordProviderPause).not.toHaveBeenCalled();
  });

  it('exposes occupancy on metrics even when nothing is reclaimed', async () => {
    const a = makePausedTask({ id: 'a' });
    const b = makePausedTask({ id: 'b' });
    const taskStore = makeMockTaskStore([a, b]);
    const metrics = new ProviderPausedOccupancyMetrics();
    const tracker = new ProviderPausedStartTracker();
    // First observe latches at NOW — both under TTL
    const result = await reclaimAgedProviderPausedTasks(
      {
        taskStore,
        lifecycleDeps: makeLifecycleDeps(taskStore),
        isProviderPaused: () => true,
        pauseStartTracker: tracker,
        isHoldingOpenPr: () => false,
        metrics,
      },
      { now: NOW, ttlMs: TTL_MS },
    );
    expect(result.occupancy.count).toBe(2);
    expect(result.occupancy.taskIds).toEqual(expect.arrayContaining(['a', 'b']));
    expect(metrics.getSnapshot().count).toBe(2);
    expect(metrics.getSnapshot().hardTtlMs).toBe(TTL_MS);
  });
});

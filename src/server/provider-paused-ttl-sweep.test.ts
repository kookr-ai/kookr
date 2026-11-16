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
  classifyProviderResetState,
  type ProviderResetSource,
} from './provider-paused-ttl-sweep.js';
import type { LifecycleDeps } from './agent-lifecycle.js';
import { storeResolverWithMergedPr, type MergedPrFixture } from './__fixtures__/delivered-pr-resolver.js';
import {
  DEFAULT_PROVIDER_PAUSED_HARD_TTL_MS,
  DEFAULT_PROVIDER_PAUSED_SOFT_TTL_MS,
  MAX_PROVIDER_PAUSED_HARD_TTL_MS,
  PROVIDER_RESET_HOLD_GRACE_MS,
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
  // Issues #3678 / #3983: the sweep shares the production delivered-PR
  // resolver, so its label follows the same attribution rules.
  describe('with the production resolver', () => {
    async function reclaimWith(fx: Omit<MergedPrFixture, 'task' | 'prNumber'>) {
      const task = makePausedTask();
      const taskStore = makeMockTaskStore([task]);
      const tracker = new ProviderPausedStartTracker();
      tracker.observe(task, true, NOW.getTime() - (TTL_MS + 60_000));
      const { resolveMergedPr } = storeResolverWithMergedPr({ task, prNumber: 3577, ...fx });
      await reclaimAgedProviderPausedTasks(
        {
          taskStore,
          lifecycleDeps: makeLifecycleDeps(taskStore),
          auditLogPath,
          dispositionLedgerPath,
          broadcastToAll: vi.fn(),
          isProviderPaused: () => true,
          pauseStartTracker: tracker,
          isHoldingOpenPr: () => false,
          resolveMergedPr,
        },
        { now: NOW, ttlMs: TTL_MS },
      );
      return taskStore.setDisposition.mock.calls[0]?.[1];
    }

    it('labels a PR merged into the default branch delivered', async () => {
      const d = await reclaimWith({ baseBranch: 'main', branches: { defaultBranch: 'main', integrationBranch: null } });
      expect(d).toMatchObject({ outcome: 'delivered_then_hung', deliveredPr: { number: 3577 } });
    });

    it('does not label a PR merged into a feature branch delivered (issue #3983)', async () => {
      const d = await reclaimWith({ baseBranch: 'feat/parent', branches: { defaultBranch: 'main', integrationBranch: null } });
      expect(d.outcome).not.toBe('delivered_then_hung');
      expect(d.deliveredPr).toBeUndefined();
    });

    it('does not label a PR another task pushed delivered (issue #3678)', async () => {
      const d = await reclaimWith({ pushedBy: ['another-task'] });
      expect(d.outcome).not.toBe('delivered_then_hung');
      expect(d.deliveredPr).toBeUndefined();
    });
  });

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

describe('provider reset holds in the sweep (issue #3562)', () => {
  const nowMs = NOW.getTime();
  const MIN = 60_000;
  const SOFT = DEFAULT_PROVIDER_PAUSED_SOFT_TTL_MS;

  const exhaustedWindow = (resetsAtMs: number) => ({
    utilization: 100,
    resetsAt: new Date(resetsAtMs).toISOString(),
  });

  async function runSweep(opts: {
    task: Task;
    pausedForMs: number;
    source: ProviderResetSource | (() => ProviderResetSource) | undefined;
    tracker?: ProviderPausedStartTracker;
    now?: Date;
    capacity?: boolean;
  }) {
    const taskStore = makeMockTaskStore([opts.task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const metrics = new ProviderPausedOccupancyMetrics();
    const tracker = opts.tracker ?? new ProviderPausedStartTracker();
    if (!opts.tracker) tracker.observe(opts.task, true, nowMs - opts.pausedForMs);
    const source = opts.source;
    const result = await reclaimAgedProviderPausedTasks(
      {
        taskStore,
        lifecycleDeps,
        isProviderPaused: () => true,
        pauseStartTracker: tracker,
        isHoldingOpenPr: () => false,
        metrics,
        ...(source === undefined
          ? {}
          : { getProviderResetSource: typeof source === 'function' ? source : () => source }),
      },
      {
        now: opts.now ?? NOW,
        ttlMs: TTL_MS,
        softTtlMs: SOFT,
        capacityAllowsEarlyReclaim: opts.capacity ?? true,
      },
    );
    return { result, metrics, taskStore, tracker };
  }

  it('regression: poller in 429 backoff with no snapshot, soft TTL elapsed, capacity allows → task survives', async () => {
    const task = makePausedTask(); // prompt-launched: no issueClaim
    const { result, metrics, taskStore } = await runSweep({
      task,
      pausedForMs: SOFT + MIN,
      source: { quota: null, pollerState: 'backoff' },
    });
    expect(result.reclaimedTaskIds).toEqual([]);
    expect(taskStore.terminateTask).not.toHaveBeenCalled();
    const snap = metrics.getSnapshot();
    expect(snap.skippedProviderResetUnresolved).toBe(1);
    expect(snap.skippedAwaitingProviderReset).toBe(0);
  });

  it('pre-#3562 behavior without a reset source: the same task is soft-reclaimed', async () => {
    const { result } = await runSweep({
      task: makePausedTask(),
      pausedForMs: SOFT + MIN,
      source: undefined,
    });
    expect(result.reclaimedTaskIds).toEqual(['task-1']);
  });

  it('holds an unclaimed task on a known reset and counts it as awaiting reset', async () => {
    const { result, metrics } = await runSweep({
      task: makePausedTask(),
      pausedForMs: SOFT + MIN,
      source: {
        quota: { fiveHour: exhaustedWindow(nowMs + 204 * MIN), sevenDay: null, updatedAt: nowMs },
        pollerState: 'healthy',
      },
    });
    expect(result.reclaimedTaskIds).toEqual([]);
    const snap = metrics.getSnapshot();
    expect(snap.skippedAwaitingProviderReset).toBe(1);
    expect(snap.skippedProviderResetUnresolved).toBe(0);
  });

  it('still reclaims an unresolved pause at the hard TTL (#2423)', async () => {
    const { result } = await runSweep({
      task: makePausedTask(),
      pausedForMs: TTL_MS,
      source: { quota: null, pollerState: 'backoff' },
    });
    expect(result.reclaimedTaskIds).toEqual(['task-1']);
  });

  it('latches the known reset so it survives the window vanishing from a later snapshot', async () => {
    const task = makePausedTask();
    const tracker = new ProviderPausedStartTracker();
    const pauseStart = nowMs - 3 * 60 * MIN;
    tracker.observe(task, true, pauseStart);
    const resetAt = nowMs + 30 * MIN;
    // Tick 1: snapshot names the reset.
    await runSweep({
      task,
      pausedForMs: 0,
      tracker,
      source: {
        quota: { fiveHour: exhaustedWindow(resetAt), sevenDay: null, updatedAt: nowMs },
        pollerState: 'healthy',
      },
    });
    expect(tracker.getKnownResetMs(task.id)).toBe(resetAt);

    // Tick 2: 5 minutes after the reset, a fresh snapshot no longer shows an
    // exhausted window. Still in grace → held, not reclaimed.
    const afterReset = new Date(resetAt + 5 * MIN);
    const freshNoWindow: ProviderResetSource = {
      quota: { fiveHour: { utilization: 3, resetsAt: new Date(resetAt + 5 * 60 * MIN).toISOString() }, sevenDay: null, updatedAt: afterReset.getTime() },
      pollerState: 'healthy',
    };
    const held = await runSweep({ task, pausedForMs: 0, tracker, now: afterReset, source: freshNoWindow });
    expect(held.result.reclaimedTaskIds).toEqual([]);
    expect(held.metrics.getSnapshot().skippedAwaitingProviderReset).toBe(1);

    // Tick 3: grace over and still paused → normal TTL applies (past hard) → reclaimed.
    const graceOver = new Date(resetAt + PROVIDER_RESET_HOLD_GRACE_MS);
    const reclaimed = await runSweep({ task, pausedForMs: 0, tracker, now: graceOver, source: freshNoWindow });
    expect(reclaimed.result.reclaimedTaskIds).toEqual(['task-1']);
  });

  it('clears the latched reset when the pause ends', () => {
    const tracker = new ProviderPausedStartTracker();
    const task = makePausedTask();
    tracker.observe(task, true, nowMs);
    tracker.latchKnownReset(task.id, nowMs + 60 * MIN);
    tracker.observe(task, false, nowMs + MIN);
    expect(tracker.getKnownResetMs(task.id)).toBeUndefined();
    // Not latched without a pause start.
    tracker.latchKnownReset(task.id, nowMs + 60 * MIN);
    expect(tracker.getKnownResetMs(task.id)).toBeUndefined();
  });

  it('regression: a weekly window at 90%+ does not hide the 5h reset, on soft or hard path', async () => {
    const task = makePausedTask();
    const tracker = new ProviderPausedStartTracker();
    tracker.observe(task, true, nowMs - 45 * MIN);
    const source: ProviderResetSource = {
      quota: {
        fiveHour: exhaustedWindow(nowMs + 4 * 60 * MIN),
        sevenDay: { utilization: 92, resetsAt: new Date(nowMs + 3 * 24 * 60 * MIN).toISOString() },
        updatedAt: nowMs,
      },
      pollerState: 'healthy',
    };
    const soft = await runSweep({ task, pausedForMs: 0, tracker, source });
    expect(soft.result.reclaimedTaskIds).toEqual([]);
    expect(soft.metrics.getSnapshot().skippedAwaitingProviderReset).toBe(1);

    // 2h50m later: past the hard TTL, poller now in backoff with the old snapshot.
    const later = new Date(nowMs + 170 * MIN);
    const hard = await runSweep({
      task,
      pausedForMs: 0,
      tracker,
      now: later,
      source: { ...source, pollerState: 'backoff' },
    });
    expect(hard.result.reclaimedTaskIds).toEqual([]);
    expect(hard.metrics.getSnapshot().skippedAwaitingProviderReset).toBe(1);
  });

  it('keeps today\'s soft reclaim on an install with no quota source (poller disabled)', async () => {
    const { result } = await runSweep({
      task: makePausedTask(),
      pausedForMs: SOFT + MIN,
      source: { quota: null, pollerState: 'disabled' },
    });
    expect(result.reclaimedTaskIds).toEqual(['task-1']);
  });

  it('regression: measures the 6h fit from the activity-advanced pause start, like the selector', async () => {
    // Pause latched 5h ago, agent activity until 2h ago (the effective start,
    // so effective age = 2h = hard TTL), 5h window resetting in 3h. The hold
    // would end 5h15m after the effective start (within 6h) but 8h15m after
    // the raw latch — measuring from the latch misclassified it as unresolved
    // and reclaimed it at the hard TTL.
    const task = makePausedTask();
    const taskStore = makeMockTaskStore([task]);
    const tracker = new ProviderPausedStartTracker();
    tracker.observe(task, true, nowMs - 5 * 60 * MIN);
    const lastActivity = nowMs - 2 * 60 * MIN;
    const metrics = new ProviderPausedOccupancyMetrics();
    const result = await reclaimAgedProviderPausedTasks(
      {
        taskStore,
        lifecycleDeps: makeLifecycleDeps(taskStore),
        isProviderPaused: () => true,
        pauseStartTracker: tracker,
        getLiveness: () => ({
          lastHookEventAt: lastActivity,
          lastPaneChangeAt: 0,
          lastTokenActivityAt: 0,
        }) as any,
        isHoldingOpenPr: () => false,
        metrics,
        getProviderResetSource: () => ({
          quota: { fiveHour: exhaustedWindow(nowMs + 3 * 60 * MIN), sevenDay: null, updatedAt: nowMs },
          pollerState: 'healthy',
        }),
      },
      { now: NOW, ttlMs: TTL_MS },
    );
    expect(result.reclaimedTaskIds).toEqual([]);
    expect(metrics.getSnapshot().skippedAwaitingProviderReset).toBe(1);
    expect(metrics.getSnapshot().skippedProviderResetUnresolved).toBe(0);
  });

  it('keeps the latest known reset seen during a pause (never under-wait)', () => {
    const tracker = new ProviderPausedStartTracker();
    const task = makePausedTask();
    tracker.observe(task, true, nowMs);
    tracker.latchKnownReset(task.id, nowMs + 60 * MIN);
    tracker.latchKnownReset(task.id, nowMs + 30 * MIN);
    expect(tracker.getKnownResetMs(task.id)).toBe(nowMs + 60 * MIN);
    tracker.latchKnownReset(task.id, nowMs + 90 * MIN);
    expect(tracker.getKnownResetMs(task.id)).toBe(nowMs + 90 * MIN);
  });

  it('holds a claimed task past the hard TTL on a known reset (sweep end to end)', async () => {
    const task = makePausedTask({ issueClaim: { repo: 'kookr-ai/kookr', number: 3562 } });
    const taskStore = makeMockTaskStore([task]);
    const tracker = new ProviderPausedStartTracker();
    tracker.observe(task, true, nowMs - 3 * 60 * MIN);
    const result = await reclaimAgedProviderPausedTasks(
      {
        taskStore,
        lifecycleDeps: makeLifecycleDeps(taskStore),
        isProviderPaused: () => true,
        pauseStartTracker: tracker,
        recordProviderPause: () => ({ holdForResume: true }),
        isHoldingOpenPr: () => false,
        getProviderResetSource: () => ({
          quota: { fiveHour: exhaustedWindow(nowMs + 90 * MIN), sevenDay: null, updatedAt: nowMs },
          pollerState: 'healthy',
        }),
      },
      { now: NOW, ttlMs: TTL_MS },
    );
    expect(result.reclaimedTaskIds).toEqual([]);
    expect(result.selection?.outcomes[0]?.outcome).toBe('skipped_awaiting_provider_reset');
  });

  it('treats a task without agentType as a Claude task', async () => {
    const { result, metrics } = await runSweep({
      task: makePausedTask({ agentType: undefined }),
      pausedForMs: SOFT + MIN,
      source: { quota: null, pollerState: 'backoff' },
    });
    expect(result.reclaimedTaskIds).toEqual([]);
    expect(metrics.getSnapshot().skippedProviderResetUnresolved).toBe(1);
  });

  it('keeps today\'s soft reclaim for non-Claude agents (the quota poller does not describe them)', async () => {
    const { result } = await runSweep({
      task: makePausedTask({ agentType: 'codex-cli' }),
      pausedForMs: SOFT + MIN,
      source: { quota: null, pollerState: 'backoff' },
    });
    expect(result.reclaimedTaskIds).toEqual(['task-1']);
  });

  it('treats a throwing reset source as unresolved (fail toward holding)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result, metrics } = await runSweep({
      task: makePausedTask(),
      pausedForMs: SOFT + MIN,
      source: () => {
        throw new Error('boom');
      },
    });
    errSpy.mockRestore();
    expect(result.reclaimedTaskIds).toEqual([]);
    expect(metrics.getSnapshot().skippedProviderResetUnresolved).toBe(1);
  });
});

describe('healthy-quota hold in the sweep (issue #3574)', () => {
  const nowMs = NOW.getTime();
  const MIN = 60_000;
  const SOFT = DEFAULT_PROVIDER_PAUSED_SOFT_TTL_MS;

  // The 2026-11-10 incident: quota poller healthy, weekly window at 39%, the
  // 5h window far from exhaustion, snapshot refreshed after the pause began.
  const healthyQuota = (updatedAt: number): ProviderResetSource => ({
    quota: {
      fiveHour: { utilization: 12, resetsAt: new Date(nowMs + 3 * 60 * MIN).toISOString() },
      sevenDay: { utilization: 39, resetsAt: new Date(nowMs + 4 * 24 * 60 * MIN).toISOString() },
      updatedAt,
    },
    pollerState: 'healthy',
  });

  async function sweep(opts: {
    pausedForMs: number;
    source: ProviderResetSource;
    capacity?: boolean;
    tracker?: ProviderPausedStartTracker;
    task?: Task;
    now?: Date;
  }) {
    const task = opts.task ?? makePausedTask();
    const taskStore = makeMockTaskStore([task]);
    const metrics = new ProviderPausedOccupancyMetrics();
    const tracker = opts.tracker ?? new ProviderPausedStartTracker();
    if (!opts.tracker) tracker.observe(task, true, nowMs - opts.pausedForMs);
    const result = await reclaimAgedProviderPausedTasks(
      {
        taskStore,
        lifecycleDeps: makeLifecycleDeps(taskStore),
        isProviderPaused: () => true,
        pauseStartTracker: tracker,
        isHoldingOpenPr: () => false,
        metrics,
        getProviderResetSource: () => opts.source,
      },
      {
        now: opts.now ?? NOW,
        ttlMs: TTL_MS,
        softTtlMs: SOFT,
        capacityAllowsEarlyReclaim: opts.capacity ?? true,
      },
    );
    return { result, metrics, taskStore };
  }

  it('regression: a quiet task past the soft and hard TTL is not reclaimed while the quota is healthy', async () => {
    const { result, metrics, taskStore } = await sweep({
      pausedForMs: TTL_MS + 10 * MIN,
      source: healthyQuota(nowMs),
    });
    expect(result.reclaimedTaskIds).toEqual([]);
    expect(taskStore.terminateTask).not.toHaveBeenCalled();
    expect(result.selection?.outcomes[0]?.outcome).toBe('skipped_provider_quota_healthy');
    const snap = metrics.getSnapshot();
    expect(snap.skippedProviderQuotaHealthy).toBe(1);
    expect(snap.skippedProviderResetUnresolved).toBe(0);
    expect(snap.skippedAwaitingProviderReset).toBe(0);
  });

  it('still reclaims at the 6h max from the pause start (inclusive)', async () => {
    const atMax = await sweep({ pausedForMs: MAX_PROVIDER_PAUSED_HARD_TTL_MS, source: healthyQuota(nowMs) });
    expect(atMax.result.reclaimedTaskIds).toEqual(['task-1']);
    expect(atMax.metrics.getSnapshot().skippedProviderQuotaHealthy).toBe(0);

    const justUnder = await sweep({ pausedForMs: MAX_PROVIDER_PAUSED_HARD_TTL_MS - 1, source: healthyQuota(nowMs) });
    expect(justUnder.result.reclaimedTaskIds).toEqual([]);
  });

  it('does not hold on a snapshot older than the pause (it cannot prove the quota is healthy now)', async () => {
    const pausedForMs = TTL_MS + 10 * MIN;
    const { result, metrics } = await sweep({
      pausedForMs,
      source: healthyQuota(nowMs - pausedForMs - 1),
    });
    expect(result.reclaimedTaskIds).toEqual(['task-1']);
    expect(metrics.getSnapshot().skippedProviderQuotaHealthy).toBe(0);
  });

  it('does not hold when a window is exhausted (a real quota pause, reset beyond 6h)', async () => {
    const { result, metrics } = await sweep({
      pausedForMs: TTL_MS + 10 * MIN,
      source: {
        quota: {
          fiveHour: null,
          sevenDay: { utilization: 95, resetsAt: new Date(nowMs + 3 * 24 * 60 * MIN).toISOString() },
          updatedAt: nowMs,
        },
        pollerState: 'healthy',
      },
    });
    expect(result.reclaimedTaskIds).toEqual(['task-1']);
    expect(metrics.getSnapshot().skippedProviderQuotaHealthy).toBe(0);
  });

  it('does not hold when the poller is disabled (no quota source on this install)', async () => {
    const { result } = await sweep({
      pausedForMs: SOFT + MIN,
      source: { quota: null, pollerState: 'disabled' },
    });
    expect(result.reclaimedTaskIds).toEqual(['task-1']);
  });

  it('does not hold non-Claude agents (the quota poller does not describe them)', async () => {
    const { result } = await sweep({
      task: makePausedTask({ agentType: 'codex-cli' }),
      pausedForMs: SOFT + MIN,
      source: healthyQuota(nowMs),
    });
    expect(result.reclaimedTaskIds).toEqual(['task-1']);
  });

  it('does not hold a pause whose latched reset has passed: the healthy quota is the window rolling over', async () => {
    const task = makePausedTask();
    const tracker = new ProviderPausedStartTracker();
    tracker.observe(task, true, nowMs - 3 * 60 * MIN);
    tracker.latchKnownReset(task.id, nowMs - PROVIDER_RESET_HOLD_GRACE_MS);
    const { result, metrics } = await sweep({
      task,
      tracker,
      pausedForMs: 0,
      source: healthyQuota(nowMs),
    });
    expect(result.reclaimedTaskIds).toEqual(['task-1']);
    expect(metrics.getSnapshot().skippedProviderQuotaHealthy).toBe(0);
  });
});

describe('healthy-quota hold vs. pause evidence kind (issue #4050)', () => {
  const nowMs = NOW.getTime();
  const MIN = 60_000;
  const SOFT = DEFAULT_PROVIDER_PAUSED_SOFT_TTL_MS;

  const healthyQuota: ProviderResetSource = {
    quota: {
      fiveHour: { utilization: 12, resetsAt: new Date(nowMs + 3 * 60 * MIN).toISOString() },
      sevenDay: { utilization: 39, resetsAt: new Date(nowMs + 4 * 24 * 60 * MIN).toISOString() },
      updatedAt: nowMs,
    },
    pollerState: 'healthy',
  };

  async function sweep(opts: {
    tracker: ProviderPausedStartTracker;
    task: Task;
    capacity?: boolean;
    getProviderPauseDetail?: (task: Task) => string | undefined;
    now?: Date;
    source?: ProviderResetSource;
  }) {
    const taskStore = makeMockTaskStore([opts.task]);
    const metrics = new ProviderPausedOccupancyMetrics();
    const result = await reclaimAgedProviderPausedTasks(
      {
        taskStore,
        lifecycleDeps: makeLifecycleDeps(taskStore),
        isProviderPaused: () => true,
        pauseStartTracker: opts.tracker,
        isHoldingOpenPr: () => false,
        metrics,
        getProviderResetSource: () => opts.source ?? healthyQuota,
        ...(opts.getProviderPauseDetail ? { getProviderPauseDetail: opts.getProviderPauseDetail } : {}),
      },
      {
        now: opts.now ?? NOW,
        ttlMs: TTL_MS,
        softTtlMs: SOFT,
        capacityAllowsEarlyReclaim: opts.capacity ?? true,
      },
    );
    return { result, metrics };
  }

  function pausedFor(pausedForMs: number) {
    const task = makePausedTask();
    const tracker = new ProviderPausedStartTracker();
    tracker.observe(task, true, nowMs - pausedForMs);
    return { task, tracker };
  }

  const ACCOUNT_LEVEL = [
    'stop_failure:billing_error',
    'stop_failure:authentication_failed',
    'stop_failure:quota_exceeded',
  ];

  it.each(ACCOUNT_LEVEL)('reclaims %s at the soft TTL when capacity allows, healthy quota or not', async (detail) => {
    const { task, tracker } = pausedFor(SOFT + MIN);
    const { result, metrics } = await sweep({ task, tracker, getProviderPauseDetail: () => detail });
    expect(result.reclaimedTaskIds).toEqual(['task-1']);
    expect(metrics.getSnapshot().skippedProviderQuotaHealthy).toBe(0);
  });

  it.each(ACCOUNT_LEVEL)('reclaims %s at the hard TTL without spare capacity', async (detail) => {
    const under = pausedFor(TTL_MS - MIN);
    const held = await sweep({ ...under, capacity: false, getProviderPauseDetail: () => detail });
    expect(held.result.reclaimedTaskIds).toEqual([]);
    expect(held.result.selection?.outcomes[0]?.outcome).toBe('skipped_under_ttl');

    const over = pausedFor(TTL_MS);
    const { result } = await sweep({ ...over, capacity: false, getProviderPauseDetail: () => detail });
    expect(result.reclaimedTaskIds).toEqual(['task-1']);
  });

  it.each([
    'stop_failure:rate_limit',
    'stop_failure:rate_limit_error',
    'stop_failure_message:billing_error',
    'stop_failure_message:unknown',
    'error_event',
    'text_surface',
    'tool_result',
    'anomaly:api_error',
    undefined,
  ])('keeps the #3574 hold past the hard TTL for rate-limit or text evidence (%s)', async (detail) => {
    const { task, tracker } = pausedFor(TTL_MS + 10 * MIN);
    const { result, metrics } = await sweep({ task, tracker, getProviderPauseDetail: () => detail });
    expect(result.reclaimedTaskIds).toEqual([]);
    expect(result.selection?.outcomes[0]?.outcome).toBe('skipped_provider_quota_healthy');
    expect(metrics.getSnapshot().skippedProviderQuotaHealthy).toBe(1);
  });

  it('keeps the #3574 hold when the detail reader is not wired', async () => {
    const { task, tracker } = pausedFor(TTL_MS + 10 * MIN);
    const { result } = await sweep({ task, tracker });
    expect(result.selection?.outcomes[0]?.outcome).toBe('skipped_provider_quota_healthy');
  });

  it('keeps the #3574 hold when the detail reader throws', async () => {
    const { task, tracker } = pausedFor(TTL_MS + 10 * MIN);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { result } = await sweep({
        task,
        tracker,
        getProviderPauseDetail: () => { throw new Error('boom'); },
      });
      expect(result.selection?.outcomes[0]?.outcome).toBe('skipped_provider_quota_healthy');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('remembers account-level evidence for the pause when a later event masks it', async () => {
    const { task, tracker } = pausedFor(SOFT - MIN);
    let detail = 'stop_failure:billing_error';
    const getProviderPauseDetail = () => detail;
    const first = await sweep({ task, tracker, capacity: false, getProviderPauseDetail });
    expect(first.result.selection?.outcomes[0]?.outcome).toBe('skipped_under_ttl');

    // Later, an error event becomes the newest match and the pause is past
    // the hard TTL. Without the latch the #3574 hold would come back.
    detail = 'error_event';
    const later = new Date(nowMs + TTL_MS);
    const { result } = await sweep({
      task,
      tracker,
      capacity: false,
      getProviderPauseDetail,
      now: later,
      source: { ...healthyQuota, quota: { ...healthyQuota.quota!, updatedAt: later.getTime() } },
    });
    expect(result.reclaimedTaskIds).toEqual(['task-1']);
  });

  it('forgets account-level evidence when the pause ends, so a later text pause is held again', async () => {
    const task = makePausedTask();
    const tracker = new ProviderPausedStartTracker();
    tracker.observe(task, true, nowMs - (TTL_MS + 20 * MIN));
    tracker.latchAccountLevelEvidence(task.id);
    expect(tracker.hasAccountLevelEvidence(task.id)).toBe(true);

    tracker.observe(task, false, nowMs - (TTL_MS + 15 * MIN));
    expect(tracker.hasAccountLevelEvidence(task.id)).toBe(false);

    tracker.observe(task, true, nowMs - (TTL_MS + 10 * MIN));
    const { result } = await sweep({ task, tracker, getProviderPauseDetail: () => 'text_surface' });
    expect(result.selection?.outcomes[0]?.outcome).toBe('skipped_provider_quota_healthy');
  });

  it('does not latch evidence for a task with no pause start', () => {
    const tracker = new ProviderPausedStartTracker();
    tracker.latchAccountLevelEvidence('task-1');
    expect(tracker.hasAccountLevelEvidence('task-1')).toBe(false);
  });
});

describe('classifyProviderResetState (issue #3562)', () => {
  const nowMs = NOW.getTime();
  const pauseStartedAtMs = nowMs - 60 * 60_000;
  const window = (utilization: number, resetsAtMs: number) => ({
    utilization,
    resetsAt: new Date(resetsAtMs).toISOString(),
  });

  it('is known for an exhausted window with a future reset, even from a stale snapshot in backoff', () => {
    const resetAt = nowMs + 30 * 60_000;
    expect(classifyProviderResetState({
      source: {
        quota: { fiveHour: window(100, resetAt), sevenDay: null, updatedAt: pauseStartedAtMs - 1 },
        pollerState: 'backoff',
      },
      nowMs,
      pauseStartedAtMs,
    })).toEqual({ kind: 'known', resetsAtMs: resetAt });
  });

  it('is unresolved with no snapshot, an unhealthy poller, or a snapshot older than the pause', () => {
    const fresh = { fiveHour: window(10, nowMs + 60_000), sevenDay: null, updatedAt: nowMs };
    expect(classifyProviderResetState({ source: { quota: null, pollerState: 'healthy' }, nowMs, pauseStartedAtMs }).kind)
      .toBe('unresolved');
    for (const pollerState of ['backoff', 'auth_failed', 'idle'] as const) {
      expect(classifyProviderResetState({ source: { quota: fresh, pollerState }, nowMs, pauseStartedAtMs }).kind)
        .toBe('unresolved');
    }
    expect(classifyProviderResetState({
      source: { quota: { ...fresh, updatedAt: pauseStartedAtMs - 1 }, pollerState: 'healthy' },
      nowMs,
      pauseStartedAtMs,
    }).kind).toBe('unresolved');
  });

  it('treats a poll in flight with a fresh snapshot as resolvable, and an updatedAt equal to the pause start as fresh', () => {
    const fresh = { fiveHour: window(10, nowMs + 60_000), sevenDay: null, updatedAt: pauseStartedAtMs };
    expect(classifyProviderResetState({ source: { quota: fresh, pollerState: 'polling' }, nowMs, pauseStartedAtMs }))
      .toEqual({ kind: 'quota_healthy' });
    expect(classifyProviderResetState({
      source: { quota: { ...fresh, updatedAt: Number.NaN }, pollerState: 'healthy' },
      nowMs,
      pauseStartedAtMs,
    }).kind).toBe('unresolved');
  });

  it('picks the exhausted reset that fits the 6h cap when a weekly window at 90%+ resets in days', () => {
    // Heavy user: 5h window exhausted (reset in 4h), weekly at 92% (reset in 3 days).
    const fiveHourReset = nowMs + 4 * 60 * 60_000;
    expect(classifyProviderResetState({
      source: {
        quota: {
          fiveHour: window(100, fiveHourReset),
          sevenDay: window(92, nowMs + 3 * 24 * 60 * 60_000),
          updatedAt: nowMs,
        },
        pollerState: 'healthy',
      },
      nowMs,
      pauseStartedAtMs: nowMs - 30 * 60_000,
    })).toEqual({ kind: 'known', resetsAtMs: fiveHourReset });
  });

  it('is unresolved when every exhausted reset is beyond the 6h cap', () => {
    expect(classifyProviderResetState({
      source: {
        quota: { fiveHour: null, sevenDay: window(100, nowMs + 3 * 24 * 60 * 60_000), updatedAt: nowMs },
        pollerState: 'healthy',
      },
      nowMs,
      pauseStartedAtMs,
    })).toEqual({ kind: 'unresolved' });
  });

  it('is none when the poller is disabled (no quota source on this install)', () => {
    expect(classifyProviderResetState({ source: { quota: null, pollerState: 'disabled' }, nowMs, pauseStartedAtMs }))
      .toEqual({ kind: 'none' });
  });

  it('is quota_healthy for a fresh healthy snapshot without a binding window (issue #3574)', () => {
    expect(classifyProviderResetState({
      source: {
        quota: { fiveHour: window(50, nowMs + 60_000), sevenDay: window(100, nowMs - 60_000), updatedAt: nowMs },
        pollerState: 'healthy',
      },
      nowMs,
      pauseStartedAtMs,
    })).toEqual({ kind: 'quota_healthy' });
  });
});

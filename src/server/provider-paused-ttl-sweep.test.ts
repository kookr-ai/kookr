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

  it('never force-completes as delivered — disposition is always terminated/needs-human', () => {
    const d = buildProviderPausedTtlDisposition(NOW.toISOString());
    expect(d.reason).toBe('provider_paused_ttl');
    expect(d.outcome).toBe('terminated');
    expect(d.deliveredPr).toBeUndefined();
  });

  it('skips hard TTL when claim-backed recordProviderPause says holdForResume (#1896)', async () => {
    const task = makePausedTask({
      issueClaim: { repo: 'kookr-ai/kookr', number: 2079 },
    });
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const metrics = new ProviderPausedOccupancyMetrics();
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
        metrics,
      },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(taskStore.terminateTask).not.toHaveBeenCalled();
    expect(recordProviderPause).toHaveBeenCalled();
    expect(metrics.getSnapshot().skippedAwaitingProviderReset).toBe(1);
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

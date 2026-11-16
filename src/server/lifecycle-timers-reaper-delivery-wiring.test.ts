/**
 * Wiring guard for issue #3578: the liveness tick must hand both delivery
 * probes to both TTL reapers. Without this wiring the provider-paused reaper
 * keeps labelling already-merged work "not delivered", and neither reaper
 * gets the branch-keyed fallback — while every sweep-level test stays green.
 *
 * The sweeps are mocked here (module-wide), so this lives apart from
 * lifecycle-timers.test.ts, whose other tests need the real sweeps. The same
 * file guards the delivered-completion sweep's wiring (issue #3983).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const hungSuspectCalls: unknown[] = [];
const providerPausedCalls: unknown[] = [];
const deliveredCalls: Array<{ deps: Record<string, unknown>; opts: Record<string, unknown> }> = [];

vi.mock('./delivered-task-completion-sweep.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./delivered-task-completion-sweep.js')>();
  return {
    ...actual,
    autoCompleteDeliveredTasks: vi.fn(async (deps: Record<string, unknown>, opts: Record<string, unknown>) => {
      deliveredCalls.push({ deps, opts });
      return { completedTaskIds: [] };
    }),
  };
});

vi.mock('./hung-suspect-ttl-sweep.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./hung-suspect-ttl-sweep.js')>();
  return {
    ...actual,
    reclaimAgedHungSuspectTasks: vi.fn(async (deps: unknown) => {
      hungSuspectCalls.push(deps);
      return { reclaimedTaskIds: [] };
    }),
  };
});

vi.mock('./provider-paused-ttl-sweep.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./provider-paused-ttl-sweep.js')>();
  return {
    ...actual,
    reclaimAgedProviderPausedTasks: vi.fn(async (deps: unknown) => {
      providerPausedCalls.push(deps);
      return { reclaimedTaskIds: [], occupancy: { count: 0, oldestPauseAgeMs: null, taskIds: [] } };
    }),
  };
});

import { startLifecycleTimers, clearAllTimers, type TimerDeps } from './lifecycle-timers.js';
import { ProviderPausedStartTracker } from './provider-paused-ttl-sweep.js';
import { TaskStore } from '../core/tasks.js';
import { AttentionQueue } from '../core/attention-queue.js';
import { Watchdog } from '../core/watchdog.js';

function wiringDeps(overrides: Partial<TimerDeps> = {}): TimerDeps {
  return {
    monitor: {
      getSnapshot: () => [],
      getAgentEvents: () => [],
      applyWatchdogVerdict: vi.fn(() => false),
      sampleFindingEvidence: vi.fn(() => false),
      getCurrentAnomaly: vi.fn(),
      unregisterAgent: vi.fn(),
    } as TimerDeps['monitor'],
    taskStore: new TaskStore(),
    queue: new AttentionQueue(),
    adapter: {
      captureDisplay: vi.fn(async () => ''),
      stop: vi.fn(async () => undefined),
    } as TimerDeps['adapter'],
    adapterRegistry: {} as TimerDeps['adapterRegistry'],
    tokenTracker: {
      scanGrowth: vi.fn(async () => []),
      scanAll: vi.fn(async () => undefined),
      getTrackedTaskIds: vi.fn(() => []),
      getUsage: vi.fn(() => undefined),
      unregister: vi.fn(),
    } as TimerDeps['tokenTracker'],
    watchdog: new Watchdog(),
    hookWatcher: {
      drainNow: vi.fn(async () => undefined),
      stop: vi.fn(),
      isWatching: vi.fn(() => false),
      watch: vi.fn(),
    } as TimerDeps['hookWatcher'],
    terminalBackend: { listSessions: vi.fn(async () => []) } as TimerDeps['terminalBackend'],
    hooksDir: '/tmp/hooks',
    tasksFile: '/tmp/tasks.json',
    serverCwd: '/tmp/repo',
    saveIntervalMs: 600_000,
    livenessIntervalMs: 50,
    broadcastToAll: vi.fn(),
    ...overrides,
  };
}

describe('liveness tick wires delivery probes into the TTL reapers (issue #3578)', () => {
  afterEach(() => {
    vi.useRealTimers();
    hungSuspectCalls.length = 0;
    providerPausedCalls.length = 0;
  });

  test('both reapers receive resolveMergedPr and resolveMergedPrByBranch', async () => {
    vi.useFakeTimers();
    const resolveMergedPr = vi.fn(() => null);
    const resolveMergedPrByBranch = vi.fn(async () => null);

    const handles = startLifecycleTimers(wiringDeps({
      resolveMergedPr,
      resolveMergedPrByBranch,
      providerPausedStartTracker: new ProviderPausedStartTracker(),
    }));
    try {
      await vi.advanceTimersByTimeAsync(60);

      expect(hungSuspectCalls.length).toBeGreaterThan(0);
      expect(hungSuspectCalls[0]).toMatchObject({ resolveMergedPr, resolveMergedPrByBranch });
      expect(providerPausedCalls.length).toBeGreaterThan(0);
      expect(providerPausedCalls[0]).toMatchObject({ resolveMergedPr, resolveMergedPrByBranch });
    } finally {
      clearAllTimers(handles);
    }
  });
});

describe('liveness tick wires the quota poller into the provider-paused reaper (issue #3562)', () => {
  afterEach(() => {
    vi.useRealTimers();
    hungSuspectCalls.length = 0;
    providerPausedCalls.length = 0;
  });

  test('passes getProviderResetSource reading the quota adapter snapshot and state', async () => {
    vi.useFakeTimers();
    const snap = { fiveHour: null, sevenDay: null, updatedAt: 1 };
    const quotaAdapter = {
      getLatest: vi.fn(() => snap),
      getState: vi.fn(() => 'backoff' as const),
      getCurrentIntervalMs: vi.fn(() => 600_000),
      poll: vi.fn(async () => false),
    } as unknown as TimerDeps['quotaAdapter'];

    const handles = startLifecycleTimers(wiringDeps({
      quotaAdapter,
      providerPausedStartTracker: new ProviderPausedStartTracker(),
    }));
    try {
      await vi.advanceTimersByTimeAsync(60);
      expect(providerPausedCalls.length).toBeGreaterThan(0);
      const deps = providerPausedCalls[0] as {
        getProviderResetSource?: () => unknown;
      };
      expect(deps.getProviderResetSource?.()).toEqual({ quota: snap, pollerState: 'backoff' });
    } finally {
      clearAllTimers(handles);
    }
  });

  test('omits getProviderResetSource when no quota adapter is wired', async () => {
    vi.useFakeTimers();
    const handles = startLifecycleTimers(wiringDeps({
      providerPausedStartTracker: new ProviderPausedStartTracker(),
    }));
    try {
      await vi.advanceTimersByTimeAsync(60);
      expect(providerPausedCalls.length).toBeGreaterThan(0);
      expect(providerPausedCalls[0]).not.toHaveProperty('getProviderResetSource');
    } finally {
      clearAllTimers(handles);
    }
  });
});

describe('liveness tick wires the delivered-completion sweep (issue #3983)', () => {
  // Earlier tests in this file wire a resolver too, so their sweeps were captured.
  beforeEach(() => {
    hungSuspectCalls.length = 0;
    deliveredCalls.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    hungSuspectCalls.length = 0;
    providerPausedCalls.length = 0;
    deliveredCalls.length = 0;
  });

  test('passes the budget, the settle time and the three live-work veto readers', async () => {
    vi.useFakeTimers();
    const isTaskHoldingOpenPr = vi.fn(() => undefined);
    const isTaskSelectedByAnyConnection = vi.fn(() => false);
    const taskTailStore = {
      getByTaskId: vi.fn(async (taskId: string) => (taskId === 't1' ? { text: 'pane text of t1' } : null)),
    } as unknown as TimerDeps['taskTailStore'];

    const handles = startLifecycleTimers(wiringDeps({
      resolveMergedPr: vi.fn(() => null),
      getPostMergeCleanupBudgetMs: () => 1_234_000,
      getMergedFinishedSettleMs: () => 567_000,
      isTaskHoldingOpenPr,
      isTaskSelectedByAnyConnection,
      taskTailStore,
    }));
    try {
      await vi.waitFor(() => expect(deliveredCalls.length).toBeGreaterThan(0));

      const { deps, opts } = deliveredCalls[0];
      expect(opts).toMatchObject({ budgetMs: 1_234_000, settleMs: 567_000 });
      expect(deps.isHoldingOpenPr).toBe(isTaskHoldingOpenPr);
      expect(deps.isTaskSelectedByAnyConnection).toBe(isTaskSelectedByAnyConnection);
      const getTaskPaneText = deps.getTaskPaneText as (taskId: string) => Promise<string | undefined>;
      expect(await getTaskPaneText('t1')).toBe('pane text of t1');
      expect(await getTaskPaneText('t2')).toBeUndefined();
    } finally {
      clearAllTimers(handles);
    }
  });

  test('a failing pane-text read reads as no pane text, not as an error', async () => {
    vi.useFakeTimers();
    const taskTailStore = {
      getByTaskId: vi.fn(async () => { throw new Error('disk gone'); }),
    } as unknown as TimerDeps['taskTailStore'];

    const handles = startLifecycleTimers(wiringDeps({ resolveMergedPr: vi.fn(() => null), taskTailStore }));
    try {
      await vi.waitFor(() => expect(deliveredCalls.length).toBeGreaterThan(0));

      const getTaskPaneText = deliveredCalls[0].deps.getTaskPaneText as (taskId: string) => Promise<string | undefined>;
      await expect(getTaskPaneText('t1')).resolves.toBeUndefined();
    } finally {
      clearAllTimers(handles);
    }
  });

  test('the sweep is skipped when no merge-attribution resolver is wired', async () => {
    vi.useFakeTimers();
    const handles = startLifecycleTimers(wiringDeps());
    try {
      await vi.waitFor(() => expect(hungSuspectCalls.length).toBeGreaterThan(0));
      expect(deliveredCalls).toHaveLength(0);
    } finally {
      clearAllTimers(handles);
    }
  });
});

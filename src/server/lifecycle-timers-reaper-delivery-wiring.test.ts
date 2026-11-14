/**
 * Wiring guard for issue #3578: the liveness tick must hand both delivery
 * probes to both TTL reapers. Without this wiring the provider-paused reaper
 * keeps labelling already-merged work "not delivered", and neither reaper
 * gets the branch-keyed fallback — while every sweep-level test stays green.
 *
 * The sweeps are mocked here (module-wide), so this lives apart from
 * lifecycle-timers.test.ts, whose other tests need the real sweeps.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';

const hungSuspectCalls: unknown[] = [];
const providerPausedCalls: unknown[] = [];

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

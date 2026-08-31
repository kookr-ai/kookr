import { describe, expect, test } from 'vitest';
import {
  collectTriggers,
  countSpawnsInWindow,
  evaluateDisabledPressureAutoEnable,
  evaluatePressureWhileDisabled,
  evaluateResourceWatchdog,
  pruneSpawnTimestamps,
} from './resource-watchdog-eval.js';
import { emptyResourceWatchdogState, recordSpawn } from './resource-watchdog-state.js';
import type {
  ResourceWatchdogConfig,
  ResourceWatchdogPersistedState,
  ResourceWatchdogSample,
} from './resource-watchdog-types.js';

const BASE_CONFIG: Pick<
  ResourceWatchdogConfig,
  | 'enabled'
  | 'swapUsedPercentThreshold'
  | 'memAvailableMbFloor'
  | 'processCeiling'
  | 'orphanCeiling'
  | 'throttleMs'
  | 'spawnBudget24h'
  | 'spawnBudgetWindowMs'
> = {
  enabled: true,
  swapUsedPercentThreshold: 50,
  memAvailableMbFloor: 512,
  processCeiling: 40,
  orphanCeiling: 5,
  throttleMs: 30 * 60 * 1000,
  spawnBudget24h: 4,
  spawnBudgetWindowMs: 24 * 60 * 60 * 1000,
};

function sample(overrides: Partial<ResourceWatchdogSample> = {}): ResourceWatchdogSample {
  return {
    sampledAt: '2026-07-31T12:00:00.000Z',
    swapUsedPercent: 10,
    memAvailableMb: 4096,
    oomKillTotal: 0,
    processCounts: { claude: 2, grok: 1, codex: 1, dtach: 4 },
    orphanSessionCount: 0,
    terminalLeakCount: 0,
    topConsumers: [],
    ...overrides,
  };
}

describe('collectTriggers', () => {
  test('fires on swap percent at/above threshold', () => {
    const triggers = collectTriggers(sample({ swapUsedPercent: 50 }), null, BASE_CONFIG);
    expect(triggers.map((t) => t.reason)).toContain('swap_percent');
  });

  test('fires on mem available at/below floor', () => {
    const triggers = collectTriggers(sample({ memAvailableMb: 512 }), null, BASE_CONFIG);
    expect(triggers.map((t) => t.reason)).toContain('mem_available');
  });

  test('fires on process ceiling per agent family', () => {
    const triggers = collectTriggers(
      sample({ processCounts: { claude: 40, grok: 0, codex: 0, dtach: 0 } }),
      null,
      BASE_CONFIG,
    );
    expect(triggers).toEqual([
      expect.objectContaining({ reason: 'process_ceiling', observed: 40 }),
    ]);
  });

  test('does not apply process ceiling to dtach alone', () => {
    const triggers = collectTriggers(
      sample({ processCounts: { claude: 0, grok: 0, codex: 0, dtach: 100 } }),
      null,
      BASE_CONFIG,
    );
    expect(triggers.filter((t) => t.reason === 'process_ceiling')).toHaveLength(0);
  });

  test('fires on orphan ceiling', () => {
    const triggers = collectTriggers(sample({ orphanSessionCount: 5 }), null, BASE_CONFIG);
    expect(triggers.map((t) => t.reason)).toContain('orphan_ceiling');
  });

  test('oom_kill delta is an immediate trigger independent of thresholds', () => {
    const triggers = collectTriggers(
      sample({
        swapUsedPercent: 0,
        memAvailableMb: 16_000,
        oomKillTotal: 3,
        processCounts: { claude: 0, grok: 0, codex: 0, dtach: 0 },
        orphanSessionCount: 0,
      }),
      1,
      { ...BASE_CONFIG, swapUsedPercentThreshold: 0, memAvailableMbFloor: 0, processCeiling: 0, orphanCeiling: 0 },
    );
    expect(triggers).toEqual([
      expect.objectContaining({ reason: 'oom_kill_delta', observed: 2, threshold: 0 }),
    ]);
  });

  test('no oom_kill trigger when counter is flat or first sample', () => {
    expect(collectTriggers(sample({ oomKillTotal: 5 }), 5, BASE_CONFIG)
      .filter((t) => t.reason === 'oom_kill_delta')).toHaveLength(0);
    expect(collectTriggers(sample({ oomKillTotal: 5 }), null, BASE_CONFIG)
      .filter((t) => t.reason === 'oom_kill_delta')).toHaveLength(0);
  });

  test('threshold 0 disables that rule', () => {
    const triggers = collectTriggers(
      sample({ swapUsedPercent: 99, memAvailableMb: 1, orphanSessionCount: 99 }),
      null,
      { ...BASE_CONFIG, swapUsedPercentThreshold: 0, memAvailableMbFloor: 0, orphanCeiling: 0, processCeiling: 0 },
    );
    expect(triggers).toHaveLength(0);
  });
});

describe('evaluateResourceWatchdog', () => {
  test('idle when disabled even under pressure', () => {
    const decision = evaluateResourceWatchdog({
      sample: sample({ swapUsedPercent: 90 }),
      previousOomKillTotal: null,
      state: emptyResourceWatchdogState(),
      config: { ...BASE_CONFIG, enabled: false },
      nowMs: Date.parse('2026-07-31T12:00:00.000Z'),
    });
    expect(decision.action).toBe('idle');
  });

  test('idle when no triggers', () => {
    const decision = evaluateResourceWatchdog({
      sample: sample(),
      previousOomKillTotal: 0,
      state: emptyResourceWatchdogState(),
      config: BASE_CONFIG,
      nowMs: Date.parse('2026-07-31T12:00:00.000Z'),
    });
    expect(decision.action).toBe('idle');
  });

  test('spawns investigation on first pressure event', () => {
    const decision = evaluateResourceWatchdog({
      sample: sample({ swapUsedPercent: 80 }),
      previousOomKillTotal: null,
      state: emptyResourceWatchdogState(),
      config: BASE_CONFIG,
      nowMs: Date.parse('2026-07-31T12:00:00.000Z'),
    });
    expect(decision).toMatchObject({
      action: 'spawn',
      kind: 'investigation',
      spawnsInWindow: 0,
    });
  });

  test('30-min throttle suppresses a second spawn', () => {
    const t0 = Date.parse('2026-07-31T12:00:00.000Z');
    const state: ResourceWatchdogPersistedState = {
      ...emptyResourceWatchdogState(),
      lastSpawnAt: new Date(t0).toISOString(),
      spawnTimestamps: [new Date(t0).toISOString()],
      lastSpawnKind: 'investigation',
    };
    const decision = evaluateResourceWatchdog({
      sample: sample({ swapUsedPercent: 90 }),
      previousOomKillTotal: null,
      state,
      config: BASE_CONFIG,
      nowMs: t0 + 10 * 60 * 1000, // 10 min later
    });
    expect(decision).toMatchObject({
      action: 'suppress_throttled',
      throttleRemainingMs: 20 * 60 * 1000,
    });
  });

  test('throttle opens after throttleMs elapses', () => {
    const t0 = Date.parse('2026-07-31T12:00:00.000Z');
    const state: ResourceWatchdogPersistedState = {
      ...emptyResourceWatchdogState(),
      lastSpawnAt: new Date(t0).toISOString(),
      spawnTimestamps: [new Date(t0).toISOString()],
    };
    const decision = evaluateResourceWatchdog({
      sample: sample({ swapUsedPercent: 90 }),
      previousOomKillTotal: null,
      state,
      config: BASE_CONFIG,
      nowMs: t0 + 30 * 60 * 1000,
    });
    expect(decision.action).toBe('spawn');
  });

  test('throttle persists across simulated restart (state reload)', () => {
    const t0 = Date.parse('2026-07-31T12:00:00.000Z');
    // Simulate: service recorded a spawn, wrote state, process restarted, reloaded state.
    const reloaded: ResourceWatchdogPersistedState = {
      schemaVersion: 1,
      spawnTimestamps: [new Date(t0).toISOString()],
      lastSpawnAt: new Date(t0).toISOString(),
      lastSpawnKind: 'investigation',
      lastSpawnTaskId: 'task-1',
      lastTriggerAt: new Date(t0).toISOString(),
      lastTriggerReasons: ['swap_percent'],
      lastMetaReflectionAt: null,
      oomKillBaseline: null,
    };
    const decision = evaluateResourceWatchdog({
      sample: sample({ swapUsedPercent: 95 }),
      previousOomKillTotal: null,
      state: reloaded,
      config: BASE_CONFIG,
      nowMs: t0 + 5 * 60 * 1000,
    });
    expect(decision.action).toBe('suppress_throttled');
  });

  test('24h budget switches next spawn to meta_reflection', () => {
    const nowMs = Date.parse('2026-07-31T20:00:00.000Z');
    // Four prior spawns inside the window, last one older than throttle.
    const timestamps = [0, 1, 2, 3].map((i) =>
      new Date(nowMs - (5 - i) * 60 * 60 * 1000).toISOString(),
    );
    const state: ResourceWatchdogPersistedState = {
      ...emptyResourceWatchdogState(),
      spawnTimestamps: timestamps,
      lastSpawnAt: timestamps[3]!,
      lastSpawnKind: 'investigation',
    };
    const decision = evaluateResourceWatchdog({
      sample: sample({ swapUsedPercent: 90 }),
      previousOomKillTotal: null,
      state,
      config: BASE_CONFIG,
      nowMs,
    });
    expect(decision).toMatchObject({
      action: 'spawn',
      kind: 'meta_reflection',
      spawnsInWindow: 4,
    });
  });

  test('after one meta-reflection in the window, further pressure is suppressed (no meta thrash)', () => {
    const nowMs = Date.parse('2026-07-31T20:00:00.000Z');
    const timestamps = [0, 1, 2, 3].map((i) =>
      new Date(nowMs - (5 - i) * 60 * 60 * 1000).toISOString(),
    );
    const state: ResourceWatchdogPersistedState = {
      ...emptyResourceWatchdogState(),
      spawnTimestamps: timestamps,
      lastSpawnAt: timestamps[3]!,
      lastSpawnKind: 'meta_reflection',
      lastMetaReflectionAt: timestamps[3]!,
    };
    // Throttle elapsed (last spawn 5h ago) but meta still in window.
    const decision = evaluateResourceWatchdog({
      sample: sample({ swapUsedPercent: 90 }),
      previousOomKillTotal: null,
      state,
      config: BASE_CONFIG,
      nowMs,
    });
    expect(decision.action).toBe('suppress_throttled');
  });

  test('spawns older than 24h do not count toward budget', () => {
    const nowMs = Date.parse('2026-07-31T20:00:00.000Z');
    const old = new Date(nowMs - 25 * 60 * 60 * 1000).toISOString();
    const state: ResourceWatchdogPersistedState = {
      ...emptyResourceWatchdogState(),
      spawnTimestamps: [old, old, old, old, old],
      lastSpawnAt: old,
    };
    const decision = evaluateResourceWatchdog({
      sample: sample({ swapUsedPercent: 90 }),
      previousOomKillTotal: null,
      state,
      config: BASE_CONFIG,
      nowMs,
    });
    expect(decision).toMatchObject({
      action: 'spawn',
      kind: 'investigation',
      spawnsInWindow: 0,
    });
  });

  test('oom_kill delta alone is enough to spawn', () => {
    const decision = evaluateResourceWatchdog({
      sample: sample({ oomKillTotal: 2 }),
      previousOomKillTotal: 1,
      state: emptyResourceWatchdogState(),
      config: BASE_CONFIG,
      nowMs: Date.parse('2026-07-31T12:00:00.000Z'),
    });
    expect(decision).toMatchObject({
      action: 'spawn',
      kind: 'investigation',
    });
    if (decision.action === 'spawn') {
      expect(decision.triggers.map((t) => t.reason)).toContain('oom_kill_delta');
    }
  });
});

describe('spawn window helpers + recordSpawn', () => {
  test('countSpawnsInWindow and pruneSpawnTimestamps', () => {
    const nowMs = 1_000_000;
    const stamps = [
      new Date(nowMs - 100).toISOString(),
      new Date(nowMs - 500).toISOString(),
      new Date(nowMs - 2000).toISOString(),
    ];
    expect(countSpawnsInWindow(stamps, nowMs, 1000)).toBe(2);
    expect(pruneSpawnTimestamps(stamps, nowMs, 1000)).toHaveLength(2);
  });

  test('recordSpawn appends timestamp and updates last* fields', () => {
    const nowMs = Date.parse('2026-07-31T12:00:00.000Z');
    const next = recordSpawn({
      state: emptyResourceWatchdogState(),
      nowIso: new Date(nowMs).toISOString(),
      nowMs,
      kind: 'meta_reflection',
      taskId: 't-1',
      triggerReasons: ['oom_kill_delta'],
      retainMs: 24 * 60 * 60 * 1000,
    });
    expect(next.spawnTimestamps).toHaveLength(1);
    expect(next.lastSpawnKind).toBe('meta_reflection');
    expect(next.lastMetaReflectionAt).toBe(next.lastSpawnAt);
    expect(next.lastSpawnTaskId).toBe('t-1');
  });
});

describe('evaluatePressureWhileDisabled (issue #2039 / #2354)', () => {
  test('true when disabled and dtach count meets soft bound', () => {
    expect(
      evaluatePressureWhileDisabled({ enabled: false, dtachCount: 21, softBound: 20 }),
    ).toEqual({
      pressureWhileDisabled: true,
      pressureWhileDisabledReason: expect.stringContaining('staleProcesses.dtach.count=21'),
    });
    const hit = evaluatePressureWhileDisabled({
      enabled: false,
      dtachCount: 40,
      softBound: 40,
    });
    expect(hit.pressureWhileDisabled).toBe(true);
    expect(hit.pressureWhileDisabledReason).toContain('soft bound 40');
    expect(hit.pressureWhileDisabledReason).toContain('KOOKR_RESOURCE_WATCHDOG=1');
    expect(hit.pressureWhileDisabledReason).toContain('auto-enable');
  });

  test('page-only reason when autoEnableOnPressure is false', () => {
    const hit = evaluatePressureWhileDisabled({
      enabled: false,
      dtachCount: 25,
      softBound: 20,
      autoEnableOnPressure: false,
    });
    expect(hit.pressureWhileDisabled).toBe(true);
    expect(hit.pressureWhileDisabledReason).toContain('will not spawn');
    expect(hit.pressureWhileDisabledReason).toContain('AUTO_ENABLE=0');
  });

  test('false when enabled even with high dtach', () => {
    expect(
      evaluatePressureWhileDisabled({ enabled: true, dtachCount: 99, softBound: 20 }),
    ).toEqual({ pressureWhileDisabled: false, pressureWhileDisabledReason: null });
  });

  test('false when disabled but pressure is low or unknown', () => {
    expect(
      evaluatePressureWhileDisabled({ enabled: false, dtachCount: 5, softBound: 40 }),
    ).toEqual({ pressureWhileDisabled: false, pressureWhileDisabledReason: null });
    expect(
      evaluatePressureWhileDisabled({ enabled: false, dtachCount: null, softBound: 40 }),
    ).toEqual({ pressureWhileDisabled: false, pressureWhileDisabledReason: null });
  });

  test('softBound 0 disables the check', () => {
    expect(
      evaluatePressureWhileDisabled({ enabled: false, dtachCount: 100, softBound: 0 }),
    ).toEqual({ pressureWhileDisabled: false, pressureWhileDisabledReason: null });
  });
});

describe('evaluateDisabledPressureAutoEnable (issue #2354)', () => {
  const nowMs = Date.parse('2026-08-12T12:00:00.000Z');
  const throttleMs = 30 * 60 * 1000;
  const spawnBudgetWindowMs = 24 * 60 * 60 * 1000;

  test('stay_disabled when master enabled, auto-enable off, or no pressure', () => {
    expect(
      evaluateDisabledPressureAutoEnable({
        enabled: true,
        autoEnableOnPressure: true,
        dtachCount: 99,
        state: emptyResourceWatchdogState(),
        throttleMs,
        spawnBudget24h: 4,
        spawnBudgetWindowMs,
        nowMs,
      }),
    ).toEqual({ action: 'stay_disabled' });

    expect(
      evaluateDisabledPressureAutoEnable({
        enabled: false,
        autoEnableOnPressure: false,
        dtachCount: 99,
        state: emptyResourceWatchdogState(),
        throttleMs,
        spawnBudget24h: 4,
        spawnBudgetWindowMs,
        nowMs,
      }),
    ).toEqual({ action: 'stay_disabled' });

    expect(
      evaluateDisabledPressureAutoEnable({
        enabled: false,
        autoEnableOnPressure: true,
        dtachCount: 5,
        state: emptyResourceWatchdogState(),
        throttleMs,
        spawnBudget24h: 4,
        spawnBudgetWindowMs,
        nowMs,
      }),
    ).toEqual({ action: 'stay_disabled' });
  });

  test('spawns investigation when soft-bound pressure trips and budget open', () => {
    const decision = evaluateDisabledPressureAutoEnable({
      enabled: false,
      autoEnableOnPressure: true,
      dtachCount: 33,
      softBound: 20,
      state: emptyResourceWatchdogState(),
      throttleMs,
      spawnBudget24h: 4,
      spawnBudgetWindowMs,
      nowMs,
    });
    expect(decision).toMatchObject({
      action: 'spawn',
      kind: 'investigation',
      spawnsInWindow: 0,
    });
    if (decision.action === 'spawn') {
      expect(decision.triggers[0]?.reason).toBe('dtach_soft_bound');
      expect(decision.triggers[0]?.observed).toBe(33);
    }
  });

  test('suppress_throttled when a recent spawn is inside throttle window', () => {
    const lastSpawnAt = new Date(nowMs - 5 * 60 * 1000).toISOString();
    const state = recordSpawn({
      state: emptyResourceWatchdogState(),
      nowIso: lastSpawnAt,
      nowMs: nowMs - 5 * 60 * 1000,
      kind: 'investigation',
      taskId: 't-prev',
      triggerReasons: ['dtach_soft_bound'],
      retainMs: spawnBudgetWindowMs,
    });
    const decision = evaluateDisabledPressureAutoEnable({
      enabled: false,
      autoEnableOnPressure: true,
      dtachCount: 40,
      state,
      throttleMs,
      spawnBudget24h: 4,
      spawnBudgetWindowMs,
      nowMs,
    });
    expect(decision.action).toBe('suppress_throttled');
    if (decision.action === 'suppress_throttled') {
      expect(decision.throttleRemainingMs).toBeGreaterThan(0);
      expect(decision.triggers[0]?.reason).toBe('dtach_soft_bound');
    }
  });

  test('meta_reflection when 24h spawn budget is exhausted', () => {
    let state = emptyResourceWatchdogState();
    for (let i = 0; i < 4; i += 1) {
      const t = nowMs - (i + 1) * 60 * 60 * 1000;
      state = recordSpawn({
        state,
        nowIso: new Date(t).toISOString(),
        nowMs: t,
        kind: 'investigation',
        taskId: `t-${i}`,
        triggerReasons: ['dtach_soft_bound'],
        retainMs: spawnBudgetWindowMs,
      });
    }
    // Advance past throttle from the most recent spawn.
    const afterThrottle = nowMs + throttleMs + 1;
    const decision = evaluateDisabledPressureAutoEnable({
      enabled: false,
      autoEnableOnPressure: true,
      dtachCount: 50,
      state,
      throttleMs,
      spawnBudget24h: 4,
      spawnBudgetWindowMs,
      nowMs: afterThrottle,
    });
    expect(decision).toMatchObject({
      action: 'spawn',
      kind: 'meta_reflection',
      spawnsInWindow: 4,
    });
  });

  test('suppresses further meta thrash once meta_reflection is already in window', () => {
    let state = emptyResourceWatchdogState();
    for (let i = 0; i < 4; i += 1) {
      const t = nowMs - (i + 2) * 60 * 60 * 1000;
      state = recordSpawn({
        state,
        nowIso: new Date(t).toISOString(),
        nowMs: t,
        kind: 'investigation',
        taskId: `t-${i}`,
        triggerReasons: ['dtach_soft_bound'],
        retainMs: spawnBudgetWindowMs,
      });
    }
    const metaAt = nowMs - throttleMs - 1;
    state = recordSpawn({
      state,
      nowIso: new Date(metaAt).toISOString(),
      nowMs: metaAt,
      kind: 'meta_reflection',
      taskId: 't-meta',
      triggerReasons: ['dtach_soft_bound'],
      retainMs: spawnBudgetWindowMs,
    });
    const decision = evaluateDisabledPressureAutoEnable({
      enabled: false,
      autoEnableOnPressure: true,
      dtachCount: 55,
      state,
      throttleMs,
      spawnBudget24h: 4,
      spawnBudgetWindowMs,
      nowMs,
    });
    expect(decision.action).toBe('suppress_throttled');
  });
});

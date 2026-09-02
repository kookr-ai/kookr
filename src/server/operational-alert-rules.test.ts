import { describe, expect, test } from 'vitest';
import {
  createOperationalAlertEvaluator,
  OperationalAlertEvaluator,
  OPERATIONAL_ALERT_AGENT_ID,
} from './operational-alert-rules.js';
import type { OperationalAlertConfig } from './config.js';
import type { ServerMessage, SystemResourceStatus } from '../shared/contracts/messages.js';
import type { CircuitBreakerSnapshot, CircuitBreakerState } from '../shared/contracts/circuit-breaker.js';
import { PersistenceHealthTracker } from '../core/persistence-health.js';
import { ProviderHealthTracker } from '../core/provider-health.js';
import type { ProviderHealthSnapshot } from '../shared/contracts/provider-health.js';

const DISABLED: OperationalAlertConfig = {
  cpuPercent: 0,
  memoryPercent: 0,
  eventLoopDelayMs: 0,
  processRssBytes: 0,
  dataDirectoryFreePercent: 0,
  dataDirectoryFreeBytes: 0,
  circuitBreakerOpenMs: 0,
  providerFallbackSubstitutions: 0,
  providerFallbackWindowMs: 0,
  providerPausedMs: 0,
  sustainSamples: 3,
};

interface SampleOverrides {
  cpuUsagePercent?: number | null;
  memoryUsedPercent?: number | null;
  eventLoopDelayP95Ms?: number | null;
  processRssBytes?: number | null;
  dataDirectoryDiskFreeBytes?: number | null;
  dataDirectoryDiskTotalBytes?: number | null;
  dataDirectoryDiskFreePercent?: number | null;
  sampledAt?: string;
  circuitBreakers?: CircuitBreakerSnapshot[];
  unavailable?: SystemResourceStatus['unavailable'];
  stale?: SystemResourceStatus['stale'];
}

function status(overrides: SampleOverrides = {}): SystemResourceStatus {
  return {
    source: { kind: 'server-host' },
    sampledAt: overrides.sampledAt ?? '2026-05-13T00:00:00.000Z',
    sampleGapMs: null,
    timerDriftMs: null,
    circuitBreakers: overrides.circuitBreakers,
    host: {
      cpuUsagePercent: overrides.cpuUsagePercent ?? null,
      memoryUsedPercent: overrides.memoryUsedPercent ?? null,
      memoryFreeBytes: null,
      memoryTotalBytes: null,
      dataDirectory: {
        path: '/tmp/kookr-data',
        diskFreeBytes: overrides.dataDirectoryDiskFreeBytes ?? null,
        diskTotalBytes: overrides.dataDirectoryDiskTotalBytes ?? null,
        diskFreePercent: overrides.dataDirectoryDiskFreePercent ?? null,
      },
    },
    server: {
      eventLoopDelayP95Ms: overrides.eventLoopDelayP95Ms ?? null,
      processRssBytes: overrides.processRssBytes ?? null,
      processHeapUsedBytes: null,
      processHeapTotalBytes: null,
    },
    unavailable: overrides.unavailable ?? [],
    stale: overrides.stale,
  };
}

/** A stale fallback marker for a sample whose fields carry last-good values. */
function staleMarker(ageMs = 5_000): NonNullable<SystemResourceStatus['stale']> {
  return { reason: 'sampler_error', lastGoodAt: '2026-05-13T00:00:00.000Z', ageMs };
}

function breakerSnapshot(overrides: {
  name?: string;
  state: CircuitBreakerState;
  lastStateChange: number;
}): CircuitBreakerSnapshot {
  return {
    name: overrides.name ?? 'llm',
    state: overrides.state,
    failureCount: overrides.state === 'open' ? 5 : 0,
    successCount: 0,
    rejectedCalls: 0,
    tripCount: overrides.state === 'open' ? 1 : 0,
    lastFailureTime: overrides.state === 'open' ? overrides.lastStateChange : null,
    lastStateChange: overrides.lastStateChange,
    resetTimeoutMs: 30_000,
  };
}

type AlertMessage = Extract<ServerMessage, { type: 'alert' }>;

function alertsFor(evaluator: OperationalAlertEvaluator, sample: SystemResourceStatus): AlertMessage[] {
  return evaluator.evaluate(sample).filter((m): m is AlertMessage => m.type === 'alert');
}

describe('OperationalAlertEvaluator', () => {
  test('hasEnabledRules reflects whether any threshold is positive', () => {
    expect(createOperationalAlertEvaluator(DISABLED).hasEnabledRules()).toBe(false);
    expect(
      createOperationalAlertEvaluator({ ...DISABLED, cpuPercent: 90 }).hasEnabledRules(),
    ).toBe(true);
    expect(
      createOperationalAlertEvaluator({ ...DISABLED, dataDirectoryFreePercent: 5 }).hasEnabledRules(),
    ).toBe(true);
    const persistenceHealth = new PersistenceHealthTracker();
    expect(createOperationalAlertEvaluator(DISABLED, () => persistenceHealth.snapshot()).hasEnabledRules()).toBe(true);
  });

  test('a sustained crossing fires exactly once after the sustain count', () => {
    const evaluator = createOperationalAlertEvaluator({
      ...DISABLED,
      eventLoopDelayMs: 100,
      sustainSamples: 3,
    });

    // Two breaching samples build toward the threshold but do not fire yet.
    expect(alertsFor(evaluator, status({ eventLoopDelayP95Ms: 250 }))).toEqual([]);
    expect(alertsFor(evaluator, status({ eventLoopDelayP95Ms: 250 }))).toEqual([]);

    // Third consecutive breach fires a single warning alert.
    const fired = alertsFor(evaluator, status({ eventLoopDelayP95Ms: 250 }));
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      type: 'alert',
      agentId: OPERATIONAL_ALERT_AGENT_ID,
      severity: 'warning',
    });
    expect(fired[0].summary).toContain('event-loop delay');
    expect(fired[0].operationalAlert).toEqual({
      key: 'resource:event_loop_delay',
      metric: 'event_loop_delay',
      state: 'fired',
    });

    // Further breaches while already firing do not re-alert.
    expect(alertsFor(evaluator, status({ eventLoopDelayP95Ms: 300 }))).toEqual([]);
    expect(alertsFor(evaluator, status({ eventLoopDelayP95Ms: 300 }))).toEqual([]);
  });

  describe('stale fallback tick (issue #2771)', () => {
    test('a stale sample never clears an active alert, even when its last-good value reads below threshold', () => {
      const evaluator = createOperationalAlertEvaluator({
        ...DISABLED,
        eventLoopDelayMs: 100,
        sustainSamples: 2,
      });

      // Fire the alert with two sustained breaches.
      expect(alertsFor(evaluator, status({ eventLoopDelayP95Ms: 250 }))).toEqual([]);
      expect(alertsFor(evaluator, status({ eventLoopDelayP95Ms: 250 }))).toHaveLength(1);

      // A stale tick whose (last-good) value now reads BELOW the threshold must
      // NOT recover the alert — the sample is not a fresh reading. Without the
      // hold this would emit a false "recovered" alert.
      const staleBelow = alertsFor(
        evaluator,
        status({ eventLoopDelayP95Ms: 10, stale: staleMarker() }),
      );
      expect(staleBelow).toEqual([]);

      // A genuine fresh sample below threshold then recovers normally.
      const recovered = alertsFor(evaluator, status({ eventLoopDelayP95Ms: 10 }));
      expect(recovered).toHaveLength(1);
      expect(recovered[0].severity).toBe('info');
    });

    test('a stale sample does not advance the breach counter toward a false fire', () => {
      const evaluator = createOperationalAlertEvaluator({
        ...DISABLED,
        eventLoopDelayMs: 100,
        sustainSamples: 3,
      });

      // One real breach, then a burst of stale ticks whose last-good value is
      // above threshold. If stale ticks counted, three of them would fire.
      expect(alertsFor(evaluator, status({ eventLoopDelayP95Ms: 250 }))).toEqual([]);
      expect(alertsFor(evaluator, status({ eventLoopDelayP95Ms: 250, stale: staleMarker() }))).toEqual([]);
      expect(alertsFor(evaluator, status({ eventLoopDelayP95Ms: 250, stale: staleMarker() }))).toEqual([]);
      expect(alertsFor(evaluator, status({ eventLoopDelayP95Ms: 250, stale: staleMarker() }))).toEqual([]);

      // Only the next two FRESH breaches complete the sustain window (1 + 2 = 3).
      expect(alertsFor(evaluator, status({ eventLoopDelayP95Ms: 250 }))).toEqual([]);
      expect(alertsFor(evaluator, status({ eventLoopDelayP95Ms: 250 }))).toHaveLength(1);
    });

    test('a stale sample holds a firing disk-pressure alert', () => {
      const evaluator = createOperationalAlertEvaluator({
        ...DISABLED,
        dataDirectoryFreePercent: 10,
        sustainSamples: 2,
      });

      // Fire the disk-free alert with two sustained low-free samples.
      expect(alertsFor(evaluator, status({ dataDirectoryDiskFreePercent: 5 }))).toEqual([]);
      expect(alertsFor(evaluator, status({ dataDirectoryDiskFreePercent: 5 }))).toHaveLength(1);

      // A stale tick whose last-good free% reads healthy must not recover it.
      expect(
        alertsFor(evaluator, status({ dataDirectoryDiskFreePercent: 90, stale: staleMarker() })),
      ).toEqual([]);

      // A fresh healthy sample recovers normally.
      const recovered = alertsFor(evaluator, status({ dataDirectoryDiskFreePercent: 90 }));
      expect(recovered).toHaveLength(1);
      expect(recovered[0].severity).toBe('info');
    });

    test('a stale sample holds a firing process-RSS alert', () => {
      const evaluator = createOperationalAlertEvaluator({
        ...DISABLED,
        processRssBytes: 1_000,
        sustainSamples: 2,
      });

      expect(alertsFor(evaluator, status({ processRssBytes: 2_000 }))).toEqual([]);
      expect(alertsFor(evaluator, status({ processRssBytes: 2_000 }))).toHaveLength(1);

      // Stale tick whose last-good RSS reads low must not recover the alert.
      expect(
        alertsFor(evaluator, status({ processRssBytes: 10, stale: staleMarker() })),
      ).toEqual([]);

      const recovered = alertsFor(evaluator, status({ processRssBytes: 10 }));
      expect(recovered).toHaveLength(1);
      expect(recovered[0].severity).toBe('info');
    });

    // The disk and RSS rules live in their own evaluator functions with an
    // independent `status.stale` gate (not the shared `this.rules` loop the
    // event-loop false-breach test above exercises), so assert the false-breach
    // direction directly for each of those separate code paths too.
    test('a stale sample does not advance the disk-pressure breach counter toward a false fire', () => {
      const evaluator = createOperationalAlertEvaluator({
        ...DISABLED,
        dataDirectoryFreePercent: 10,
        sustainSamples: 3,
      });

      // One real breach, then stale breaching ticks that must NOT count.
      expect(alertsFor(evaluator, status({ dataDirectoryDiskFreePercent: 5 }))).toEqual([]);
      expect(alertsFor(evaluator, status({ dataDirectoryDiskFreePercent: 5, stale: staleMarker() }))).toEqual([]);
      expect(alertsFor(evaluator, status({ dataDirectoryDiskFreePercent: 5, stale: staleMarker() }))).toEqual([]);

      // Only the next two FRESH breaches complete the sustain window (1 + 2 = 3).
      expect(alertsFor(evaluator, status({ dataDirectoryDiskFreePercent: 5 }))).toEqual([]);
      expect(alertsFor(evaluator, status({ dataDirectoryDiskFreePercent: 5 }))).toHaveLength(1);
    });

    test('a stale sample does not advance the process-RSS breach counter toward a false fire', () => {
      const evaluator = createOperationalAlertEvaluator({
        ...DISABLED,
        processRssBytes: 1_000,
        sustainSamples: 3,
      });

      expect(alertsFor(evaluator, status({ processRssBytes: 2_000 }))).toEqual([]);
      expect(alertsFor(evaluator, status({ processRssBytes: 2_000, stale: staleMarker() }))).toEqual([]);
      expect(alertsFor(evaluator, status({ processRssBytes: 2_000, stale: staleMarker() }))).toEqual([]);

      expect(alertsFor(evaluator, status({ processRssBytes: 2_000 }))).toEqual([]);
      expect(alertsFor(evaluator, status({ processRssBytes: 2_000 }))).toHaveLength(1);
    });
  });

  test('values below the threshold never fire', () => {
    const evaluator = createOperationalAlertEvaluator({
      ...DISABLED,
      cpuPercent: 90,
      sustainSamples: 2,
    });

    for (let i = 0; i < 5; i += 1) {
      expect(alertsFor(evaluator, status({ cpuUsagePercent: 89.9 }))).toEqual([]);
    }
  });

  test('recovery clears with a single info alert once below the threshold', () => {
    const evaluator = createOperationalAlertEvaluator({
      ...DISABLED,
      cpuPercent: 80,
      sustainSamples: 2,
    });

    expect(alertsFor(evaluator, status({ cpuUsagePercent: 95 }))).toEqual([]);
    const fired = alertsFor(evaluator, status({ cpuUsagePercent: 95 }));
    expect(fired).toHaveLength(1);
    expect(fired[0].severity).toBe('warning');

    // Drop below threshold: one recovery (info) alert, then silence.
    const cleared = alertsFor(evaluator, status({ cpuUsagePercent: 40 }));
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({ severity: 'info', agentId: OPERATIONAL_ALERT_AGENT_ID });
    expect(cleared[0].summary).toContain('Recovered');
    expect(cleared[0].operationalAlert).toEqual({
      key: 'resource:cpu',
      metric: 'cpu',
      state: 'recovered',
    });
    expect(alertsFor(evaluator, status({ cpuUsagePercent: 40 }))).toEqual([]);

    // A later sustained crossing fires again (edge re-arms after recovery).
    expect(alertsFor(evaluator, status({ cpuUsagePercent: 95 }))).toEqual([]);
    expect(alertsFor(evaluator, status({ cpuUsagePercent: 95 }))).toHaveLength(1);
  });

  test('a sub-sustain breach streak that then drops emits no recovery alert', () => {
    const evaluator = createOperationalAlertEvaluator({
      ...DISABLED,
      cpuPercent: 80,
      sustainSamples: 3,
    });

    // Two breaches (below the sustain count), then recover — never fired, so
    // there must be no recovery alert.
    expect(alertsFor(evaluator, status({ cpuUsagePercent: 95 }))).toEqual([]);
    expect(alertsFor(evaluator, status({ cpuUsagePercent: 95 }))).toEqual([]);
    expect(alertsFor(evaluator, status({ cpuUsagePercent: 10 }))).toEqual([]);
  });

  test('null/unavailable metrics neither fire nor clear (sampler errors do not spam)', () => {
    const evaluator = createOperationalAlertEvaluator({
      ...DISABLED,
      cpuPercent: 80,
      sustainSamples: 2,
    });

    // A stream of sampler-error snapshots (all metrics null) produces nothing.
    for (let i = 0; i < 5; i += 1) {
      expect(
        alertsFor(evaluator, status({ cpuUsagePercent: null, unavailable: ['sampler_error'] })),
      ).toEqual([]);
    }

    // Drive into a firing state.
    expect(alertsFor(evaluator, status({ cpuUsagePercent: 95 }))).toEqual([]);
    expect(alertsFor(evaluator, status({ cpuUsagePercent: 95 }))).toHaveLength(1);

    // A transient sampler error while firing must not emit a spurious recovery
    // and must not re-fire.
    expect(
      alertsFor(evaluator, status({ cpuUsagePercent: null, unavailable: ['sampler_error'] })),
    ).toEqual([]);
    expect(
      alertsFor(evaluator, status({ cpuUsagePercent: null, unavailable: ['sampler_error'] })),
    ).toEqual([]);

    // Real below-threshold reading still clears once.
    expect(alertsFor(evaluator, status({ cpuUsagePercent: 30 }))).toHaveLength(1);
  });

  test('data-directory disk pressure fires once after sustained low free space', () => {
    const evaluator = createOperationalAlertEvaluator({
      ...DISABLED,
      dataDirectoryFreePercent: 5,
      dataDirectoryFreeBytes: 2_147_483_648,
      sustainSamples: 3,
    });

    const lowSpace = status({
      dataDirectoryDiskFreePercent: 4.9,
      dataDirectoryDiskFreeBytes: 3_000_000_000,
      dataDirectoryDiskTotalBytes: 100_000_000_000,
    });

    expect(alertsFor(evaluator, lowSpace)).toEqual([]);
    expect(alertsFor(evaluator, lowSpace)).toEqual([]);
    const fired = alertsFor(evaluator, lowSpace);

    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      type: 'alert',
      agentId: OPERATIONAL_ALERT_AGENT_ID,
      severity: 'warning',
    });
    expect(fired[0].summary).toContain('data-directory disk space');
    expect(fired[0].details).toContain('kookr maintenance prune --dry-run --dir <dataDir>');
    expect(fired[0].operationalAlert).toEqual({
      key: 'resource:data_directory_disk_free',
      metric: 'data_directory_disk_free',
      state: 'fired',
    });

    expect(alertsFor(evaluator, lowSpace)).toEqual([]);
  });

  test('data-directory disk pressure can breach on byte floor and clears after full recovery', () => {
    const evaluator = createOperationalAlertEvaluator({
      ...DISABLED,
      dataDirectoryFreePercent: 5,
      dataDirectoryFreeBytes: 2_147_483_648,
      sustainSamples: 1,
    });

    const fired = alertsFor(evaluator, status({
      dataDirectoryDiskFreePercent: 10,
      dataDirectoryDiskFreeBytes: 1_000_000_000,
      dataDirectoryDiskTotalBytes: 100_000_000_000,
    }));
    expect(fired).toHaveLength(1);
    expect(fired[0].severity).toBe('warning');

    const missingByteReading = alertsFor(evaluator, status({
      dataDirectoryDiskFreePercent: 10,
      dataDirectoryDiskFreeBytes: null,
      dataDirectoryDiskTotalBytes: 100_000_000_000,
    }));
    expect(missingByteReading).toEqual([]);

    const cleared = alertsFor(evaluator, status({
      dataDirectoryDiskFreePercent: 10,
      dataDirectoryDiskFreeBytes: 3_000_000_000,
      dataDirectoryDiskTotalBytes: 100_000_000_000,
    }));
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({ severity: 'info', agentId: OPERATIONAL_ALERT_AGENT_ID });
    expect(cleared[0].summary).toContain('Recovered');
    expect(cleared[0].operationalAlert).toEqual({
      key: 'resource:data_directory_disk_free',
      metric: 'data_directory_disk_free',
      state: 'recovered',
    });
  });

  test('data-directory disk pressure ignores missing data and disabled thresholds', () => {
    const missingEvaluator = createOperationalAlertEvaluator({
      ...DISABLED,
      dataDirectoryFreePercent: 5,
      sustainSamples: 1,
    });

    expect(alertsFor(missingEvaluator, status({
      dataDirectoryDiskFreePercent: null,
      dataDirectoryDiskFreeBytes: null,
      unavailable: ['data_directory_disk_unavailable'],
    }))).toEqual([]);

    const disabledEvaluator = createOperationalAlertEvaluator({
      ...DISABLED,
      dataDirectoryFreePercent: 0,
      dataDirectoryFreeBytes: 0,
      sustainSamples: 1,
    });

    expect(alertsFor(disabledEvaluator, status({
      dataDirectoryDiskFreePercent: 1,
      dataDirectoryDiskFreeBytes: 1,
      dataDirectoryDiskTotalBytes: 100_000_000_000,
    }))).toEqual([]);
  });

  test('process RSS fires once after a sustained breach and clears on recovery', () => {
    const threshold = 2 * 1024 * 1024 * 1024; // 2 GiB
    const evaluator = createOperationalAlertEvaluator({
      ...DISABLED,
      processRssBytes: threshold,
      sustainSamples: 3,
    });

    const highRss = status({ processRssBytes: 2.4 * 1024 * 1024 * 1024 });

    // Two breaching samples build toward the sustain count without firing.
    expect(alertsFor(evaluator, highRss)).toEqual([]);
    expect(alertsFor(evaluator, highRss)).toEqual([]);

    const fired = alertsFor(evaluator, highRss);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      type: 'alert',
      agentId: OPERATIONAL_ALERT_AGENT_ID,
      severity: 'warning',
    });
    expect(fired[0].summary).toContain('High Kookr process RSS');
    // Remediation hints reference only real surfaces.
    expect(fired[0].details).toContain('/api/diagnostics/hook-ingestion');
    expect(fired[0].details).toContain('kookr maintenance prune --dry-run');
    expect(fired[0].details).toContain('clearCompleted');
    expect(fired[0].operationalAlert).toEqual({
      key: 'resource:process_rss',
      metric: 'process_rss',
      state: 'fired',
    });

    // Already firing: further breaches do not re-alert.
    expect(alertsFor(evaluator, highRss)).toEqual([]);

    // Drop below threshold: one info recovery, then silence.
    const cleared = alertsFor(evaluator, status({ processRssBytes: 1 * 1024 * 1024 * 1024 }));
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({ severity: 'info', agentId: OPERATIONAL_ALERT_AGENT_ID });
    expect(cleared[0].summary).toContain('Recovered Kookr process RSS');
    expect(cleared[0].operationalAlert).toEqual({
      key: 'resource:process_rss',
      metric: 'process_rss',
      state: 'recovered',
    });
    expect(alertsFor(evaluator, status({ processRssBytes: 1 * 1024 * 1024 * 1024 }))).toEqual([]);
  });

  test('process RSS respects sustainSamples and never fires just under the sustain count', () => {
    const threshold = 1024 * 1024 * 1024; // 1 GiB
    const evaluator = createOperationalAlertEvaluator({
      ...DISABLED,
      processRssBytes: threshold,
      sustainSamples: 4,
    });

    const highRss = status({ processRssBytes: threshold + 1 });
    for (let i = 0; i < 3; i += 1) {
      expect(alertsFor(evaluator, highRss)).toEqual([]);
    }
    // Fourth consecutive breach finally fires.
    expect(alertsFor(evaluator, highRss)).toHaveLength(1);
  });

  test('process RSS breaches at exactly the threshold (>= inclusive)', () => {
    const threshold = 2 * 1024 * 1024 * 1024;
    const evaluator = createOperationalAlertEvaluator({
      ...DISABLED,
      processRssBytes: threshold,
      sustainSamples: 2,
    });

    const atThreshold = status({ processRssBytes: threshold });
    expect(alertsFor(evaluator, atThreshold)).toEqual([]);
    expect(alertsFor(evaluator, atThreshold)).toHaveLength(1);
  });

  test('changing the process RSS threshold resets an accumulated breach streak', () => {
    let config: OperationalAlertConfig = {
      ...DISABLED,
      processRssBytes: 1024 * 1024 * 1024,
      sustainSamples: 3,
    };
    const evaluator = createOperationalAlertEvaluator(() => config);

    const highRss = status({ processRssBytes: 2 * 1024 * 1024 * 1024 });
    expect(alertsFor(evaluator, highRss)).toEqual([]);
    expect(alertsFor(evaluator, highRss)).toEqual([]);

    // Operator raises the threshold: the in-flight streak is discarded, so the
    // next two breaches must not fire until a fresh streak reaches the count.
    config = { ...config, processRssBytes: 1.5 * 1024 * 1024 * 1024 };
    expect(alertsFor(evaluator, highRss)).toEqual([]);
    expect(alertsFor(evaluator, highRss)).toEqual([]);
    expect(alertsFor(evaluator, highRss)).toHaveLength(1);
  });

  test('process RSS rule disabled (threshold 0) never fires even on extreme RSS', () => {
    const evaluator = createOperationalAlertEvaluator({
      ...DISABLED,
      processRssBytes: 0,
      sustainSamples: 1,
    });
    expect(evaluator.hasEnabledRules()).toBe(false);
    for (let i = 0; i < 3; i += 1) {
      expect(alertsFor(evaluator, status({ processRssBytes: 64 * 1024 * 1024 * 1024 }))).toEqual([]);
    }
  });

  test('process RSS enables hasEnabledRules and ignores null readings (no spam)', () => {
    const evaluator = createOperationalAlertEvaluator({
      ...DISABLED,
      processRssBytes: 1024 * 1024 * 1024,
      sustainSamples: 2,
    });
    expect(evaluator.hasEnabledRules()).toBe(true);

    // Sampler-error snapshots (RSS null) neither fire nor advance the counter.
    for (let i = 0; i < 5; i += 1) {
      expect(alertsFor(evaluator, status({ processRssBytes: null }))).toEqual([]);
    }
    // Two real breaches still fire exactly once.
    expect(alertsFor(evaluator, status({ processRssBytes: 2 * 1024 * 1024 * 1024 }))).toEqual([]);
    expect(alertsFor(evaluator, status({ processRssBytes: 2 * 1024 * 1024 * 1024 }))).toHaveLength(1);
    // A transient null while firing must not emit a spurious recovery.
    expect(alertsFor(evaluator, status({ processRssBytes: null }))).toEqual([]);
  });

  test('a transient gap does not reset accumulated breaches', () => {
    const evaluator = createOperationalAlertEvaluator({
      ...DISABLED,
      memoryPercent: 90,
      sustainSamples: 3,
    });

    expect(alertsFor(evaluator, status({ memoryUsedPercent: 95 }))).toEqual([]);
    expect(alertsFor(evaluator, status({ memoryUsedPercent: 95 }))).toEqual([]);
    // Sampler hiccup (null) — accumulation is preserved, not advanced.
    expect(alertsFor(evaluator, status({ memoryUsedPercent: null }))).toEqual([]);
    // Third real breach now fires.
    expect(alertsFor(evaluator, status({ memoryUsedPercent: 95 }))).toHaveLength(1);
  });

  test('disabled rules (threshold 0) never fire even on extreme values', () => {
    const evaluator = createOperationalAlertEvaluator({ ...DISABLED, sustainSamples: 1 });
    for (let i = 0; i < 3; i += 1) {
      expect(
        alertsFor(
          evaluator,
          status({ cpuUsagePercent: 100, memoryUsedPercent: 100, eventLoopDelayP95Ms: 9_999 }),
        ),
      ).toEqual([]);
    }
  });

  test('rules are evaluated independently', () => {
    const evaluator = createOperationalAlertEvaluator({
      cpuPercent: 80,
      memoryPercent: 90,
      eventLoopDelayMs: 0,
      processRssBytes: 0,
      dataDirectoryFreePercent: 0,
      dataDirectoryFreeBytes: 0,
      circuitBreakerOpenMs: 0,
      sustainSamples: 1,
    });

    const fired = alertsFor(
      evaluator,
      status({ cpuUsagePercent: 85, memoryUsedPercent: 95, eventLoopDelayP95Ms: 9_999 }),
    );
    // CPU and memory fire; event-loop rule is disabled.
    expect(fired).toHaveLength(2);
    const summaries = fired.map((m) => m.summary).join(' | ');
    expect(summaries).toContain('CPU');
    expect(summaries).toContain('memory');
    expect(summaries).not.toContain('event-loop');
  });

  test('reads config changes on subsequent samples', () => {
    let config: OperationalAlertConfig = { ...DISABLED };
    const evaluator = createOperationalAlertEvaluator(() => config);

    expect(evaluator.hasEnabledRules()).toBe(false);
    expect(alertsFor(evaluator, status({ cpuUsagePercent: 95 }))).toEqual([]);

    config = { ...config, cpuPercent: 90, sustainSamples: 1 };

    expect(evaluator.hasEnabledRules()).toBe(true);
    expect(alertsFor(evaluator, status({ cpuUsagePercent: 95 }))).toHaveLength(1);

    config = { ...config, cpuPercent: 0 };
    expect(evaluator.hasEnabledRules()).toBe(false);
    expect(alertsFor(evaluator, status({ cpuUsagePercent: 95 }))).toEqual([]);
  });

  test('changing threshold resets accumulated breach streaks', () => {
    let config: OperationalAlertConfig = { ...DISABLED, cpuPercent: 80, sustainSamples: 3 };
    const evaluator = createOperationalAlertEvaluator(() => config);

    expect(alertsFor(evaluator, status({ cpuUsagePercent: 85 }))).toEqual([]);
    expect(alertsFor(evaluator, status({ cpuUsagePercent: 85 }))).toEqual([]);

    config = { ...config, cpuPercent: 90 };

    expect(alertsFor(evaluator, status({ cpuUsagePercent: 95 }))).toEqual([]);
    expect(alertsFor(evaluator, status({ cpuUsagePercent: 95 }))).toEqual([]);
    expect(alertsFor(evaluator, status({ cpuUsagePercent: 95 }))).toHaveLength(1);
  });

  test('circuit breaker OPEN duration fires after the configured threshold', () => {
    const openedAt = Date.parse('2026-05-13T00:00:00.000Z');
    const evaluator = createOperationalAlertEvaluator({
      ...DISABLED,
      circuitBreakerOpenMs: 60_000,
    });

    const fired = alertsFor(evaluator, status({
      sampledAt: '2026-05-13T00:01:00.000Z',
      circuitBreakers: [breakerSnapshot({ state: 'open', lastStateChange: openedAt })],
    }));

    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      agentId: OPERATIONAL_ALERT_AGENT_ID,
      severity: 'warning',
    });
    expect(fired[0].summary).toContain('Circuit breaker open: llm');
    expect(fired[0].operationalAlert).toEqual({
      key: 'circuit_breaker:llm',
      metric: 'circuit_breaker_open',
      state: 'fired',
    });
  });

  test('circuit breaker OPEN duration does not fire before the configured threshold', () => {
    const openedAt = Date.parse('2026-05-13T00:00:00.000Z');
    const evaluator = createOperationalAlertEvaluator({
      ...DISABLED,
      circuitBreakerOpenMs: 60_000,
    });

    expect(alertsFor(evaluator, status({
      sampledAt: '2026-05-13T00:00:59.999Z',
      circuitBreakers: [breakerSnapshot({ state: 'open', lastStateChange: openedAt })],
    }))).toEqual([]);
  });

  test('circuit breaker OPEN alert clears on recovery', () => {
    const openedAt = Date.parse('2026-05-13T00:00:00.000Z');
    const evaluator = createOperationalAlertEvaluator({
      ...DISABLED,
      circuitBreakerOpenMs: 60_000,
    });

    expect(alertsFor(evaluator, status({
      sampledAt: '2026-05-13T00:02:00.000Z',
      circuitBreakers: [breakerSnapshot({ state: 'open', lastStateChange: openedAt })],
    }))).toHaveLength(1);

    const cleared = alertsFor(evaluator, status({
      sampledAt: '2026-05-13T00:02:01.000Z',
      circuitBreakers: [breakerSnapshot({
        state: 'half-open',
        lastStateChange: Date.parse('2026-05-13T00:02:01.000Z'),
      })],
    }));

    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({ severity: 'info', agentId: OPERATIONAL_ALERT_AGENT_ID });
    expect(cleared[0].summary).toContain('Recovered circuit breaker: llm');
    expect(cleared[0].operationalAlert).toEqual({
      key: 'circuit_breaker:llm',
      metric: 'circuit_breaker_open',
      state: 'recovered',
    });

    const reopenedAt = Date.parse('2026-05-13T00:03:00.000Z');
    const refired = alertsFor(evaluator, status({
      sampledAt: '2026-05-13T00:04:00.000Z',
      circuitBreakers: [breakerSnapshot({ state: 'open', lastStateChange: reopenedAt })],
    }));
    expect(refired).toHaveLength(1);
    expect(refired[0]).toMatchObject({ severity: 'warning', agentId: OPERATIONAL_ALERT_AGENT_ID });
  });

  test('circuit breaker OPEN alert is edge-triggered once per OPEN episode', () => {
    const openedAt = Date.parse('2026-05-13T00:00:00.000Z');
    const evaluator = createOperationalAlertEvaluator({
      ...DISABLED,
      circuitBreakerOpenMs: 60_000,
    });

    expect(alertsFor(evaluator, status({
      sampledAt: '2026-05-13T00:02:00.000Z',
      circuitBreakers: [breakerSnapshot({ state: 'open', lastStateChange: openedAt })],
    }))).toHaveLength(1);
    expect(alertsFor(evaluator, status({
      sampledAt: '2026-05-13T00:03:00.000Z',
      circuitBreakers: [breakerSnapshot({ state: 'open', lastStateChange: openedAt })],
    }))).toEqual([]);
  });

  test('persistence failures fire after sustained failed attempts and clear on recovery', () => {
    const tracker = new PersistenceHealthTracker();
    const evaluator = createOperationalAlertEvaluator(DISABLED, () => tracker.snapshot());
    const failure = new Error('temporary write failure');

    tracker.recordFailure('task_state', failure);
    expect(alertsFor(evaluator, status())).toEqual([]);
    tracker.recordFailure('task_state', failure);
    expect(alertsFor(evaluator, status())).toEqual([]);
    tracker.recordFailure('task_state', failure);

    const fired = alertsFor(evaluator, status());
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      agentId: OPERATIONAL_ALERT_AGENT_ID,
      severity: 'warning',
    });
    expect(fired[0].summary).toContain('Persistence failure: task-state');
    expect(fired[0].operationalAlert).toEqual({
      key: 'persistence:task_state',
      metric: 'persistence:task_state',
      state: 'fired',
    });

    expect(alertsFor(evaluator, status())).toEqual([]);

    tracker.recordSuccess('task_state');
    const cleared = alertsFor(evaluator, status());
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({ severity: 'info' });
    expect(cleared[0].summary).toContain('Recovered task-state persistence');
    expect(cleared[0].operationalAlert).toEqual({
      key: 'persistence:task_state',
      metric: 'persistence:task_state',
      state: 'recovered',
    });
  });

  test('hard persistence failures fire on first failed attempt', () => {
    const tracker = new PersistenceHealthTracker();
    const evaluator = createOperationalAlertEvaluator(DISABLED, () => tracker.snapshot());
    tracker.recordFailure('detection_stats', Object.assign(new Error('no space left'), { code: 'ENOSPC' }));

    const fired = alertsFor(evaluator, status());

    expect(fired).toHaveLength(1);
    expect(fired[0].summary).toContain('detection-stats');
    expect(fired[0].details).toContain('ENOSPC');
  });

  test('hasEnabledRules reflects provider-health thresholds paired with a getter', () => {
    const tracker = new ProviderHealthTracker();
    // A paused-duration threshold with a getter enables the rule.
    expect(
      createOperationalAlertEvaluator(
        { ...DISABLED, providerPausedMs: 60_000 },
        undefined,
        () => tracker.snapshot(),
      ).hasEnabledRules(),
    ).toBe(true);
    // A getter alone (all provider thresholds 0) is not enough.
    expect(
      createOperationalAlertEvaluator(DISABLED, undefined, () => tracker.snapshot()).hasEnabledRules(),
    ).toBe(false);
    // A substitution count without a positive window does not enable the rule.
    expect(
      createOperationalAlertEvaluator(
        { ...DISABLED, providerFallbackSubstitutions: 3, providerFallbackWindowMs: 0 },
        undefined,
        () => tracker.snapshot(),
      ).hasEnabledRules(),
    ).toBe(false);
  });

  test('provider-health fires after N fallback substitutions within the window and clears when they age out', () => {
    const tracker = new ProviderHealthTracker();
    const evaluator = createOperationalAlertEvaluator(
      { ...DISABLED, providerFallbackSubstitutions: 3, providerFallbackWindowMs: 60_000, providerPausedMs: 0 },
      undefined,
      () => tracker.snapshot(),
    );

    // Baseline sample establishes the counter origin; nothing counted yet.
    expect(alertsFor(evaluator, status({ sampledAt: '2026-05-13T00:00:00.000Z' }))).toEqual([]);

    tracker.recordSubstitution();
    expect(alertsFor(evaluator, status({ sampledAt: '2026-05-13T00:00:10.000Z' }))).toEqual([]);
    tracker.recordSubstitution();
    expect(alertsFor(evaluator, status({ sampledAt: '2026-05-13T00:00:20.000Z' }))).toEqual([]);
    tracker.recordSubstitution();

    const fired = alertsFor(evaluator, status({ sampledAt: '2026-05-13T00:00:30.000Z' }));
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ agentId: OPERATIONAL_ALERT_AGENT_ID, severity: 'warning' });
    expect(fired[0].summary).toContain('Provider pool degraded');
    expect(fired[0].summary).toContain('3 fallback substitutions');
    expect(fired[0].operationalAlert).toEqual({
      key: 'provider:health',
      metric: 'provider_health',
      state: 'fired',
    });

    // Standing alert: further breaching ticks do not re-alert.
    expect(alertsFor(evaluator, status({ sampledAt: '2026-05-13T00:00:40.000Z' }))).toEqual([]);

    // Once all three substitutions age out of the 60s window, the alert clears.
    const cleared = alertsFor(evaluator, status({ sampledAt: '2026-05-13T00:01:31.000Z' }));
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({ severity: 'info' });
    expect(cleared[0].summary).toContain('Recovered provider pool');
    expect(cleared[0].operationalAlert).toEqual({
      key: 'provider:health',
      metric: 'provider_health',
      state: 'recovered',
    });
  });

  test('provider-health does not fire below the substitution threshold', () => {
    const tracker = new ProviderHealthTracker();
    const evaluator = createOperationalAlertEvaluator(
      { ...DISABLED, providerFallbackSubstitutions: 5, providerFallbackWindowMs: 60_000, providerPausedMs: 0 },
      undefined,
      () => tracker.snapshot(),
    );

    expect(alertsFor(evaluator, status({ sampledAt: '2026-05-13T00:00:00.000Z' }))).toEqual([]);
    tracker.recordSubstitution(2);
    expect(alertsFor(evaluator, status({ sampledAt: '2026-05-13T00:00:10.000Z' }))).toEqual([]);
    expect(alertsFor(evaluator, status({ sampledAt: '2026-05-13T00:00:20.000Z' }))).toEqual([]);
  });

  test('provider-health fires on paused-duration threshold and clears on resume', () => {
    const tracker = new ProviderHealthTracker();
    const evaluator = createOperationalAlertEvaluator(
      { ...DISABLED, providerFallbackSubstitutions: 0, providerFallbackWindowMs: 0, providerPausedMs: 60_000 },
      undefined,
      () => tracker.snapshot(),
    );

    tracker.setPaused(true, Date.parse('2026-05-13T00:00:00.000Z'));
    expect(alertsFor(evaluator, status({ sampledAt: '2026-05-13T00:00:59.999Z' }))).toEqual([]);

    const fired = alertsFor(evaluator, status({ sampledAt: '2026-05-13T00:01:00.000Z' }));
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ agentId: OPERATIONAL_ALERT_AGENT_ID, severity: 'warning' });
    expect(fired[0].summary).toContain('provider pool paused for');
    expect(fired[0].operationalAlert).toEqual({
      key: 'provider:health',
      metric: 'provider_health',
      state: 'fired',
    });

    tracker.setPaused(false, Date.parse('2026-05-13T00:01:10.000Z'));
    const cleared = alertsFor(evaluator, status({ sampledAt: '2026-05-13T00:01:11.000Z' }));
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({ severity: 'info' });
    expect(cleared[0].operationalAlert).toEqual({
      key: 'provider:health',
      metric: 'provider_health',
      state: 'recovered',
    });

    // A fresh pause episode after recovery must re-arm and fire again (proves the
    // edge-trigger `firing` flag reset on recovery, not left latched).
    tracker.setPaused(true, Date.parse('2026-05-13T00:02:00.000Z'));
    expect(alertsFor(evaluator, status({ sampledAt: '2026-05-13T00:02:30.000Z' }))).toEqual([]);
    const refired = alertsFor(evaluator, status({ sampledAt: '2026-05-13T00:03:00.000Z' }));
    expect(refired).toHaveLength(1);
    expect(refired[0]).toMatchObject({ severity: 'warning' });
    expect(refired[0].operationalAlert).toEqual({
      key: 'provider:health',
      metric: 'provider_health',
      state: 'fired',
    });
  });

  test('provider-health recovery text omits the disabled sub-rule (no "below 0 per 0ms")', () => {
    const tracker = new ProviderHealthTracker();
    const evaluator = createOperationalAlertEvaluator(
      { ...DISABLED, providerFallbackSubstitutions: 0, providerFallbackWindowMs: 0, providerPausedMs: 60_000 },
      undefined,
      () => tracker.snapshot(),
    );

    tracker.setPaused(true, Date.parse('2026-05-13T00:00:00.000Z'));
    expect(alertsFor(evaluator, status({ sampledAt: '2026-05-13T00:01:00.000Z' }))).toHaveLength(1);
    tracker.setPaused(false, Date.parse('2026-05-13T00:01:10.000Z'));

    const cleared = alertsFor(evaluator, status({ sampledAt: '2026-05-13T00:01:11.000Z' }));
    expect(cleared).toHaveLength(1);
    expect(cleared[0].details).toContain('pool pause below');
    expect(cleared[0].details).not.toContain('fallback substitutions');
    expect(cleared[0].details).not.toContain('per 0ms');
  });

  test('provider-health rebases on a counter reset without firing phantom substitutions', () => {
    const snapshot: ProviderHealthSnapshot = { substitutionCount: 10, pausedSince: null };
    const evaluator = createOperationalAlertEvaluator(
      { ...DISABLED, providerFallbackSubstitutions: 2, providerFallbackWindowMs: 600_000, providerPausedMs: 0 },
      undefined,
      () => snapshot,
    );

    // First observation of a high counter is a baseline, not 10 substitutions.
    expect(alertsFor(evaluator, status({ sampledAt: '2026-05-13T00:00:00.000Z' }))).toEqual([]);
    // Producer restarts and the counter drops: a rebase, not negative deltas.
    snapshot.substitutionCount = 1;
    expect(alertsFor(evaluator, status({ sampledAt: '2026-05-13T00:00:10.000Z' }))).toEqual([]);
    // From the new baseline, two real substitutions fire.
    snapshot.substitutionCount = 2;
    expect(alertsFor(evaluator, status({ sampledAt: '2026-05-13T00:00:20.000Z' }))).toEqual([]);
    snapshot.substitutionCount = 3;
    const fired = alertsFor(evaluator, status({ sampledAt: '2026-05-13T00:00:30.000Z' }));
    expect(fired).toHaveLength(1);
    expect(fired[0].operationalAlert).toEqual({
      key: 'provider:health',
      metric: 'provider_health',
      state: 'fired',
    });
  });

  test('provider-health rule is inert when both thresholds are 0', () => {
    const snapshot: ProviderHealthSnapshot = {
      substitutionCount: 1000,
      pausedSince: Date.parse('2020-01-01T00:00:00.000Z'),
    };
    const evaluator = createOperationalAlertEvaluator(
      { ...DISABLED, providerFallbackSubstitutions: 0, providerFallbackWindowMs: 0, providerPausedMs: 0 },
      undefined,
      () => snapshot,
    );

    expect(alertsFor(evaluator, status({ sampledAt: '2026-05-13T00:00:00.000Z' }))).toEqual([]);
    expect(alertsFor(evaluator, status({ sampledAt: '2026-05-13T00:05:00.000Z' }))).toEqual([]);
  });
});

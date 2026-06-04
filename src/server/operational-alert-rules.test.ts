import { describe, expect, test } from 'vitest';
import {
  createOperationalAlertEvaluator,
  OperationalAlertEvaluator,
  OPERATIONAL_ALERT_AGENT_ID,
} from './operational-alert-rules.js';
import type { OperationalAlertConfig } from './config.js';
import type { ServerMessage, SystemResourceStatus } from '../shared/contracts/messages.js';

const DISABLED: OperationalAlertConfig = {
  cpuPercent: 0,
  memoryPercent: 0,
  eventLoopDelayMs: 0,
  sustainSamples: 3,
};

interface SampleOverrides {
  cpuUsagePercent?: number | null;
  memoryUsedPercent?: number | null;
  eventLoopDelayP95Ms?: number | null;
  unavailable?: SystemResourceStatus['unavailable'];
}

function status(overrides: SampleOverrides = {}): SystemResourceStatus {
  return {
    source: { kind: 'server-host' },
    sampledAt: '2026-05-13T00:00:00.000Z',
    sampleGapMs: null,
    timerDriftMs: null,
    host: {
      cpuUsagePercent: overrides.cpuUsagePercent ?? null,
      memoryUsedPercent: overrides.memoryUsedPercent ?? null,
      memoryFreeBytes: null,
      memoryTotalBytes: null,
    },
    server: {
      eventLoopDelayP95Ms: overrides.eventLoopDelayP95Ms ?? null,
      processRssBytes: null,
      processHeapUsedBytes: null,
      processHeapTotalBytes: null,
    },
    unavailable: overrides.unavailable ?? [],
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

    // Further breaches while already firing do not re-alert.
    expect(alertsFor(evaluator, status({ eventLoopDelayP95Ms: 300 }))).toEqual([]);
    expect(alertsFor(evaluator, status({ eventLoopDelayP95Ms: 300 }))).toEqual([]);
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
});

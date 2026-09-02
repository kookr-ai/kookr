import { describe, expect, test, vi } from 'vitest';
import { ResourceStatusService } from './resource-status-service.js';
import type { ServerMessage, SystemResourceStatus } from '../shared/contracts/messages.js';
import type { CircuitBreakerSnapshot } from '../shared/contracts/circuit-breaker.js';

function status(sampledAt = '2026-05-13T00:00:00.000Z'): SystemResourceStatus {
  return {
    source: { kind: 'server-host' },
    sampledAt,
    sampleGapMs: null,
    timerDriftMs: null,
    host: {
      cpuUsagePercent: null,
      memoryUsedPercent: 50,
      memoryFreeBytes: 500,
      memoryTotalBytes: 1_000,
      dataDirectory: {
        path: '/tmp/kookr-data',
        diskFreeBytes: 900,
        diskTotalBytes: 1_000,
        diskFreePercent: 90,
      },
    },
    server: {
      eventLoopDelayP95Ms: null,
      processRssBytes: 100,
      processHeapUsedBytes: 50,
      processHeapTotalBytes: 80,
    },
    unavailable: ['cpu_warming_up', 'event_loop_unavailable'],
  };
}

describe('ResourceStatusService', () => {
  test('takes an immediate sample, caches it, and broadcasts updates', () => {
    vi.useFakeTimers();
    try {
      let now = 1_000;
      const broadcasts: unknown[] = [];
      const sampler = {
        start: vi.fn(),
        stop: vi.fn(),
        sample: vi.fn(() => status()),
      };
      const service = new ResourceStatusService({
        sampler,
        broadcastToAll: (msg) => broadcasts.push(msg),
        nowMs: () => now,
        nowIso: () => '2026-05-13T00:00:00.000Z',
        intervalMs: 2_000,
      });

      service.start();

      expect(sampler.start).toHaveBeenCalledTimes(1);
      expect(sampler.sample).toHaveBeenCalledWith(null);
      expect(service.getLatest()).toEqual(status());
      expect(broadcasts).toEqual([{ type: 'resourceStatus', status: status() }]);

      now = 3_000;
      vi.advanceTimersByTime(2_000);

      expect(sampler.sample).toHaveBeenLastCalledWith(3_000);
      expect(broadcasts).toHaveLength(2);

      service.stop();
      expect(sampler.stop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('fails open with an unavailable snapshot when sampling throws', () => {
    vi.useFakeTimers();
    try {
      const broadcasts: unknown[] = [];
      const logger = { warn: vi.fn() };
      const service = new ResourceStatusService({
        sampler: {
          start: vi.fn(),
          stop: vi.fn(),
          sample: vi.fn(() => {
            throw new Error('boom');
          }),
        },
        broadcastToAll: (msg) => broadcasts.push(msg),
        nowIso: () => '2026-05-13T00:00:00.000Z',
        logger,
      });

      service.start();

      expect(service.getLatest()?.unavailable).toEqual(['sampler_error']);
      expect(broadcasts).toHaveLength(1);
      expect(logger.warn).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2_000);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test('retains the last good sample values with a stale marker when a later tick throws (issue #2771)', () => {
    vi.useFakeTimers();
    try {
      let now = 1_000;
      let throwNext = false;
      const broadcasts: ServerMessage[] = [];
      const service = new ResourceStatusService({
        sampler: {
          start: vi.fn(),
          stop: vi.fn(),
          sample: vi.fn(() => {
            if (throwNext) throw new Error('stat failed');
            return status();
          }),
        },
        broadcastToAll: (msg) => broadcasts.push(msg),
        nowMs: () => now,
        nowIso: () => new Date(now).toISOString(),
        intervalMs: 2_000,
      });

      // First tick succeeds and is remembered as the last good sample.
      service.start();
      expect(service.getLatest()?.stale).toBeUndefined();

      // Second tick throws: values are preserved (not blanked), with an
      // explicit stale age and the sampler_error reason.
      throwNext = true;
      now = 6_000;
      vi.advanceTimersByTime(2_000);

      const stale = service.getLatest();
      expect(stale?.stale).toEqual({
        reason: 'sampler_error',
        lastGoodAt: status().sampledAt,
        ageMs: 5_000,
      });
      // Pressure evidence stays visible instead of collapsing to null.
      expect(stale?.host.memoryUsedPercent).toBe(50);
      expect(stale?.host.dataDirectory.diskFreePercent).toBe(90);
      expect(stale?.server.processRssBytes).toBe(100);
      // sampledAt stays frozen at the last good sample so consumers that key
      // off it hold (the dashboard "Sampled N ago" line simply keeps ageing);
      // the sampler_error reason lives on `stale`, so `unavailable` carries the
      // preserved sample's own gaps verbatim, unchanged.
      expect(stale?.sampledAt).toBe(status().sampledAt);
      expect(stale?.unavailable).toEqual(status().unavailable);
      expect(stale?.unavailable).not.toContain('sampler_error');

      // A later successful sample clears the stale marker and restores fresh data.
      throwNext = false;
      now = 8_000;
      vi.advanceTimersByTime(2_000);
      expect(service.getLatest()?.stale).toBeUndefined();
      expect(service.getLatest()?.unavailable).toEqual(status().unavailable);

      service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test('feeds null (not the held-over value) to onEventLoopDelaySample on a stale tick (issue #2771)', () => {
    vi.useFakeTimers();
    try {
      let now = 1_000;
      let throwNext = false;
      const goodSample: SystemResourceStatus = {
        ...status(),
        server: { ...status().server, eventLoopDelayP95Ms: 250 },
      };
      const delaySamples: (number | null)[] = [];
      const service = new ResourceStatusService({
        sampler: {
          start: vi.fn(),
          stop: vi.fn(),
          sample: vi.fn(() => {
            if (throwNext) throw new Error('stat failed');
            return goodSample;
          }),
        },
        broadcastToAll: vi.fn(),
        onEventLoopDelaySample: (delayMs) => delaySamples.push(delayMs),
        nowMs: () => now,
        nowIso: () => new Date(now).toISOString(),
        intervalMs: 2_000,
      });

      // Fresh tick forwards the real measurement.
      service.start();
      expect(delaySamples).toEqual([250]);

      // Stale tick must forward null so the WS load-shed gate holds its streaks
      // instead of shedding/recovering on a held-over 250 ms reading.
      throwNext = true;
      now = 3_000;
      vi.advanceTimersByTime(2_000);
      expect(delaySamples).toEqual([250, null]);
      // The broadcast snapshot still shows the held-over value for display.
      expect(service.getLatest()?.server.eventLoopDelayP95Ms).toBe(250);
      expect(service.getLatest()?.stale?.reason).toBe('sampler_error');

      service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test('falls back to an all-null unavailable snapshot when the first-ever sample throws (no last good)', () => {
    vi.useFakeTimers();
    try {
      const service = new ResourceStatusService({
        sampler: {
          start: vi.fn(),
          stop: vi.fn(),
          sample: vi.fn(() => {
            throw new Error('boom');
          }),
        },
        broadcastToAll: vi.fn(),
        nowIso: () => '2026-05-13T00:00:00.000Z',
        logger: { warn: vi.fn() },
      });

      service.start();

      // With nothing to preserve, keep the original all-null unavailable shape.
      expect(service.getLatest()?.stale).toBeUndefined();
      expect(service.getLatest()?.unavailable).toEqual(['sampler_error']);
      expect(service.getLatest()?.host.memoryUsedPercent).toBeNull();

      service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test('broadcasts evaluator alerts after the resourceStatus message on each tick', () => {
    vi.useFakeTimers();
    try {
      const broadcasts: ServerMessage[] = [];
      const alert: ServerMessage = {
        type: 'alert',
        agentId: 'system',
        summary: 'High host CPU usage',
        details: 'sustained',
        severity: 'warning',
      };
      // Fire an alert only on the second sample to prove ordering and per-tick eval.
      let calls = 0;
      const service = new ResourceStatusService({
        sampler: { start: vi.fn(), stop: vi.fn(), sample: vi.fn(() => status()) },
        broadcastToAll: (msg) => broadcasts.push(msg),
        alertEvaluator: {
          evaluate: () => (++calls === 2 ? [alert] : []),
        },
        nowMs: () => 1_000,
        intervalMs: 2_000,
      });

      service.start();
      expect(broadcasts).toEqual([{ type: 'resourceStatus', status: status() }]);

      vi.advanceTimersByTime(2_000);
      expect(broadcasts).toEqual([
        { type: 'resourceStatus', status: status() },
        { type: 'resourceStatus', status: status() },
        alert,
      ]);

      service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test('routes operational alerts with metadata to the durable sink hook, skipping generic alerts', () => {
    vi.useFakeTimers();
    try {
      const sunk: ServerMessage[] = [];
      const genericAlert: ServerMessage = {
        type: 'alert',
        agentId: 'system',
        summary: 'generic dashboard alert (no operational metadata)',
        severity: 'warning',
      };
      const firedAlert: ServerMessage = {
        type: 'alert',
        agentId: 'system',
        summary: 'Provider pool degraded',
        severity: 'warning',
        operationalAlert: { key: 'provider:health', metric: 'provider_health', state: 'fired' },
      };
      const recoveredAlert: ServerMessage = {
        type: 'alert',
        agentId: 'system',
        summary: 'Recovered provider pool',
        severity: 'info',
        operationalAlert: { key: 'provider:health', metric: 'provider_health', state: 'recovered' },
      };
      const emissions: ServerMessage[][] = [[genericAlert], [firedAlert], [recoveredAlert]];
      let calls = 0;
      const service = new ResourceStatusService({
        sampler: { start: vi.fn(), stop: vi.fn(), sample: vi.fn(() => status()) },
        broadcastToAll: vi.fn(),
        alertEvaluator: { evaluate: () => emissions[calls++] ?? [] },
        onOperationalAlert: (alert) => sunk.push(alert),
        nowMs: () => 1_000,
        intervalMs: 2_000,
      });

      service.start(); // emits the generic alert (no metadata) — must not reach the sink
      vi.advanceTimersByTime(2_000); // fired
      vi.advanceTimersByTime(2_000); // recovered

      expect(sunk).toEqual([firedAlert, recoveredAlert]);

      service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a throwing durable sink hook never kills the tick loop', () => {
    vi.useFakeTimers();
    try {
      const firedAlert: ServerMessage = {
        type: 'alert',
        agentId: 'system',
        summary: 'Provider pool degraded',
        severity: 'warning',
        operationalAlert: { key: 'provider:health', metric: 'provider_health', state: 'fired' },
      };
      const broadcasts: ServerMessage[] = [];
      const warn = vi.fn();
      let calls = 0;
      const service = new ResourceStatusService({
        sampler: { start: vi.fn(), stop: vi.fn(), sample: vi.fn(() => status()) },
        broadcastToAll: (msg) => broadcasts.push(msg),
        alertEvaluator: { evaluate: () => (++calls === 1 ? [firedAlert] : []) },
        onOperationalAlert: () => {
          throw new Error('sink is on fire');
        },
        logger: { warn },
        nowMs: () => 1_000,
        intervalMs: 2_000,
      });

      service.start();
      // The alert still broadcasts despite the throwing sink, and the next tick runs.
      expect(broadcasts).toContainEqual(firedAlert);
      // The throw was caught by the intended guard (not swallowed elsewhere).
      expect(warn).toHaveBeenCalledWith(
        '[resource-status] operational-alert sink threw; continuing',
        expect.any(Error),
      );
      vi.advanceTimersByTime(2_000);
      expect(broadcasts.filter((m) => m.type === 'resourceStatus')).toHaveLength(2);

      service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test('retains operational alert fire and recovery events in a bounded history', () => {
    vi.useFakeTimers();
    try {
      const alert: ServerMessage = {
        type: 'alert',
        agentId: 'system',
        summary: 'High host CPU usage',
        details: 'sustained',
        severity: 'warning',
        operationalAlert: { key: 'resource:cpu', metric: 'cpu', state: 'fired' },
      };
      const recovery: ServerMessage = {
        type: 'alert',
        agentId: 'system',
        summary: 'Recovered host CPU usage',
        details: 'cleared',
        severity: 'info',
        operationalAlert: { key: 'resource:cpu', metric: 'cpu', state: 'recovered' },
      };
      const nowIso = vi
        .fn()
        .mockReturnValueOnce('2026-05-13T00:00:00.000Z')
        .mockReturnValueOnce('2026-05-13T00:01:00.000Z')
        .mockReturnValue('2026-05-13T00:02:00.000Z');
      let calls = 0;
      const service = new ResourceStatusService({
        sampler: { start: vi.fn(), stop: vi.fn(), sample: vi.fn(() => status()) },
        broadcastToAll: vi.fn(),
        alertEvaluator: {
          evaluate: () => {
            calls += 1;
            if (calls === 1) return [alert];
            if (calls === 2) return [recovery];
            return [];
          },
        },
        nowIso,
        nowMs: () => 1_000,
        intervalMs: 2_000,
      });

      service.start();
      vi.advanceTimersByTime(2_000);

      expect(service.getOperationalAlertHistory()).toEqual({
        generatedAt: '2026-05-13T00:02:00.000Z',
        limit: 100,
        alerts: [{
          id: 1,
          key: 'resource:cpu',
          metric: 'cpu',
          firstFiredAt: '2026-05-13T00:00:00.000Z',
          lastFiredAt: '2026-05-13T00:00:00.000Z',
          recoveredAt: '2026-05-13T00:01:00.000Z',
          active: false,
          fireCount: 1,
          alert,
          recoveryAlert: recovery,
        }],
      });

      service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test('bounds operational alert history to the configured limit', () => {
    vi.useFakeTimers();
    try {
      const alerts: ServerMessage[] = [
        {
          type: 'alert',
          agentId: 'system',
          summary: 'one',
          details: 'one',
          severity: 'warning',
          operationalAlert: { key: 'one', metric: 'one', state: 'fired' },
        },
        {
          type: 'alert',
          agentId: 'system',
          summary: 'two',
          details: 'two',
          severity: 'warning',
          operationalAlert: { key: 'two', metric: 'two', state: 'fired' },
        },
        {
          type: 'alert',
          agentId: 'system',
          summary: 'three',
          details: 'three',
          severity: 'warning',
          operationalAlert: { key: 'three', metric: 'three', state: 'fired' },
        },
      ];
      let calls = 0;
      const service = new ResourceStatusService({
        sampler: { start: vi.fn(), stop: vi.fn(), sample: vi.fn(() => status()) },
        broadcastToAll: vi.fn(),
        alertEvaluator: { evaluate: () => (calls < alerts.length ? [alerts[calls++]] : []) },
        nowIso: () => `2026-05-13T00:00:0${calls}.000Z`,
        nowMs: () => 1_000,
        intervalMs: 2_000,
        operationalAlertHistoryLimit: 2,
      });

      service.start();
      vi.advanceTimersByTime(4_000);

      expect(service.getOperationalAlertHistory().alerts.map((entry) => entry.key)).toEqual(['two', 'three']);
      expect(service.getOperationalAlertHistory().limit).toBe(2);

      service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test('attaches circuit breaker snapshots to the sampled status before broadcast and alert evaluation', () => {
    vi.useFakeTimers();
    try {
      const broadcasts: ServerMessage[] = [];
      const evaluated: SystemResourceStatus[] = [];
      const breakers: CircuitBreakerSnapshot[] = [{
        name: 'llm',
        state: 'open',
        failureCount: 5,
        successCount: 0,
        rejectedCalls: 2,
        tripCount: 1,
        lastFailureTime: 1_000,
        lastStateChange: 1_000,
        resetTimeoutMs: 30_000,
      }];
      const service = new ResourceStatusService({
        sampler: { start: vi.fn(), stop: vi.fn(), sample: vi.fn(() => status()) },
        broadcastToAll: (msg) => broadcasts.push(msg),
        alertEvaluator: {
          evaluate: (sample) => {
            evaluated.push(sample);
            return [];
          },
        },
        getCircuitBreakerSnapshots: () => breakers,
        nowMs: () => 1_000,
        intervalMs: 2_000,
      });

      service.start();

      expect(service.getLatest()?.circuitBreakers).toEqual(breakers);
      expect(broadcasts).toEqual([{ type: 'resourceStatus', status: { ...status(), circuitBreakers: breakers } }]);
      expect(evaluated).toEqual([{ ...status(), circuitBreakers: breakers }]);

      service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test('fails open and logs once when the alert evaluator throws', () => {
    vi.useFakeTimers();
    try {
      const broadcasts: ServerMessage[] = [];
      const logger = { warn: vi.fn() };
      const service = new ResourceStatusService({
        sampler: { start: vi.fn(), stop: vi.fn(), sample: vi.fn(() => status()) },
        broadcastToAll: (msg) => broadcasts.push(msg),
        alertEvaluator: {
          evaluate: () => {
            throw new Error('evaluator boom');
          },
        },
        nowMs: () => 1_000,
        intervalMs: 2_000,
        logger,
      });

      service.start();
      // resourceStatus still broadcast despite evaluator failure.
      expect(broadcasts).toEqual([{ type: 'resourceStatus', status: status() }]);
      expect(logger.warn).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2_000);
      // Second failure does not re-log.
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(broadcasts).toHaveLength(2);

      service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  describe('onEventLoopDelaySample (#1725)', () => {
    function statusWithDelay(delayMs: number | null): SystemResourceStatus {
      const s = status();
      return { ...s, server: { ...s.server, eventLoopDelayP95Ms: delayMs } };
    }

    test('is called every tick with the sampled eventLoopDelayP95Ms — the SAME value that goes out on `status`', () => {
      vi.useFakeTimers();
      try {
        const samples: (number | null)[] = [];
        let delay: number | null = 42;
        const service = new ResourceStatusService({
          sampler: { start: vi.fn(), stop: vi.fn(), sample: vi.fn(() => statusWithDelay(delay)) },
          broadcastToAll: () => {},
          onEventLoopDelaySample: (d) => samples.push(d),
          nowMs: () => 1_000,
          intervalMs: 2_000,
        });

        service.start();
        expect(samples).toEqual([42]);

        delay = null; // sampler unavailable this tick
        vi.advanceTimersByTime(2_000);
        expect(samples).toEqual([42, null]);

        service.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    test('a throwing consumer is isolated — the tick loop keeps running and resourceStatus still broadcasts', () => {
      vi.useFakeTimers();
      try {
        const broadcasts: ServerMessage[] = [];
        const logger = { warn: vi.fn() };
        const service = new ResourceStatusService({
          sampler: { start: vi.fn(), stop: vi.fn(), sample: vi.fn(() => statusWithDelay(10)) },
          broadcastToAll: (msg) => broadcasts.push(msg),
          onEventLoopDelaySample: () => {
            throw new Error('gate boom');
          },
          nowMs: () => 1_000,
          intervalMs: 2_000,
          logger,
        });

        service.start();
        expect(broadcasts).toEqual([{ type: 'resourceStatus', status: statusWithDelay(10) }]);
        expect(logger.warn).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(2_000);
        expect(broadcasts).toHaveLength(2);

        service.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    test('omitted entirely — no behavior change from pre-#1725', () => {
      vi.useFakeTimers();
      try {
        const broadcasts: ServerMessage[] = [];
        const service = new ResourceStatusService({
          sampler: { start: vi.fn(), stop: vi.fn(), sample: vi.fn(() => statusWithDelay(10)) },
          broadcastToAll: (msg) => broadcasts.push(msg),
          nowMs: () => 1_000,
          intervalMs: 2_000,
        });

        expect(() => service.start()).not.toThrow();
        expect(broadcasts).toHaveLength(1);
        service.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('tick reschedules even when the body throws (#1725, R4)', () => {
    test('a throwing broadcastToAll on the resourceStatus send does not kill the tick loop — the next tick still fires and still samples onEventLoopDelaySample', () => {
      vi.useFakeTimers();
      try {
        const logger = { warn: vi.fn() };
        const samples: (number | null)[] = [];
        let shouldThrow = true;
        const service = new ResourceStatusService({
          sampler: { start: vi.fn(), stop: vi.fn(), sample: vi.fn(() => statusWithDelay(500)) },
          broadcastToAll: () => {
            if (shouldThrow) throw new Error('enrichment boom');
          },
          onEventLoopDelaySample: (d) => samples.push(d),
          nowMs: () => 1_000,
          intervalMs: 2_000,
          logger,
        });

        service.start(); // tick 1: broadcastToAll throws before onEventLoopDelaySample runs
        expect(samples).toEqual([]); // never reached this tick — broadcastToAll threw first
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('tick body threw'),
          expect.any(Error),
        );

        shouldThrow = false;
        vi.advanceTimersByTime(2_000); // tick 2 must still have been scheduled despite tick 1's throw
        expect(samples).toEqual([500]);

        service.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    function statusWithDelay(delayMs: number | null): SystemResourceStatus {
      const s = status();
      return { ...s, server: { ...s.server, eventLoopDelayP95Ms: delayMs } };
    }
  });
});

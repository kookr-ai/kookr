import { describe, expect, test, vi } from 'vitest';
import { ResourceStatusService } from './resource-status-service.js';
import type { ServerMessage, SystemResourceStatus } from '../shared/contracts/messages.js';

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
});

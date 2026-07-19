import { describe, expect, test, vi } from 'vitest';
import { AttentionQueue } from '../core/attention-queue.js';
import type { DetectionStats } from '../core/detection-stats.js';
import { PersistenceHealthTracker } from '../core/persistence-health.js';
import { TaskStore } from '../core/tasks.js';
import type { HelperLlmDiagnosticsSnapshot } from '../core/llm-types.js';
import type { SystemResourceStatus } from '../shared/contracts/messages.js';
import { DiagnosticRunner } from './diagnostic-runner.js';
import { runPersistenceSaveTick } from './lifecycle-timers.js';
import { createOperationalAlertEvaluator } from './operational-alert-rules.js';

function resourceStatus(): SystemResourceStatus {
  return {
    source: { kind: 'server-host' },
    sampledAt: '2026-06-12T10:00:00.000Z',
    sampleGapMs: null,
    timerDriftMs: null,
    host: {
      cpuUsagePercent: 10,
      memoryUsedPercent: 10,
      memoryFreeBytes: null,
      memoryTotalBytes: null,
      dataDirectory: {
        path: '/tmp/kookr-data',
        diskFreeBytes: null,
        diskTotalBytes: null,
        diskFreePercent: null,
      },
    },
    server: {
      eventLoopDelayP95Ms: 1,
      processRssBytes: null,
      processHeapUsedBytes: null,
      processHeapTotalBytes: null,
    },
    unavailable: [],
  };
}

function detectionStats(): DetectionStats {
  return { checks: {}, fires: {}, falsePositives: {} } as DetectionStats;
}

function helperLlm(): HelperLlmDiagnosticsSnapshot {
  return {
    schemaVersion: 'helper-llm-diagnostics.v1',
    generatedAt: 0,
    totals: {
      requestCount: 0,
      successCount: 0,
      failureCount: 0,
      nullResponseCount: 0,
      errorCount: 0,
      abortedCount: 0,
      totalLatencyMs: 0,
      averageLatencyMs: 0,
      maxLatencyMs: 0,
      failureCategories: {},
    },
    byUseCase: [],
    byProvider: [],
    byUseCaseProvider: [],
  };
}

describe('persistence health runtime wiring', () => {
  test('one in-memory tracker feeds save failures into alerts and diagnostics', async () => {
    const persistenceHealth = new PersistenceHealthTracker(() => new Date('2026-06-12T10:00:00.000Z'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const saveError = Object.assign(new Error('no space left'), { code: 'ENOSPC' });

    try {
      await runPersistenceSaveTick({
        taskStore: new TaskStore(),
        queue: new AttentionQueue(),
        tasksFile: '/tmp/tasks.json',
        persistenceHealth,
        taskStateSaver: vi.fn(async () => {
          throw saveError;
        }),
      });
    } finally {
      consoleError.mockRestore();
    }

    const evaluator = createOperationalAlertEvaluator(
      {
        cpuPercent: 0,
        memoryPercent: 0,
        eventLoopDelayMs: 0,
        processRssBytes: 0,
        dataDirectoryFreePercent: 0,
        dataDirectoryFreeBytes: 0,
        circuitBreakerOpenMs: 0,
        sustainSamples: 3,
      },
      () => persistenceHealth.snapshot(),
    );
    const alerts = evaluator.evaluate(resourceStatus());
    expect(alerts).toEqual([
      expect.objectContaining({
        type: 'alert',
        severity: 'warning',
        agentId: 'system',
        summary: expect.stringContaining('Persistence failure: task-state'),
      }),
    ]);

    const diagnosticRunner = new DiagnosticRunner({
      getDetectionStats: detectionStats,
      getAgentCount: () => 0,
      getUptimeMs: () => 60 * 60 * 1000,
      getWsBroadcastCount: () => 0,
      getEventCounts: () => ({}),
      measureSnapshotSizeBytes: () => 10_000,
      getHelperLlmDiagnosticsSnapshot: helperLlm,
      getPersistenceHealthSnapshot: () => persistenceHealth.snapshot(),
    });
    const report = diagnosticRunner.runNow();

    expect(report.persistenceHealth?.targets.task_state).toMatchObject({
      totalFailures: 1,
      consecutiveFailures: 1,
      lastError: { code: 'ENOSPC', hard: true },
    });
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: 'persistence-health',
          scope: 'task_state',
        }),
      ]),
    );
  });
});

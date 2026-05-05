import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore, type RalphLoopState } from './tasks.js';
import { generateRalphAnomalyDiagnosticsReport } from './ralph-anomaly-diagnostics.js';
import { iterationLogPath, type RalphIterationRecord } from './ralph-iteration-log.js';

const baseLoop = (overrides: Partial<RalphLoopState> = {}): RalphLoopState => ({
  prompt: 'Continue.',
  iterationCap: 50,
  currentIteration: 0,
  status: 'running',
  lastIterationStartedAt: 0,
  cumulativeIterations: 0,
  ...overrides,
});

const record = (overrides: Partial<RalphIterationRecord> = {}): RalphIterationRecord => ({
  iterationNumber: 0,
  startedAt: 1_000,
  endedAt: 2_000,
  exitReason: 'continued',
  cumulativeCostUsd: 0,
  gitBaselineRef: null,
  diffStats: null,
  ...overrides,
});

describe('generateRalphAnomalyDiagnosticsReport', () => {
  let store: TaskStore;
  let dir: string;

  beforeEach(async () => {
    store = new TaskStore();
    dir = await mkdtemp(join(tmpdir(), 'ralph-anomaly-diag-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports no-data readiness when Ralph loops have no iteration logs', async () => {
    const task = store.createTask('loop with no data', dir);
    task.ralphLoop = baseLoop();

    const report = await generateRalphAnomalyDiagnosticsReport(store.getAllTasks(), new Date('2026-05-02T10:00:00Z'));

    expect(report.generatedAt).toBe('2026-05-02T10:00:00.000Z');
    expect(report.mode).toBe('diagnostics_only');
    expect(report.activeQueueInsertionEnabled).toBe(false);
    expect(report.tasksWithRalphLoops).toBe(1);
    expect(report.tasksWithIterationLogs).toBe(0);
    expect(report.totalIterations).toBe(0);
    expect(report.signals.runtimeOutlier.status).toBe('no_data');
    expect(report.signals.costVelocity.status).toBe('no_data');
  });

  it('keeps unknown cost distinct from zero cost and blocks cost velocity readiness', async () => {
    const task = store.createTask('cost telemetry', dir);
    task.ralphLoop = baseLoop();
    await writeRecords(dir, [
      record({ iterationNumber: 0, cumulativeCostUsd: null, startedAt: 1_000, endedAt: 2_000 }),
      record({ iterationNumber: 1, cumulativeCostUsd: 0, startedAt: 2_000, endedAt: 3_500 }),
      record({ iterationNumber: 2, cumulativeCostUsd: 0.25, startedAt: 3_500, endedAt: 6_000 }),
    ]);

    const report = await generateRalphAnomalyDiagnosticsReport(store.getAllTasks());

    expect(report.cost.unknownCostIterations).toBe(1);
    expect(report.cost.zeroCostIterations).toBe(1);
    expect(report.cost.nonZeroCostIterations).toBe(1);
    expect(report.cost.costCoverage).toBeCloseTo(2 / 3);
    expect(report.signals.costVelocity.status).toBe('insufficient_cost_coverage');
    expect(report.signals.costVelocity.candidateThreshold).toBeNull();
  });

  it('computes cost deltas chronologically when re-armed loop epochs reuse iteration numbers', async () => {
    const task = store.createTask('re-armed cost telemetry', dir);
    task.ralphLoop = baseLoop();
    await writeRecords(dir, [
      record({ iterationNumber: 0, cumulativeCostUsd: 0, startedAt: 1_000, endedAt: 2_000 }),
      record({ iterationNumber: 1, cumulativeCostUsd: 1, startedAt: 2_000, endedAt: 3_000 }),
      record({ iterationNumber: 0, cumulativeCostUsd: 0.1, startedAt: 10_000, endedAt: 11_000 }),
      record({ iterationNumber: 1, cumulativeCostUsd: 1.1, startedAt: 11_000, endedAt: 12_000 }),
    ]);

    const report = await generateRalphAnomalyDiagnosticsReport(store.getAllTasks());

    expect(report.cost.perIterationDeltaUsd.count).toBe(2);
    expect(report.cost.perIterationDeltaUsd.min).toBeCloseTo(1);
    expect(report.cost.perIterationDeltaUsd.p95).toBeCloseTo(1);
    expect(report.cost.nonZeroPerIterationDeltaUsd.count).toBe(2);
    expect(report.cost.nonZeroPerIterationDeltaUsd.p95).toBeCloseTo(1);
    expect(report.cost.nonZeroCostDeltaIterations).toBe(2);
    expect(report.signals.costVelocity.status).toBe('insufficient_nonzero_cost_deltas');
  });

  it('does not treat small runtime samples as active anomaly thresholds', async () => {
    const task = store.createTask('runtime telemetry', dir);
    task.ralphLoop = baseLoop();
    await writeRecords(dir, [
      record({ iterationNumber: 0, startedAt: 1_000, endedAt: 1_000 }),
      record({ iterationNumber: 1, startedAt: 1_000, endedAt: 11_000 }),
      record({ iterationNumber: 2, startedAt: 11_000, endedAt: 31_000 }),
    ]);

    const report = await generateRalphAnomalyDiagnosticsReport(store.getAllTasks());

    expect(report.runtime.zeroDurationIterations).toBe(1);
    expect(report.runtime.durations.count).toBe(2);
    expect(report.runtime.durations.p95).toBe(20_000);
    expect(report.signals.runtimeOutlier.status).toBe('insufficient_data');
    expect(report.signals.runtimeOutlier.candidateThreshold).toBeNull();
  });

  it('marks runtime and cost signals ready only after enough observed samples', async () => {
    const task = store.createTask('ready telemetry', dir);
    task.ralphLoop = baseLoop({ costCapUsd: 10 });
    const records = Array.from({ length: 21 }, (_, index) => record({
      iterationNumber: index,
      startedAt: index * 10_000,
      endedAt: index * 10_000 + (index + 1) * 1_000,
      cumulativeCostUsd: index * 0.05,
    }));
    await writeRecords(dir, records);

    const report = await generateRalphAnomalyDiagnosticsReport(store.getAllTasks());

    expect(report.signals.runtimeOutlier.status).toBe('ready_for_shadow');
    expect(report.signals.runtimeOutlier.candidateThreshold).toBe(20_000);
    expect(report.signals.costVelocity.status).toBe('ready_for_shadow');
    expect(report.signals.costVelocity.candidateThreshold).toBeCloseTo(0.05);
    expect(report.tasks[0]).toMatchObject({
      taskId: task.id,
      configuredCostCapUsd: 10,
      configuredIterationCap: 50,
      totalIterations: 21,
    });
  });

  it('computes cost velocity candidates from non-zero deltas without hiding zero deltas', async () => {
    const task = store.createTask('sparse spend telemetry', dir);
    task.ralphLoop = baseLoop({ costCapUsd: 10 });
    let cumulativeCostUsd = 0;
    const records = Array.from({ length: 41 }, (_, index) => {
      if (index > 0 && index % 2 === 0) cumulativeCostUsd += index / 100;
      return record({
        iterationNumber: index,
        startedAt: index * 10_000,
        endedAt: index * 10_000 + 1_000,
        cumulativeCostUsd,
      });
    });
    await writeRecords(dir, records);

    const report = await generateRalphAnomalyDiagnosticsReport(store.getAllTasks());

    expect(report.cost.perIterationDeltaUsd.count).toBe(40);
    expect(report.cost.perIterationDeltaUsd.min).toBe(0);
    expect(report.cost.perIterationDeltaUsd.p50).toBe(0);
    expect(report.cost.nonZeroCostDeltaIterations).toBe(20);
    expect(report.cost.nonZeroPerIterationDeltaUsd.count).toBe(20);
    expect(report.cost.nonZeroPerIterationDeltaUsd.p95).toBeCloseTo(0.38);
    expect(report.signals.costVelocity.status).toBe('ready_for_shadow');
    expect(report.signals.costVelocity.sampleCount).toBe(40);
    expect(report.signals.costVelocity.observedP95).toBeCloseTo(0.38);
    expect(report.signals.costVelocity.candidateThreshold).toBeCloseTo(0.38);
  });
});

async function writeRecords(dir: string, records: RalphIterationRecord[]): Promise<void> {
  await writeFile(iterationLogPath(dir), `${records.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf-8');
}

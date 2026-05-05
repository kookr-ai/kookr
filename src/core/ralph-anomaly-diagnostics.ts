import type { Task } from './tasks.js';
import {
  MAX_RALPH_ITERATION_READ_LIMIT,
  readIterationLog,
  type RalphIterationRecord,
} from './ralph-iteration-log.js';

const MIN_RUNTIME_SAMPLE_COUNT = 20;
const MIN_COST_DELTA_SAMPLE_COUNT = 20;
const MIN_COST_COVERAGE = 0.8;

export type RalphSignalReadiness =
  | 'no_data'
  | 'insufficient_data'
  | 'insufficient_cost_coverage'
  | 'insufficient_nonzero_cost_deltas'
  | 'ready_for_shadow';

export interface NumericDistribution {
  count: number;
  min: number | null;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  max: number | null;
}

export interface RalphRuntimeDiagnostics {
  durations: NumericDistribution;
  zeroDurationIterations: number;
  invalidDurationIterations: number;
}

export interface RalphCostDiagnostics {
  cumulativeCostUsd: NumericDistribution;
  perIterationDeltaUsd: NumericDistribution;
  nonZeroPerIterationDeltaUsd: NumericDistribution;
  knownCostIterations: number;
  unknownCostIterations: number;
  zeroCostIterations: number;
  nonZeroCostIterations: number;
  nonZeroCostDeltaIterations: number;
  costCoverage: number | null;
}

export interface RalphSignalCandidate {
  name: 'ralph_runtime_outlier' | 'ralph_cost_velocity';
  status: RalphSignalReadiness;
  reason: string;
  sampleCount: number;
  minimumSampleCount: number;
  candidateThreshold: number | null;
  observedP95: number | null;
}

export interface RalphAnomalyDiagnosticsTask {
  taskId: string;
  taskName: string;
  status: Task['status'];
  cwd: string;
  loopStatus: NonNullable<Task['ralphLoop']>['status'];
  configuredCostCapUsd: number | null;
  configuredIterationCap: number;
  totalIterations: number;
  returnedIterations: number;
  logCapped: boolean;
  latestExitReason: string | null;
}

export interface RalphAnomalyDiagnosticsReport {
  generatedAt: string;
  mode: 'diagnostics_only';
  activeQueueInsertionEnabled: false;
  minimumRuntimeSampleCount: number;
  minimumCostCoverage: number;
  minimumCostDeltaSampleCount: number;
  tasksWithRalphLoops: number;
  tasksWithIterationLogs: number;
  totalIterations: number;
  returnedIterations: number;
  runtime: RalphRuntimeDiagnostics;
  cost: RalphCostDiagnostics;
  signals: {
    runtimeOutlier: RalphSignalCandidate;
    costVelocity: RalphSignalCandidate;
  };
  tasks: RalphAnomalyDiagnosticsTask[];
}

interface IterationWithTask {
  taskId: string;
  record: RalphIterationRecord;
}

export async function generateRalphAnomalyDiagnosticsReport(
  tasks: Task[],
  now = new Date(),
): Promise<RalphAnomalyDiagnosticsReport> {
  const ralphTasks = tasks.filter((task) => task.ralphLoop);
  const iterations: IterationWithTask[] = [];
  const taskRows: RalphAnomalyDiagnosticsTask[] = [];
  let totalIterations = 0;
  let returnedIterations = 0;
  let tasksWithIterationLogs = 0;

  for (const task of ralphTasks) {
    const loop = task.ralphLoop!;
    const model = await readIterationLog(task.cwd, { limit: MAX_RALPH_ITERATION_READ_LIMIT, loop });
    totalIterations += model.summary.totalIterations;
    returnedIterations += model.iterations.length;
    if (model.summary.totalIterations > 0) tasksWithIterationLogs += 1;
    for (const record of model.iterations) {
      iterations.push({ taskId: task.id, record });
    }
    taskRows.push({
      taskId: task.id,
      taskName: task.name ?? task.prompt.slice(0, 80),
      status: task.status,
      cwd: task.cwd,
      loopStatus: loop.status,
      configuredCostCapUsd: loop.costCapUsd ?? null,
      configuredIterationCap: loop.iterationCap,
      totalIterations: model.summary.totalIterations,
      returnedIterations: model.iterations.length,
      logCapped: model.summary.capped,
      latestExitReason: model.summary.latestExitReason,
    });
  }

  const runtime = summarizeRuntime(iterations);
  const cost = summarizeCost(iterations);

  return {
    generatedAt: now.toISOString(),
    mode: 'diagnostics_only',
    activeQueueInsertionEnabled: false,
    minimumRuntimeSampleCount: MIN_RUNTIME_SAMPLE_COUNT,
    minimumCostCoverage: MIN_COST_COVERAGE,
    minimumCostDeltaSampleCount: MIN_COST_DELTA_SAMPLE_COUNT,
    tasksWithRalphLoops: ralphTasks.length,
    tasksWithIterationLogs,
    totalIterations,
    returnedIterations,
    runtime,
    cost,
    signals: {
      runtimeOutlier: runtimeCandidate(runtime),
      costVelocity: costCandidate(cost, returnedIterations),
    },
    tasks: taskRows,
  };
}

function summarizeRuntime(iterations: IterationWithTask[]): RalphRuntimeDiagnostics {
  const durations: number[] = [];
  let zeroDurationIterations = 0;
  let invalidDurationIterations = 0;

  for (const { record } of iterations) {
    const duration = record.endedAt - record.startedAt;
    if (!Number.isFinite(duration) || duration < 0) {
      invalidDurationIterations += 1;
    } else if (duration === 0) {
      zeroDurationIterations += 1;
    } else {
      durations.push(duration);
    }
  }

  return {
    durations: distribution(durations),
    zeroDurationIterations,
    invalidDurationIterations,
  };
}

function summarizeCost(iterations: IterationWithTask[]): RalphCostDiagnostics {
  const cumulativeCosts: number[] = [];
  const deltas: number[] = [];
  const nonZeroDeltas: number[] = [];
  let knownCostIterations = 0;
  let unknownCostIterations = 0;
  let zeroCostIterations = 0;
  let nonZeroCostIterations = 0;
  let nonZeroCostDeltaIterations = 0;
  const byTask = new Map<string, RalphIterationRecord[]>();

  for (const item of iterations) {
    const list = byTask.get(item.taskId) ?? [];
    list.push(item.record);
    byTask.set(item.taskId, list);

    const cost = item.record.cumulativeCostUsd;
    if (cost === null) {
      unknownCostIterations += 1;
      continue;
    }
    knownCostIterations += 1;
    cumulativeCosts.push(cost);
    if (cost === 0) zeroCostIterations += 1;
    else nonZeroCostIterations += 1;
  }

  for (const records of byTask.values()) {
    records.sort((a, b) =>
      a.startedAt - b.startedAt || a.endedAt - b.endedAt || a.iterationNumber - b.iterationNumber,
    );
    for (let i = 1; i < records.length; i += 1) {
      const previous = records[i - 1].cumulativeCostUsd;
      const current = records[i].cumulativeCostUsd;
      if (previous === null || current === null) continue;
      const delta = current - previous;
      if (!Number.isFinite(delta) || delta < 0) continue;
      deltas.push(delta);
      if (delta > 0) {
        nonZeroDeltas.push(delta);
        nonZeroCostDeltaIterations += 1;
      }
    }
  }

  const totalCostIterations = knownCostIterations + unknownCostIterations;
  return {
    cumulativeCostUsd: distribution(cumulativeCosts),
    perIterationDeltaUsd: distribution(deltas),
    nonZeroPerIterationDeltaUsd: distribution(nonZeroDeltas),
    knownCostIterations,
    unknownCostIterations,
    zeroCostIterations,
    nonZeroCostIterations,
    nonZeroCostDeltaIterations,
    costCoverage: totalCostIterations === 0 ? null : knownCostIterations / totalCostIterations,
  };
}

function runtimeCandidate(runtime: RalphRuntimeDiagnostics): RalphSignalCandidate {
  const sampleCount = runtime.durations.count;
  const observedP95 = runtime.durations.p95;
  if (sampleCount === 0) {
    return candidate('ralph_runtime_outlier', 'no_data', 'No positive-duration Ralph iterations were observed.', sampleCount, MIN_RUNTIME_SAMPLE_COUNT, null, observedP95);
  }
  if (sampleCount < MIN_RUNTIME_SAMPLE_COUNT) {
    return candidate('ralph_runtime_outlier', 'insufficient_data', `Only ${sampleCount} positive-duration iteration(s) were observed. Keep collecting before shadow validation.`, sampleCount, MIN_RUNTIME_SAMPLE_COUNT, null, observedP95);
  }
  return candidate('ralph_runtime_outlier', 'ready_for_shadow', 'Enough positive-duration iterations exist to validate a p95 runtime candidate in shadow mode.', sampleCount, MIN_RUNTIME_SAMPLE_COUNT, observedP95, observedP95);
}

function costCandidate(cost: RalphCostDiagnostics, totalIterations: number): RalphSignalCandidate {
  const coverage = cost.costCoverage;
  const sampleCount = cost.perIterationDeltaUsd.count;
  const observedP95 = cost.nonZeroPerIterationDeltaUsd.p95;
  if (totalIterations === 0) {
    return candidate('ralph_cost_velocity', 'no_data', 'No Ralph iterations were observed.', sampleCount, MIN_COST_DELTA_SAMPLE_COUNT, null, observedP95);
  }
  if (coverage === null || coverage < MIN_COST_COVERAGE) {
    const pct = coverage === null ? '0%' : `${Math.round(coverage * 100)}%`;
    return candidate('ralph_cost_velocity', 'insufficient_cost_coverage', `Cost was known for ${pct} of observed iterations; unknown cost remains distinct from zero.`, sampleCount, MIN_COST_DELTA_SAMPLE_COUNT, null, observedP95);
  }
  if (cost.nonZeroCostDeltaIterations < MIN_COST_DELTA_SAMPLE_COUNT) {
    return candidate('ralph_cost_velocity', 'insufficient_nonzero_cost_deltas', `Only ${cost.nonZeroCostDeltaIterations} non-zero cost delta iteration(s) were observed. Zero-cost samples are reported but not treated as reliable velocity evidence.`, sampleCount, MIN_COST_DELTA_SAMPLE_COUNT, null, observedP95);
  }
  return candidate('ralph_cost_velocity', 'ready_for_shadow', 'Enough known non-zero cost deltas exist to validate a p95 cost-velocity candidate in shadow mode.', sampleCount, MIN_COST_DELTA_SAMPLE_COUNT, observedP95, observedP95);
}

function candidate(
  name: RalphSignalCandidate['name'],
  status: RalphSignalReadiness,
  reason: string,
  sampleCount: number,
  minimumSampleCount: number,
  candidateThreshold: number | null,
  observedP95: number | null,
): RalphSignalCandidate {
  return { name, status, reason, sampleCount, minimumSampleCount, candidateThreshold, observedP95 };
}

function distribution(values: number[]): NumericDistribution {
  if (values.length === 0) {
    return { count: 0, min: null, p50: null, p90: null, p95: null, max: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0],
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
  };
}

function percentile(sortedValues: number[], p: number): number {
  const index = Math.ceil(sortedValues.length * p) - 1;
  return sortedValues[Math.max(0, Math.min(sortedValues.length - 1, index))];
}

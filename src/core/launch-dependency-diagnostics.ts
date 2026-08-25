import type { Task } from './tasks.js';
import type { LaunchDependencyCircuitSnapshot } from './launch-dependency-admission.js';

export interface LaunchDependencyDiagnosticsDependency {
  dependency: string;
  degradedTaskCount: number;
  findingCount: number;
  affectedTaskIds: string[];
  categories: string[];
  lastOccurredAt: string;
}

export interface LaunchDependencyDiagnosticsCategory {
  category: string;
  degradedTaskCount: number;
  findingCount: number;
  affectedTaskIds: string[];
  dependencies: string[];
  lastOccurredAt: string;
}

export interface LaunchDependencyDiagnosticsSnapshot {
  schemaVersion: 'launch-dependency-diagnostics.v1';
  totalDegradedTasks: number;
  totalFindings: number;
  dependencies: LaunchDependencyDiagnosticsDependency[];
  categories: LaunchDependencyDiagnosticsCategory[];
  /** Live circuit state, including unknown and half-open states. */
  dependencyStates?: LaunchDependencyCircuitSnapshot[];
  /** Pending work parked before a worker slot was consumed. */
  parkedTasks?: {
    total: number;
    taskIds: string[];
    byDependency: Array<{
      dependency: string;
      taskCount: number;
      taskIds: string[];
      reasons: string[];
    }>;
  };
}

interface MutableAggregate {
  key: string;
  affectedTaskIds: Set<string>;
  relatedKeys: Set<string>;
  findingCount: number;
  lastOccurredAt: string;
}

export function buildLaunchDependencyDiagnostics(
  tasks: readonly Pick<Task, 'id' | 'createdAt' | 'launchHealthSummary' | 'launchAdmission'>[],
  dependencyStates?: readonly LaunchDependencyCircuitSnapshot[],
): LaunchDependencyDiagnosticsSnapshot {
  const degradedTaskIds = new Set<string>();
  const byDependency = new Map<string, MutableAggregate>();
  const byCategory = new Map<string, MutableAggregate>();
  const parkedTaskIds = new Set<string>();
  const parkedByDependency = new Map<string, { taskIds: Set<string>; reasons: Set<string> }>();
  let totalFindings = 0;

  for (const task of tasks) {
    const parkedAdmission = task.launchAdmission?.status === 'parked'
      ? task.launchAdmission
      : undefined;
    if (parkedAdmission) {
      parkedTaskIds.add(task.id);
      for (const parked of parkedAdmission.dependencies) {
        const aggregate = parkedByDependency.get(parked.dependency) ?? {
          taskIds: new Set<string>(),
          reasons: new Set<string>(),
        };
        aggregate.taskIds.add(task.id);
        if (parked.reason) aggregate.reasons.add(parked.reason);
        parkedByDependency.set(parked.dependency, aggregate);
      }
    }
    // A parked task has not launched and must not inflate the historical
    // "launched with degraded dependencies" rollup. Its admission marker is
    // the separate parked-work diagnostic above.
    if (parkedAdmission) continue;
    const findings = task.launchHealthSummary?.findings ?? [];
    if (findings.length === 0) continue;

    degradedTaskIds.add(task.id);
    const occurredAt = task.createdAt.toISOString();
    for (const finding of findings) {
      totalFindings += 1;
      recordFinding(byDependency, finding.dependency, task.id, finding.category, occurredAt);
      recordFinding(byCategory, finding.category, task.id, finding.dependency, occurredAt);
    }
  }

  const parkedTasks = parkedTaskIds.size > 0
    ? {
        total: parkedTaskIds.size,
        taskIds: Array.from(parkedTaskIds).sort(),
        byDependency: Array.from(parkedByDependency.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([dependency, aggregate]) => ({
            dependency,
            taskCount: aggregate.taskIds.size,
            taskIds: Array.from(aggregate.taskIds).sort(),
            reasons: Array.from(aggregate.reasons).sort(),
          })),
      }
    : undefined;

  return {
    schemaVersion: 'launch-dependency-diagnostics.v1',
    totalDegradedTasks: degradedTaskIds.size,
    totalFindings,
    dependencies: toSortedRows(byDependency, 'categories'),
    categories: toSortedRows(byCategory, 'dependencies'),
    ...(dependencyStates && dependencyStates.length > 0
      ? { dependencyStates: dependencyStates.map((state) => ({ ...state })) }
      : {}),
    ...(parkedTasks ? { parkedTasks } : {}),
  };
}

function recordFinding(
  aggregates: Map<string, MutableAggregate>,
  key: string,
  taskId: string,
  relatedKey: string,
  occurredAt: string,
): void {
  const aggregate = aggregates.get(key) ?? {
    key,
    affectedTaskIds: new Set<string>(),
    relatedKeys: new Set<string>(),
    findingCount: 0,
    lastOccurredAt: occurredAt,
  };
  aggregate.affectedTaskIds.add(taskId);
  aggregate.relatedKeys.add(relatedKey);
  aggregate.findingCount += 1;
  if (occurredAt > aggregate.lastOccurredAt) {
    aggregate.lastOccurredAt = occurredAt;
  }
  aggregates.set(key, aggregate);
}

function toSortedRows(
  aggregates: Map<string, MutableAggregate>,
  relatedField: 'categories',
): LaunchDependencyDiagnosticsDependency[];
function toSortedRows(
  aggregates: Map<string, MutableAggregate>,
  relatedField: 'dependencies',
): LaunchDependencyDiagnosticsCategory[];
function toSortedRows(
  aggregates: Map<string, MutableAggregate>,
  relatedField: 'categories' | 'dependencies',
): Array<LaunchDependencyDiagnosticsDependency | LaunchDependencyDiagnosticsCategory> {
  return Array.from(aggregates.values())
    .sort((a, b) => b.findingCount - a.findingCount || a.key.localeCompare(b.key))
    .map((aggregate) => {
      const common = {
        degradedTaskCount: aggregate.affectedTaskIds.size,
        findingCount: aggregate.findingCount,
        affectedTaskIds: Array.from(aggregate.affectedTaskIds).sort(),
        lastOccurredAt: aggregate.lastOccurredAt,
      };
      const relatedKeys = Array.from(aggregate.relatedKeys).sort();
      return relatedField === 'categories'
        ? { dependency: aggregate.key, ...common, categories: relatedKeys }
        : { category: aggregate.key, ...common, dependencies: relatedKeys };
    });
}

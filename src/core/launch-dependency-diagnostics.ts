import type { Task } from './tasks.js';

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
}

interface MutableAggregate {
  key: string;
  affectedTaskIds: Set<string>;
  relatedKeys: Set<string>;
  findingCount: number;
  lastOccurredAt: string;
}

export function buildLaunchDependencyDiagnostics(
  tasks: readonly Pick<Task, 'id' | 'createdAt' | 'launchHealthSummary'>[],
): LaunchDependencyDiagnosticsSnapshot {
  const degradedTaskIds = new Set<string>();
  const byDependency = new Map<string, MutableAggregate>();
  const byCategory = new Map<string, MutableAggregate>();
  let totalFindings = 0;

  for (const task of tasks) {
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

  return {
    schemaVersion: 'launch-dependency-diagnostics.v1',
    totalDegradedTasks: degradedTaskIds.size,
    totalFindings,
    dependencies: toSortedRows(byDependency, 'categories'),
    categories: toSortedRows(byCategory, 'dependencies'),
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

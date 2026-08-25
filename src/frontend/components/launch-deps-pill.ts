/**
 * Label + tooltip helpers for the launch-dependencies status-bar pill
 * (issue #2364 / #2841). Elevated when degraded launches or parked work exists.
 */

import type { LaunchDependenciesStatus } from '../store/store-types.js';

/** Max dependency segments shown on the compact pill before "+N". */
export const LAUNCH_DEPS_PILL_MAX_SEGMENTS = 2;

export function shouldShowLaunchDepsPill(
  status: LaunchDependenciesStatus | null | undefined,
): boolean {
  if (status == null) return false;
  const total = status.totalDegradedTasks;
  const parked = status.parkedTaskCount ?? 0;
  return (
    typeof total === 'number' && Number.isFinite(total) && total > 0
  ) || parked > 0;
}

/**
 * Compact label, e.g. `Deps: kb×8` or `Deps: kb×2 · gh×1`.
 * Falls back to `Deps: N` when dependency rows are empty.
 */
export function formatLaunchDepsLabel(status: LaunchDependenciesStatus): string {
  const total = Math.max(0, Math.floor(status.totalDegradedTasks));
  const elevated = status.dependencies
    .filter((row) => row.degradedTaskCount > 0 && row.dependency.length > 0)
    .slice(0, LAUNCH_DEPS_PILL_MAX_SEGMENTS)
    .map((row) => `${row.dependency}×${Math.floor(row.degradedTaskCount)}`);
  const parked = (status.parkedByDependency ?? [])
    .filter((row) => row.taskCount > 0 && row.dependency.length > 0)
    .slice(0, LAUNCH_DEPS_PILL_MAX_SEGMENTS)
    .map((row) => `${row.dependency}×${Math.floor(row.taskCount)}`);

  const label = elevated.length === 0
    ? `Deps: ${total}`
    : `Deps: ${elevated.join(' · ')}`;
  if (parked.length === 0) {
    if (elevated.length === 0) return label;
    const remaining =
      status.dependencies.filter((row) => row.degradedTaskCount > 0).length - elevated.length;
    return remaining > 0 ? `${label} +${remaining}` : label;
  }

  return `${label} · Parked: ${parked.join(' · ')}`;
}

/**
 * Tooltip listing dependency×count (categories) and a pointer at the health block.
 */
export function formatLaunchDepsTitle(status: LaunchDependenciesStatus): string {
  const total = Math.max(0, Math.floor(status.totalDegradedTasks));
  const parts: string[] = total > 0
    ? [`${total} task${total === 1 ? '' : 's'} launched with degraded dependencies`]
    : [];

  if ((status.parkedTaskCount ?? 0) > 0) {
    const parkedParts = (status.parkedByDependency ?? [])
      .filter((row) => row.taskCount > 0)
      .map((row) => {
        const reasons = row.reasons.length > 0 ? ` (${row.reasons.join(', ')})` : '';
        return `${row.dependency}=${row.taskCount}${reasons}`;
      });
    parts.push(
      `${status.parkedTaskCount} task${status.parkedTaskCount === 1 ? '' : 's'} parked awaiting dependency recovery`,
      ...parkedParts,
    );
  }

  if (typeof status.totalFindings === 'number' && Number.isFinite(status.totalFindings)) {
    parts.push(`findings=${Math.floor(status.totalFindings)}`);
  }

  for (const row of status.dependencies) {
    if (row.degradedTaskCount <= 0) continue;
    const cats =
      row.categories.length > 0 ? ` (${row.categories.join(', ')})` : '';
    parts.push(`${row.dependency}=${Math.floor(row.degradedTaskCount)}${cats}`);
  }

  parts.push('See GET /api/health.launchDependencies');
  return parts.join(' · ');
}

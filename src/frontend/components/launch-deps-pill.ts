/**
 * Label + tooltip helpers for the launch-dependencies status-bar pill
 * (issue #2364 / #2841 / #3153). Elevated when *confirmed* degraded launches or
 * parked work exists — an unknown-only (probe-unavailable) condition does not
 * fire the degradation alarm.
 */

import type { LaunchDependenciesStatus } from '../store/store-types.js';

/** Max dependency segments shown on the compact pill before "+N". */
export const LAUNCH_DEPS_PILL_MAX_SEGMENTS = 2;

export function shouldShowLaunchDepsPill(
  status: LaunchDependenciesStatus | null | undefined,
): boolean {
  if (status == null) return false;
  const parked = status.parkedTaskCount ?? 0;
  if (parked > 0) return true;

  // When the server exposes the confirmed/unknown split (issue #3153), gate the
  // degradation alarm on *confirmed* degradation only. An unknown-only fleet
  // (a probe that could not be bounded, e.g. a kb timeout) is not a confirmed
  // degradation and must not fire a persistent red pill that trains operators
  // to ignore it. The split is present when either field is defined; an older
  // server omits both and falls back to the conflated total.
  const { totalConfirmedDegradedTasks: confirmedCount, totalUnknownTasks: unknownCount } = status;
  if (confirmedCount !== undefined || unknownCount !== undefined) {
    return (confirmedCount ?? 0) > 0;
  }

  const total = status.totalDegradedTasks;
  return typeof total === 'number' && Number.isFinite(total) && total > 0;
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
    if (elevated.length === 0) {
      return parkedCountLabel(status, label);
    }
    const remaining =
      status.dependencies.filter((row) => row.degradedTaskCount > 0).length - elevated.length;
    const elevatedLabel = remaining > 0 ? `${label} +${remaining}` : label;
    return parkedCountLabel(status, elevatedLabel);
  }

  return `${label} · Parked: ${parked.join(' · ')}`;
}

function parkedCountLabel(status: LaunchDependenciesStatus, label: string): string {
  const parkedCount = Math.max(0, Math.floor(status.parkedTaskCount ?? 0));
  return parkedCount > 0 ? `${label} · Parked: ${parkedCount}` : label;
}

/**
 * Tooltip listing dependency×count (categories) and a pointer at the health block.
 */
export function formatLaunchDepsTitle(status: LaunchDependenciesStatus): string {
  const total = Math.max(0, Math.floor(status.totalDegradedTasks));
  const { totalConfirmedDegradedTasks: confirmedRaw, totalUnknownTasks: unknownRaw } = status;
  const hasSplit = confirmedRaw !== undefined || unknownRaw !== undefined;
  const parts: string[] = [];
  if (hasSplit) {
    // Distinguish confirmed degradation from unknown (probe-unavailable)
    // findings so an unknown-only condition is not read as degradation (#3153).
    const confirmedCount = Math.max(0, Math.floor(confirmedRaw ?? 0));
    const unknownCount = Math.max(0, Math.floor(unknownRaw ?? 0));
    if (confirmedCount > 0 || unknownCount > 0) {
      parts.push(`${confirmedCount} confirmed degraded, ${unknownCount} unknown (probe unavailable)`);
    }
  } else if (total > 0) {
    parts.push(`${total} task${total === 1 ? '' : 's'} launched with degraded dependencies`);
  }

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

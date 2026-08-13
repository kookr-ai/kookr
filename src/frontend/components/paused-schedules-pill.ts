/**
 * Label + tooltip helpers for the fail-closed paused-schedules status-bar
 * pill (issue #2432). Elevated-only when schedulesPausedByFailure.length >= 1.
 *
 * This is display only — the pill never resumes a paused schedule.
 */

import type { SchedulesStatus } from '../store/store-types.js';

/** Max schedule names shown in the tooltip before "+N more". */
export const PAUSED_SCHEDULES_TITLE_MAX_NAMES = 3;

export function shouldShowPausedSchedulesPill(
  status: SchedulesStatus | null | undefined,
): boolean {
  if (status == null) return false;
  const rows = status.schedulesPausedByFailure;
  return Array.isArray(rows) && rows.length >= 1;
}

/**
 * Compact label: `1 schedule paused` / `N schedules paused`.
 */
export function formatPausedSchedulesLabel(status: SchedulesStatus): string {
  const count = status.schedulesPausedByFailure.length;
  return count === 1 ? '1 schedule paused' : `${count} schedules paused`;
}

/**
 * Tooltip listing sampled names with consecutive-failure counts and a
 * pointer at the health block. Does not offer resume.
 */
export function formatPausedSchedulesTitle(status: SchedulesStatus): string {
  const rows = status.schedulesPausedByFailure;
  const count = rows.length;
  const parts: string[] = [
    `${count} schedule${count === 1 ? '' : 's'} paused after consecutive failures`,
  ];

  const shown = rows.slice(0, PAUSED_SCHEDULES_TITLE_MAX_NAMES);
  for (const row of shown) {
    parts.push(`${row.name} (fail×${row.consecutiveFailures})`);
  }
  const remaining = count - shown.length;
  if (remaining > 0) parts.push(`+${remaining} more`);

  parts.push('See GET /api/health.schedules');
  return parts.join(' · ');
}

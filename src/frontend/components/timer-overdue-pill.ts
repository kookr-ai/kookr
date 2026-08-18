/**
 * Label + tooltip helpers for the lifecycle-timer overdue status-bar pill
 * (issue #2643). Elevated-only when `timerHealth.overdue > 0`. Hidden when
 * the `/api/health` block is missing (old server) or the count is zero.
 *
 * Display only — the pill never restarts a timer.
 */

import type { TimerHealthStatus } from '../store/store-types.js';

export function shouldShowTimerOverduePill(
  status: TimerHealthStatus | null | undefined,
): boolean {
  if (status == null) return false;
  const overdue = status.overdue;
  return typeof overdue === 'number' && Number.isFinite(overdue) && overdue > 0;
}

/**
 * Compact label: `1 timer overdue · save` / `2 timers overdue · save`.
 * Count-only when the summary has no oldest name.
 */
export function formatTimerOverdueLabel(status: TimerHealthStatus): string {
  const count = Math.max(0, Math.floor(status.overdue));
  const noun = count === 1 ? 'timer overdue' : 'timers overdue';
  const base = `${count} ${noun}`;
  return status.oldestName ? `${base} · ${status.oldestName}` : base;
}

/**
 * Tooltip with the overdue count, oldest loop name, and a pointer at the
 * health summary. Mentions Diagnostics when the pill is clickable.
 */
export function formatTimerOverdueTitle(
  status: TimerHealthStatus,
  clickable: boolean,
): string {
  const count = Math.max(0, Math.floor(status.overdue));
  const parts: string[] = [
    `${count} lifecycle timer${count === 1 ? '' : 's'} overdue`,
  ];
  if (status.oldestName) {
    parts.push(`oldest ${status.oldestName}`);
  }
  parts.push(
    clickable
      ? 'Open Diagnostics'
      : 'A safety-net loop stopped ticking',
  );
  parts.push('See GET /api/health.timerHealth');
  return parts.join(' · ');
}

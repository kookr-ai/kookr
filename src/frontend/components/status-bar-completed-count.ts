/**
 * Status-bar copy for the 24-hour completed-task chip (issue #2618).
 *
 * Counting lives in `countCompletedInWindow`. This file only formats the
 * label/tooltip and decides whether the chip is visible. Different unit from
 * the unblocked-finding chip (#2609).
 */

import { TIME_TO_UNBLOCK_WINDOW_MS } from '../../shared/contracts/time-to-unblock.js';

/** Hours in the rolling window, floored at 1 so a tiny window still reads as time. */
function completedWindowHours(windowMs: number): number {
  return Math.max(1, Math.round(windowMs / 3_600_000));
}

export function shouldShowCompletedInWindowChip(count: number): boolean {
  return Number.isFinite(count) && count > 0;
}

/** Chip label: "3 completed / 24h". Callers hide the chip at zero. */
export function formatCompletedInWindowChipLabel(
  count: number,
  windowMs: number = TIME_TO_UNBLOCK_WINDOW_MS,
): string {
  return `${count} completed / ${completedWindowHours(windowMs)}h`;
}

/**
 * Tooltip: terminal-status throughput, plus the live-list lower-bound caveat.
 * The dashboard snapshot ages out and caps completed rows, so this count can
 * miss tasks that finished and then dropped off the wire snapshot.
 */
export function formatCompletedInWindowChipTitle(
  count: number,
  windowMs: number = TIME_TO_UNBLOCK_WINDOW_MS,
): string {
  const hours = completedWindowHours(windowMs);
  const noun = count === 1 ? 'task' : 'tasks';
  return `${count} ${noun} reached a terminal status in the last ${hours} hours. Lower bound — may miss tasks that finished and then aged out of the live list.`;
}

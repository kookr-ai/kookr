/**
 * Status-bar copy for the 24-hour launched-task chip (issue #2632).
 *
 * Counting lives in `countLaunchedInWindow`. This file only formats the
 * label/tooltip and decides whether the chip is visible. Sibling of the
 * completed-task chip (#2618); different unit from the unblocked-finding
 * chip (#2609).
 */

import { TIME_TO_UNBLOCK_WINDOW_MS } from '../../shared/contracts/time-to-unblock.js';

/** Hours in the rolling window, floored at 1 so a tiny window still reads as time. */
function launchedWindowHours(windowMs: number): number {
  return Math.max(1, Math.round(windowMs / 3_600_000));
}

export function shouldShowLaunchedInWindowChip(count: number): boolean {
  return Number.isFinite(count) && count > 0;
}

/** Chip label: "3 launched / 24h". Callers hide the chip at zero. */
export function formatLaunchedInWindowChipLabel(
  count: number,
  windowMs: number = TIME_TO_UNBLOCK_WINDOW_MS,
): string {
  return `${count} launched / ${launchedWindowHours(windowMs)}h`;
}

/**
 * Tooltip: start-time intake, plus the live-list lower-bound caveat.
 * The dashboard snapshot ages out and caps old rows, so this count can
 * miss tasks that started and then dropped off the wire snapshot.
 */
export function formatLaunchedInWindowChipTitle(
  count: number,
  windowMs: number = TIME_TO_UNBLOCK_WINDOW_MS,
): string {
  const hours = launchedWindowHours(windowMs);
  const noun = count === 1 ? 'task' : 'tasks';
  return `${count} ${noun} started in the last ${hours} hours. Lower bound — may miss tasks that launched and then aged out of the live list.`;
}

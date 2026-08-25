import type { ScheduleResponse, ScheduleRollup } from '../shared/protocol.js';
import { formatCost } from './presentation.js';

/**
 * Relative next-run / last-run label used by the schedules list, dialog, and
 * the no-selection overview. ISO timestamps are compared to `nowMs` (default
 * wall clock); the scheduler already stores next-run in UTC.
 */
export function formatScheduleRelativeTime(iso: string | null | undefined, nowMs = Date.now()): string {
  if (!iso) return 'N/A';
  const diff = new Date(iso).getTime() - nowMs;
  const absDiff = Math.abs(diff);
  const minutes = Math.floor(absDiff / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  let label: string;
  if (days > 0) label = `${days}d`;
  else if (hours > 0) label = `${hours}h`;
  else if (minutes > 0) label = `${minutes}m`;
  else label = '<1m';

  return diff < 0 ? `${label} ago` : `in ${label}`;
}

/** Next-fire label: paused / exhausted win over a leftover timestamp. */
export function scheduleNextRunLabel(
  schedule: Pick<ScheduleResponse, 'enabled' | 'stopReason' | 'nextRunAt'>,
  nowMs = Date.now(),
): string {
  if (schedule.stopReason === 'trigger_limit_reached') return 'exhausted';
  if (!schedule.enabled) return 'paused';
  return formatScheduleRelativeTime(schedule.nextRunAt, nowMs);
}

type ScheduleRollupGlance = Pick<ScheduleRollup, 'fires' | 'measuredFires' | 'costUsd' | 'artifacts'>;

function countLabel(count: number, singular: string, plural: string): string {
  return count === 1 ? `1 ${singular}` : `${count} ${plural}`;
}

/**
 * One-glance scorecard: fires · final closeout spend · artifacts.
 * Returns null when there are no retained fires so a never-run schedule
 * (the store still materializes a zero row) does not read as "unmeasured".
 * Unmeasured fires (no token usage) never render as $0.
 */
export function formatScheduleRollupLine(rollup: ScheduleRollupGlance): string | null {
  if (rollup.fires === 0) return null;
  const fires = countLabel(rollup.fires, 'fire', 'fires');
  const artifacts = countLabel(rollup.artifacts, 'artifact', 'artifacts');
  const cost = rollup.measuredFires > 0
    ? `${formatCost(rollup.costUsd)} final closeout`
    : 'unmeasured';
  return `${fires} · ${cost} · ${artifacts}`;
}

/** Names the measuredFires denominator so $0 is not inferred from missing usage. */
export function scheduleRollupTooltip(rollup: Pick<ScheduleRollup, 'fires' | 'measuredFires'>): string {
  return `Measured final closeout spend covers ${rollup.measuredFires} of ${rollup.fires} fires that reported token usage. Unmeasured fires are omitted from cost, not counted as $0.`;
}

function nextRunSortKey(schedule: Pick<ScheduleResponse, 'nextRunAt'>): number {
  return schedule.nextRunAt ? Date.parse(schedule.nextRunAt) : Number.POSITIVE_INFINITY;
}

function isFireableSchedule(schedule: ScheduleResponse): boolean {
  return schedule.enabled && schedule.stopReason !== 'trigger_limit_reached' && Boolean(schedule.nextRunAt);
}

/**
 * One row for the overview: the soonest schedule that will actually fire, or
 * a paused/exhausted stand-in when nothing is going to run.
 */
export function pickNextOverviewSchedule(schedules: ScheduleResponse[]): ScheduleResponse | null {
  if (schedules.length === 0) return null;
  const fireable = schedules.filter(isFireableSchedule);
  const pool = fireable.length > 0 ? fireable : schedules;
  return [...pool].sort((a, b) => nextRunSortKey(a) - nextRunSortKey(b))[0] ?? null;
}

/**
 * Dashboard product metric: how long findings waited for a human reply.
 *
 * A finding is an agent blocked on a person. Time-to-unblock is how long
 * that wait lasted before someone actually replied. The StatusBar chip
 * shows the median of those waits so one hour-scale outlier cannot dominate.
 */

export const TIME_TO_UNBLOCK_SCHEMA_VERSION = 'time-to-unblock.v1' as const;

/** Rolling window for the live chip: last 24 hours of resolved waits. */
export const TIME_TO_UNBLOCK_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Hide the StatusBar chip until this many human-reply samples exist.
 * 5 is large enough that a couple of fast replies cannot paint a false
 * "we are fast" story, and small enough that a working day can fill it.
 */
export const TIME_TO_UNBLOCK_MIN_SAMPLES = 5;

export interface TimeToUnblockSnapshot {
  schemaVersion: typeof TIME_TO_UNBLOCK_SCHEMA_VERSION;
  /** Median wait in milliseconds, or null when there are no eligible samples. */
  medianMs: number | null;
  sampleCount: number;
  windowMs: number;
  generatedAt: string;
}

export function emptyTimeToUnblockSnapshot(
  nowMs: number,
  windowMs: number = TIME_TO_UNBLOCK_WINDOW_MS,
): TimeToUnblockSnapshot {
  return {
    schemaVersion: TIME_TO_UNBLOCK_SCHEMA_VERSION,
    medianMs: null,
    sampleCount: 0,
    windowMs,
    generatedAt: new Date(nowMs).toISOString(),
  };
}

/**
 * Format a wait for the StatusBar chip: "45s", "12m", "1h 5m", "2d".
 * Seconds only appear under a minute. Lives here (not in core) so the
 * dashboard can import it without Node fs.
 */
export function formatUnblockWait(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1_000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) {
    const hours = Math.floor(ms / 3_600_000);
    const minutes = Math.round((ms % 3_600_000) / 60_000);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.round(ms / 86_400_000);
  return `${days}d`;
}

/** Rolling-window suffix so the count is not read as calendar-today. */
export function formatUnblockWindowLabel(windowMs: number = TIME_TO_UNBLOCK_WINDOW_MS): string {
  const hours = Math.max(1, Math.round(windowMs / 3_600_000));
  return `${hours}h`;
}

/**
 * StatusBar chip label: volume next to speed, e.g. "12 unblocked (24h) · median 8m".
 * When `sampleCount` is 0, omit the count so a zero does not look like a cleared queue.
 */
export function formatTimeToUnblockChipLabel(
  sampleCount: number,
  medianMs: number,
  windowMs: number = TIME_TO_UNBLOCK_WINDOW_MS,
): string {
  const median = `median ${formatUnblockWait(medianMs)}`;
  if (sampleCount <= 0) return median;
  return `${sampleCount} unblocked (${formatUnblockWindowLabel(windowMs)}) · ${median}`;
}

/** Tooltip: same rolling window as the visible count, human-reply only. */
export function formatTimeToUnblockChipTitle(
  sampleCount: number,
  medianMs: number,
  windowMs: number = TIME_TO_UNBLOCK_WINDOW_MS,
): string {
  const hours = Math.max(1, Math.round(windowMs / 3_600_000));
  if (sampleCount <= 0) {
    return `Median time a finding waited for a human reply over the last ${hours} hours`;
  }
  return `${sampleCount} findings unblocked by a human reply over the last ${hours} hours; median wait ${formatUnblockWait(medianMs)}. Skip and snooze are not counted.`;
}

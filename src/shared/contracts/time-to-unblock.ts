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
 * The issue example is "median unblock 12m"; seconds only appear under a minute.
 * Lives here (not in core) so the dashboard can import it without Node fs.
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

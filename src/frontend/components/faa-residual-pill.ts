/**
 * Threshold + label helpers for the finishedAwaitingAck residual status-bar
 * pill (issue #2082). Pure so unit tests cover the gate without a full render.
 */

/** Show the pill when FAA count is at or above this (chronic residual). */
export const FAA_RESIDUAL_COUNT_THRESHOLD = 3;

/** Show the pill when the oldest FAA task is at or above this age (30 minutes). */
export const FAA_RESIDUAL_AGE_MS_THRESHOLD = 30 * 60_000;

/**
 * Visibility gate: pill shows when residual is chronic by count (≥3) or by
 * age (≥30m). Hidden when count is 0/negative or when both signals are below
 * threshold.
 */
export function shouldShowFaaResidualPill(
  finishedAwaitingAck: number,
  oldestAgeMs: number | null,
): boolean {
  if (!Number.isFinite(finishedAwaitingAck) || finishedAwaitingAck <= 0) return false;
  if (finishedAwaitingAck >= FAA_RESIDUAL_COUNT_THRESHOLD) return true;
  if (oldestAgeMs != null && Number.isFinite(oldestAgeMs) && oldestAgeMs >= FAA_RESIDUAL_AGE_MS_THRESHOLD) {
    return true;
  }
  return false;
}

/** Compact age for the pill label (`45m`, `2h`, `2.5h`, `3d`). */
export function formatFaaResidualAge(ageMs: number | null): string | null {
  if (ageMs == null || !Number.isFinite(ageMs) || ageMs < 0) return null;
  if (ageMs < 60_000) return '<1m';
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = ageMs / 3_600_000;
  if (hours < 24) {
    const rounded = Math.round(hours * 10) / 10;
    return `${rounded}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

/** Pill text: `FAA residual N · age` (age omitted when unknown). */
export function formatFaaResidualLabel(
  finishedAwaitingAck: number,
  oldestAgeMs: number | null,
): string {
  const count = Math.max(0, Math.floor(finishedAwaitingAck));
  const age = formatFaaResidualAge(oldestAgeMs);
  return age ? `FAA residual ${count} · ${age}` : `FAA residual ${count}`;
}

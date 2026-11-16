/**
 * Label and tooltip for the "task namer failing" System pill (issue #3616).
 * Shown only when the server says every LLM naming attempt has failed for at
 * least `KOOKR_TASK_NAMER_ALERT_HOURS`. Tasks still run and still get a
 * prompt-derived name meanwhile, so this is a "needs a look", not an error.
 */

import type { TaskNamerStatus } from '../store/store-types.js';

export function shouldShowTaskNamerPill(status: TaskNamerStatus | null | undefined): boolean {
  return status?.silent === true;
}

/** Whole hours the failing streak spans (first to latest failure), at least 1. */
function failingHours(status: TaskNamerStatus): number {
  const { failingSinceMs, lastFailureAtMs } = status;
  const spanMs = failingSinceMs !== null && lastFailureAtMs !== null
    ? lastFailureAtMs - failingSinceMs
    : status.thresholdMs;
  return Math.max(1, Math.floor(spanMs / 3_600_000));
}

/** Compact label: `Task namer failing 7h`. */
export function formatTaskNamerLabel(status: TaskNamerStatus): string {
  return `Task namer failing ${failingHours(status)}h`;
}

/** Tooltip: what is wrong, since when, and where to look next. */
export function formatTaskNamerTitle(status: TaskNamerStatus): string {
  const parts: string[] = [
    `Every LLM naming call has failed for ${failingHours(status)}h (${status.failedAttempts} attempt${status.failedAttempts === 1 ? '' : 's'}); new tasks get names taken from their prompt`,
  ];
  if (status.lastSuccessAtMs !== null) {
    parts.push(`last successful name ${new Date(status.lastSuccessAtMs).toISOString()}`);
  }
  parts.push('Check KOOKR_LLM_PROVIDER and the provider model · GET /api/health.taskNamer and helperLlm');
  return parts.join(' · ');
}

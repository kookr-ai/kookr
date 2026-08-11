import type { OssAttemptStore } from '../core/oss-attempt-store.js';
import type { OssAttemptsSnapshot } from '../shared/contracts/messages.js';

/**
 * Slim OSS-attempts gauge for `GET /api/health` and `kookr status` (issue #2332).
 * Counts only — never embeds the attempts array (that stays on GET /api/oss-attempts).
 */
export interface OssAttemptsHealthSummary {
  /** Attempts currently in `pr_open` state. */
  openCount: number;
  /** Total stored attempts (all states). */
  totalCount: number;
  /** ISO timestamp of the last successful OSS refresh, or null if never. */
  lastRefreshAt: string | null;
  /** Count of issue-state fetch failures from the most recent refresh run. */
  issueCheckErrorCount: number;
}

/**
 * Project the store's internal state onto the dashboard wire shape.
 *
 * Kept as a single-file boundary because (a) it makes the coupling between
 * storage and protocol explicit at every callsite, and (b) it gives us one
 * place to hang version/compat shims if the wire shape diverges from the
 * stored shape later.
 */
export function toOssAttemptsSnapshot(
  store: OssAttemptStore,
  registryActiveRepos: readonly string[] = [],
): OssAttemptsSnapshot {
  return {
    attempts: store.getAllAttempts(),
    registryActiveRepos: [...registryActiveRepos],
    lastRefreshAt: store.getLastRefreshAt(),
    lastRefreshIssueCheckErrors: store.getLastRefreshIssueCheckErrors(),
  };
}

/**
 * Cheap in-memory OSS attempts summary for the health hot path.
 * Uses the read-only attempts view (no deep clone) so frequent polls stay light.
 */
export function summarizeOssAttemptsForHealth(
  store: Pick<
    OssAttemptStore,
    'getAttemptsReadonly' | 'getLastRefreshAt' | 'getLastRefreshIssueCheckErrors'
  >,
): OssAttemptsHealthSummary {
  const attempts = store.getAttemptsReadonly();
  let openCount = 0;
  for (const attempt of attempts) {
    if (attempt.state === 'pr_open') openCount += 1;
  }
  return {
    openCount,
    totalCount: attempts.length,
    lastRefreshAt: store.getLastRefreshAt(),
    issueCheckErrorCount: store.getLastRefreshIssueCheckErrors().length,
  };
}

import type { OssAttemptStore } from '../core/oss-attempt-store.js';
import type { OssAttemptsSnapshot } from '../shared/contracts/messages.js';

/**
 * Project the store's internal state onto the dashboard wire shape.
 *
 * Kept as a single-file boundary because (a) it makes the coupling between
 * storage and protocol explicit at every callsite, and (b) it gives us one
 * place to hang version/compat shims if the wire shape diverges from the
 * stored shape later.
 */
export function toOssAttemptsSnapshot(store: OssAttemptStore): OssAttemptsSnapshot {
  return {
    attempts: store.getAllAttempts(),
    lastRefreshAt: store.getLastRefreshAt(),
    lastRefreshIssueCheckErrors: store.getLastRefreshIssueCheckErrors(),
  };
}

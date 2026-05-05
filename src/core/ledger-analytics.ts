import {
  projectIdForRepo,
  projectIdToRepoVariants,
  type ContributionAttempt,
  type LedgerEntry,
} from './oss-attempt-store.js';

/**
 * Minimum read surface the analytics need. `OssAttemptStore` satisfies it
 * directly, so server bootstrap can construct `new LedgerAnalytics(store)`.
 * Narrower than the full store interface so tests and future non-store
 * consumers can pass a lighter stub. The attempts accessor is non-cloning
 * (`readonly`) because these queries never mutate records and the broadcast
 * path cannot afford an N-per-project `structuredClone` per fire.
 */
export interface LedgerAnalyticsSource {
  getAllLedgerEntries(): LedgerEntry[];
  getAttemptsReadonly(): readonly ContributionAttempt[];
}

/**
 * Read-model over the contribution ledger and PR attempts. Owns none of the
 * store's mutable state — every method is a stateless query over the entries
 * + attempts the source exposes. Split out from `OssAttemptStore` so the
 * store owns only the PR lifecycle state machine (see issue #385).
 */
export class LedgerAnalytics {
  constructor(private readonly source: LedgerAnalyticsSource) {}

  /**
   * All project IDs (`github.com/owner/repo`) that have at least one
   * PR-keyed attempt — used by sidebar membership and the project-summary
   * compute path.
   */
  getProjects(): string[] {
    const set = new Set<string>();
    for (const a of this.source.getAttemptsReadonly()) {
      if (a.state === 'scouted') continue;
      set.add(projectIdForRepo(a.repo));
    }
    return [...set];
  }

  /**
   * PR-keyed attempts for a project within the last N days. Used by
   * project-summary for "open PRs" count and last-contribution timestamp.
   * Scouted-only records are excluded.
   */
  getAttemptsByProjectRecent(projectId: string, days: number): ContributionAttempt[] {
    const repoVariants = projectIdToRepoVariants(projectId);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString();
    return this.source.getAttemptsReadonly().filter(
      (a) =>
        a.state !== 'scouted' &&
        repoVariants.includes(a.repo.toLowerCase()) &&
        a.createdAt >= cutoffStr,
    );
  }

  /**
   * Effective count of PRs created today for a project, derived from the
   * ledger's `pr_created` entries and offset by any `slot_reset` entries.
   * This is the rate-limit-facing count, not the lifecycle count — a PR
   * that later merged still counts as created today.
   */
  getTodayCount(projectId: string): number {
    const today = new Date().toISOString().split('T')[0];
    const repoVariants = projectIdToRepoVariants(projectId);
    let created = 0;
    let resets = 0;
    for (const e of this.source.getAllLedgerEntries()) {
      if (!repoVariants.includes(e.repo.toLowerCase())) continue;
      if (!e.timestamp.startsWith(today)) continue;
      if (e.action === 'pr_created') created += 1;
      else if (e.action === 'slot_reset') resets += 1;
    }
    return Math.max(0, created - resets);
  }

  /**
   * Count of ledger `pr_created` entries for a project within the last N days.
   * Used by the "PRs this week" chip in the sidebar.
   */
  getWeekCount(projectId: string): number {
    const repoVariants = projectIdToRepoVariants(projectId);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffStr = cutoff.toISOString();
    let count = 0;
    for (const e of this.source.getAllLedgerEntries()) {
      if (e.action !== 'pr_created') continue;
      if (!repoVariants.includes(e.repo.toLowerCase())) continue;
      if (e.timestamp < cutoffStr) continue;
      count += 1;
    }
    return count;
  }

  /**
   * Blocked / rate-limited ledger entries from today. Surfaced to the UI as
   * warning banners by the ledger watcher.
   */
  getTodayBlockedEntries(): LedgerEntry[] {
    const today = new Date().toISOString().split('T')[0];
    return this.source.getAllLedgerEntries().filter(
      (e) =>
        (e.action === 'pr_blocked_rate_limit' || e.action === 'pr_blocked_blocked_repo') &&
        e.timestamp.startsWith(today),
    );
  }
}

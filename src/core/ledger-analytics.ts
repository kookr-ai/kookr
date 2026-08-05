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
   * All PR-keyed attempts for a project. Scouted-only records are excluded.
   * Used by project-summary for current-state counters such as "open PRs".
   */
  getAttemptsByProject(projectId: string): ContributionAttempt[] {
    const repoVariants = projectIdToRepoVariants(projectId);
    return this.source.getAttemptsReadonly().filter(
      (a) =>
        a.state !== 'scouted' &&
        repoVariants.includes(a.repo.toLowerCase()),
    );
  }

  /**
   * PR-keyed attempts for a project within the last N days. Used by
   * contribution-history endpoints that intentionally show recent activity.
   * Scouted-only records are excluded.
   */
  getAttemptsByProjectRecent(projectId: string, days: number): ContributionAttempt[] {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString();
    return this.getAttemptsByProject(projectId).filter((a) => a.createdAt >= cutoffStr);
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
   * Build a reverse index from each project's repo variants back to the
   * project IDs that own them, in a single pass over `projectIds`. Multiple
   * projects can share a variant, so values are arrays. The `projects` array
   * is the materialized `projectIds` (an `Iterable` can only be consumed once)
   * and preserves iteration order for deterministic result maps.
   *
   * Shared by the batch aggregation methods below so `computeProjectSummaries`
   * can resolve every project in a constant number of ledger/attempt scans
   * instead of one scan (plus one array clone) per project.
   */
  private buildVariantIndex(projectIds: Iterable<string>): {
    variantToProjects: Map<string, string[]>;
    projects: string[];
  } {
    const variantToProjects = new Map<string, string[]>();
    const projects: string[] = [];
    for (const projectId of projectIds) {
      projects.push(projectId);
      for (const variant of projectIdToRepoVariants(projectId)) {
        const list = variantToProjects.get(variant);
        if (list) list.push(projectId);
        else variantToProjects.set(variant, [projectId]);
      }
    }
    return { variantToProjects, projects };
  }

  /**
   * Batch equivalent of {@link getTodayCount} for many projects in one ledger
   * scan. Returns a `Map` keyed by every id in `projectIds` (projects with no
   * matching ledger rows resolve to `0`). Value for a project equals
   * `getTodayCount(project)` exactly. See {@link buildVariantIndex}.
   */
  getTodayCountsByProject(projectIds: Iterable<string>): Map<string, number> {
    const today = new Date().toISOString().split('T')[0];
    const { variantToProjects, projects } = this.buildVariantIndex(projectIds);
    const net = new Map<string, number>();
    for (const projectId of projects) net.set(projectId, 0);
    for (const e of this.source.getAllLedgerEntries()) {
      if (!e.timestamp.startsWith(today)) continue;
      const delta = e.action === 'pr_created' ? 1 : e.action === 'slot_reset' ? -1 : 0;
      if (delta === 0) continue;
      const matched = variantToProjects.get(e.repo.toLowerCase());
      if (!matched) continue;
      for (const projectId of matched) net.set(projectId, net.get(projectId)! + delta);
    }
    for (const [projectId, value] of net) net.set(projectId, Math.max(0, value));
    return net;
  }

  /**
   * Batch equivalent of {@link getWeekCount} for many projects in one ledger
   * scan. Returns a `Map` keyed by every id in `projectIds` (projects with no
   * matching ledger rows resolve to `0`). Value for a project equals
   * `getWeekCount(project)` exactly. See {@link buildVariantIndex}.
   */
  getWeekCountsByProject(projectIds: Iterable<string>): Map<string, number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffStr = cutoff.toISOString();
    const { variantToProjects, projects } = this.buildVariantIndex(projectIds);
    const counts = new Map<string, number>();
    for (const projectId of projects) counts.set(projectId, 0);
    for (const e of this.source.getAllLedgerEntries()) {
      if (e.action !== 'pr_created') continue;
      if (e.timestamp < cutoffStr) continue;
      const matched = variantToProjects.get(e.repo.toLowerCase());
      if (!matched) continue;
      for (const projectId of matched) counts.set(projectId, counts.get(projectId)! + 1);
    }
    return counts;
  }

  /**
   * Batch equivalent of {@link getAttemptsByProject} for many projects in one
   * pass over the (non-cloning) attempts view. Returns a `Map` keyed by every
   * id in `projectIds` (projects with no matching attempts resolve to an empty
   * array). Value for a project equals `getAttemptsByProject(project)` exactly,
   * including attempt order. See {@link buildVariantIndex}.
   */
  getAttemptsByProjectMap(projectIds: Iterable<string>): Map<string, ContributionAttempt[]> {
    const { variantToProjects, projects } = this.buildVariantIndex(projectIds);
    const result = new Map<string, ContributionAttempt[]>();
    for (const projectId of projects) result.set(projectId, []);
    for (const a of this.source.getAttemptsReadonly()) {
      if (a.state === 'scouted') continue;
      const matched = variantToProjects.get(a.repo.toLowerCase());
      if (!matched) continue;
      for (const projectId of matched) result.get(projectId)!.push(a);
    }
    return result;
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

/**
 * Pure sweep-report bucketing (RFC sweep-worktree-ux PR 2, read-only).
 *
 * `buildSweepReport` is the single owner of the disk-aware diagnosis policy:
 * it sorts every worktree the cross-project sweep saw into four buckets and
 * carries per-row footprint, last-touched age, and reason. All measurement
 * (disk/mtime/ignored-scan/fingerprint) enters as pre-computed pure inputs —
 * this module performs no I/O so it is exhaustively unit-testable.
 *
 * The canonical `disposition → pathRemoved` map lives here and is used by BOTH
 * the live report and the reconnect reconstruction, so the two views agree for
 * a given runId (round-3 failure-mode: a single source of truth for "was the
 * path reclaimed?").
 *
 * Staleness signal: the git-index mtime (`.git/worktrees/<id>/index`). Spot-
 * checked empirically before building bucketing on it — the index mtime moves
 * on a nested-file edit + `git status`, whereas the worktree root-directory
 * mtime does not. A missing or future-dated signal forces the row to
 * `needs_call` (fail safe); since PR 2 is read-only this can only cost a
 * pre-selection convenience in PR 3, never data loss.
 */

import type {
  AttemptDisposition,
  CleanupCandidateAssessment,
  CleanupClassification,
  CleanupResultSummary,
  SweepReport,
  SweepReportBucket,
  SweepReportBucketSummary,
  SweepReportNotAnalyzed,
  SweepReportRow,
  WorkspaceAttemptRecord,
} from '../shared/contracts/workspace.js';

export const DEFAULT_STALE_THRESHOLD_DAYS = 14;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Dispositions whose attempt DID remove the worktree path (disk reclaimed).
 *
 * `prune_failed` and `branch_delete_failed` removed the path — only the prune
 * or branch-delete step failed afterward — so they belong in Removed, not
 * "failed". The one genuinely-failed case is `manual_intervention_required`
 * (the `git worktree remove` itself failing), which is excluded here. A crashed
 * attempt carries the default `blocked` disposition, also excluded.
 */
const REMOVED_DISPOSITIONS: ReadonlySet<AttemptDisposition> = new Set<AttemptDisposition>([
  'completed',
  'path_removed_branch_retained',
  'prune_failed',
  'branch_delete_failed',
]);

/** Canonical predicate: did an attempt with this disposition reclaim the path? */
export function dispositionRemovedPath(disposition: AttemptDisposition): boolean {
  return REMOVED_DISPOSITIONS.has(disposition);
}

const BLOCKED_CLASSIFICATIONS: ReadonlySet<CleanupClassification> = new Set<CleanupClassification>([
  'busy',
  'protected',
  'checked_out_elsewhere',
  'unknown',
]);

/** Blocked = non-actionable (busy/protected/checked-out-elsewhere/unknown/detached). */
export function isBlockedClassification(classification: CleanupClassification): boolean {
  return BLOCKED_CLASSIFICATIONS.has(classification);
}

/**
 * A worktree is "probably safe" to reclaim (path removal, branch retained) when
 * it is a clean `unique_commits` branch (the inspector classifies uncommitted
 * work as `dirty`, so `unique_commits` already implies no uncommitted tracked
 * work) that has gone stale: a readable, non-future git-index mtime older than
 * the threshold. Used both to decide which candidates get fingerprint/ignored
 * hydration in the sweep loop and to bucket them here — one definition.
 */
export function isProbablySafe(
  candidate: Pick<CleanupCandidateAssessment, 'classification'>,
  lastTouchedMs: number | null | undefined,
  nowMs: number,
  thresholdDays: number = DEFAULT_STALE_THRESHOLD_DAYS,
): boolean {
  if (candidate.classification !== 'unique_commits') return false;
  return isStale(lastTouchedMs, nowMs, thresholdDays);
}

function isStale(
  lastTouchedMs: number | null | undefined,
  nowMs: number,
  thresholdDays: number,
): boolean {
  if (lastTouchedMs === null || lastTouchedMs === undefined) return false; // unknown → fail safe
  if (lastTouchedMs > nowMs) return false; // future-dated → fail safe
  return nowMs - lastTouchedMs > thresholdDays * MS_PER_DAY;
}

export interface SweepReportMeasurements {
  /** worktreePath → on-disk footprint bytes (`du -sk`), or null when unknown. */
  footprints: ReadonlyMap<string, number | null>;
  /** worktreePath → git-index mtime (ms epoch), or null when unreadable. */
  indexMtimes: ReadonlyMap<string, number | null>;
  /** worktreePath → gitignored-scan result (probably-safe candidates only). */
  ignoredScans: ReadonlyMap<string, { hasSensitiveIgnored: boolean; sample: string[] }>;
  /** worktreePath → optimistic-concurrency fingerprint (probably-safe only). */
  fingerprints: ReadonlyMap<string, string>;
}

export interface BuildSweepReportInput extends SweepReportMeasurements {
  runId: string;
  /** ISO timestamp stamped on the report. */
  generatedAt: string;
  /** Wall-clock ms used for staleness comparison. */
  nowMs: number;
  thresholdDays?: number;
  /** Per-worktree removal summaries returned by the sweep (all imply pathRemoved). */
  summaries: readonly CleanupResultSummary[];
  /** Candidates the sweep attempted to remove (merged / patch_equivalent). */
  safeCandidates: readonly CleanupCandidateAssessment[];
  /** Every other classified candidate (not attempted): the diagnosis surface. */
  nonRemoved: readonly CleanupCandidateAssessment[];
  /** Projects whose classification timed out/errored — loud banner input. */
  notAnalyzed?: readonly SweepReportNotAnalyzed[];
}

/**
 * Build the disk-aware sweep report. Pure: no I/O, deterministic in its inputs.
 */
export function buildSweepReport(input: BuildSweepReportInput): SweepReport {
  const thresholdDays = input.thresholdDays ?? DEFAULT_STALE_THRESHOLD_DAYS;
  const rows: SweepReportRow[] = [];

  const footprintOf = (path: string): number | null => input.footprints.get(path) ?? null;
  const mtimeOf = (path: string): number | null => input.indexMtimes.get(path) ?? null;

  // --- Removed / removal-failed (bucket on actual removal, not classification) ---
  // Consume summaries per branch: CleanupResultSummary carries only `branch`
  // (no projectId/worktreePath), so a cross-project same-branch collision where
  // one removal succeeded and another failed is disambiguated by consumption —
  // one candidate claims the summary (removed), the other finds none
  // (removal_failed), keeping bucket COUNTS exact even if which row is which is
  // ambiguous in that rare case.
  const summaryQueueByBranch = new Map<string, CleanupResultSummary[]>();
  for (const summary of input.summaries) {
    const queue = summaryQueueByBranch.get(summary.branch);
    if (queue) queue.push(summary);
    else summaryQueueByBranch.set(summary.branch, [summary]);
  }

  for (const candidate of input.safeCandidates) {
    if (!candidate.worktreePath) continue;
    const summary = summaryQueueByBranch.get(candidate.branch)?.shift();
    if (summary) {
      // Every CleanupResultSummary disposition is in the removed set.
      rows.push({
        projectId: candidate.projectId,
        worktreePath: candidate.worktreePath,
        branch: candidate.branch,
        classification: candidate.classification,
        reasonCode: candidate.reasonCode,
        bucket: 'removed',
        footprintBytes: footprintOf(candidate.worktreePath),
        lastTouchedMs: mtimeOf(candidate.worktreePath),
        reason: removedReason(summary),
        disposition: summary.disposition,
      });
    } else {
      // Attempted but produced no summary → the `git worktree remove` threw
      // (`manual_intervention_required`). Sourced as safeCandidates − summaries,
      // rendered "removal failed — still on disk".
      rows.push({
        projectId: candidate.projectId,
        worktreePath: candidate.worktreePath,
        branch: candidate.branch,
        classification: candidate.classification,
        reasonCode: candidate.reasonCode,
        bucket: 'removal_failed',
        footprintBytes: footprintOf(candidate.worktreePath),
        lastTouchedMs: mtimeOf(candidate.worktreePath),
        reason: 'removal failed — still on disk',
        disposition: 'manual_intervention_required',
      });
    }
  }

  // --- Non-removed: probably-safe / needs-your-call / blocked ---
  for (const candidate of input.nonRemoved) {
    if (!candidate.worktreePath) continue;
    const path = candidate.worktreePath;
    const lastTouchedMs = mtimeOf(path);

    if (isBlockedClassification(candidate.classification)) {
      rows.push({
        projectId: candidate.projectId,
        worktreePath: path,
        branch: candidate.branch,
        classification: candidate.classification,
        reasonCode: candidate.reasonCode,
        bucket: 'blocked',
        footprintBytes: null, // measurement bounded to non-Blocked candidates
        lastTouchedMs,
        reason: blockedReason(candidate.classification),
      });
      continue;
    }

    if (isProbablySafe(candidate, lastTouchedMs, input.nowMs, thresholdDays)) {
      const ignored = input.ignoredScans.get(path);
      rows.push({
        projectId: candidate.projectId,
        worktreePath: path,
        branch: candidate.branch,
        classification: candidate.classification,
        reasonCode: candidate.reasonCode,
        bucket: 'probably_safe',
        footprintBytes: footprintOf(path),
        lastTouchedMs,
        reason: `stale >${thresholdDays}d · local-only commits · removing the path keeps the branch`,
        hasSensitiveIgnored: ignored?.hasSensitiveIgnored ?? false,
        ignoredSample: ignored?.sample ?? [],
        fingerprint: input.fingerprints.get(path),
      });
      continue;
    }

    rows.push({
      projectId: candidate.projectId,
      worktreePath: path,
      branch: candidate.branch,
      classification: candidate.classification,
      reasonCode: candidate.reasonCode,
      bucket: 'needs_call',
      footprintBytes: footprintOf(path),
      lastTouchedMs,
      reason: needsCallReason(candidate.classification, lastTouchedMs, input.nowMs, thresholdDays),
    });
  }

  return {
    runId: input.runId,
    generatedAt: input.generatedAt,
    thresholdDays,
    rows,
    buckets: summarizeBuckets(rows),
    notAnalyzed: [...(input.notAnalyzed ?? [])],
  };
}

/**
 * Reconstruct the Removed / removal-failed manifest from durable attempt-ledger
 * rows for a given runId — used on reconnect-after-completion. Applies the SAME
 * canonical disposition map as {@link buildSweepReport}, so the two views agree.
 * Only per-worktree cleanup attempts (those carrying a `worktreePath`) are
 * considered; the umbrella per-project sweep attempt is skipped.
 */
export function reconstructRemovedFromLedger(
  attempts: readonly WorkspaceAttemptRecord[],
  runId: string,
  generatedAt: string,
): SweepReport {
  const rows: SweepReportRow[] = [];
  for (const attempt of attempts) {
    if (attempt.sweepRunId !== runId) continue;
    if (!attempt.worktreePath) continue; // skip the umbrella per-project attempt
    if (dispositionRemovedPath(attempt.disposition)) {
      rows.push({
        projectId: attempt.projectId,
        worktreePath: attempt.worktreePath,
        branch: attempt.branch ?? '(unknown)',
        classification: 'merged', // ledger does not retain classification; sweep only removes merged/patch_equivalent
        reasonCode: attempt.reasonCode,
        bucket: 'removed',
        footprintBytes: null, // path already reclaimed
        lastTouchedMs: null,
        reason: ledgerRemovedReason(attempt.disposition),
        disposition: attempt.disposition,
      });
    } else if (attempt.disposition === 'manual_intervention_required') {
      rows.push({
        projectId: attempt.projectId,
        worktreePath: attempt.worktreePath,
        branch: attempt.branch ?? '(unknown)',
        classification: 'merged',
        reasonCode: attempt.reasonCode,
        bucket: 'removal_failed',
        footprintBytes: null,
        lastTouchedMs: null,
        reason: 'removal failed — still on disk',
        disposition: attempt.disposition,
      });
    }
    // `blocked` (crashed / never ran) and `passed` (umbrella) are excluded.
  }

  return {
    runId,
    generatedAt,
    thresholdDays: DEFAULT_STALE_THRESHOLD_DAYS,
    rows,
    buckets: summarizeBuckets(rows),
    notAnalyzed: [],
    reconstructedFromLedger: true,
  };
}

function summarizeBuckets(rows: readonly SweepReportRow[]): Record<SweepReportBucket, SweepReportBucketSummary> {
  const empty = (): SweepReportBucketSummary => ({
    count: 0,
    footprintBytesUpperBound: 0,
    unknownFootprintCount: 0,
  });
  const buckets: Record<SweepReportBucket, SweepReportBucketSummary> = {
    removed: empty(),
    removal_failed: empty(),
    probably_safe: empty(),
    needs_call: empty(),
    blocked: empty(),
  };
  for (const row of rows) {
    const summary = buckets[row.bucket];
    summary.count += 1;
    if (row.footprintBytes === null) {
      summary.unknownFootprintCount += 1;
    } else {
      summary.footprintBytesUpperBound += row.footprintBytes;
    }
  }
  return buckets;
}

function removedReason(summary: CleanupResultSummary): string {
  switch (summary.disposition) {
    case 'completed':
      return 'removed path; deleted branch';
    case 'path_removed_branch_retained':
      return summary.retainedReason === 'ref_changed'
        ? 'removed path; kept branch (ref changed)'
        : 'removed path; kept branch';
    case 'prune_failed':
      return 'removed path; branch deleted; worktree prune failed';
    case 'branch_delete_failed':
      return 'removed path; branch delete failed';
  }
}

function ledgerRemovedReason(disposition: AttemptDisposition): string {
  switch (disposition) {
    case 'completed':
      return 'removed path; deleted branch';
    case 'path_removed_branch_retained':
      return 'removed path; kept branch';
    case 'prune_failed':
      return 'removed path; worktree prune failed';
    case 'branch_delete_failed':
      return 'removed path; branch delete failed';
    default:
      return 'removed path';
  }
}

function blockedReason(classification: CleanupClassification): string {
  switch (classification) {
    case 'busy':
      return 'busy — leased by an active task';
    case 'protected':
      return 'protected worktree';
    case 'checked_out_elsewhere':
      return 'branch checked out in another worktree';
    case 'unknown':
      return 'ambiguous state — inspect manually';
    default:
      return 'blocked';
  }
}

function needsCallReason(
  classification: CleanupClassification,
  lastTouchedMs: number | null,
  nowMs: number,
  thresholdDays: number,
): string {
  switch (classification) {
    case 'dirty':
      return 'uncommitted changes — commit or discard first';
    case 'generated_only':
      return 'only generated artifacts — reclaim with a manual clean';
    case 'stale_worktree':
      return 'stale/locked worktree registry entry';
    case 'unique_commits':
      if (lastTouchedMs === null) return 'local-only commits · last-touched unknown';
      if (lastTouchedMs > nowMs) return 'local-only commits · clock skew on last-touched';
      return `local-only commits · touched within ${thresholdDays}d`;
    default:
      return 'review before removing';
  }
}

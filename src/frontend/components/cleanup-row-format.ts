import type {
  CleanupCandidateAssessment,
  CleanupCommitSummary,
  CleanupDirtySummary,
} from '../../shared/protocol.js';

/**
 * Compute the subtext string shown under the branch name in each
 * cleanup list row. Returns null when the subtext should be omitted
 * entirely (e.g. protected or busy rows).
 */
export function formatCleanupSubtext(
  candidate: CleanupCandidateAssessment,
  now: Date = new Date(),
): { text: string; failed: boolean } | null {
  if (candidate.enrichmentFailed) {
    return { text: '(!) details unavailable', failed: true };
  }

  const classification = candidate.classification;

  // Classifications where no list-level info is meaningful.
  if (classification === 'protected' || classification === 'busy' || classification === 'checked_out_elsewhere' || classification === 'stale_worktree') {
    return null;
  }

  const segments: string[] = [];

  // Detached HEAD (branch === '(detached at ...)') never renders as
  // empty — show the short sha so the user can't misread the row as
  // deletable.
  if (candidate.headShortSha && !candidate.commitSummary) {
    segments.push(`HEAD ${candidate.headShortSha}`);
  } else if (candidate.commitSummary) {
    const agePart = formatAge(candidate.commitSummary.lastCommitAt, now);
    if (agePart) segments.push(agePart);
    segments.push(formatAheadBehind(candidate.commitSummary));
  }

  const dirtyPart = formatDirty(candidate.dirtySummary, classification);
  if (dirtyPart) segments.push(dirtyPart);

  if (segments.length === 0) return null;
  return { text: segments.join(' · '), failed: false };
}

export function formatAge(lastCommitAt: string | undefined, now: Date): string | null {
  if (!lastCommitAt) return null;
  const then = new Date(lastCommitAt);
  if (Number.isNaN(then.getTime())) return null;

  const diffMs = now.getTime() - then.getTime();
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  // Future dates (clock skew or test data) — show absolute.
  if (diffMs < 0) return then.toISOString().slice(0, 10);

  // Beyond 30 days switch to absolute YYYY-MM-DD so long-stale
  // timestamps don't pretend to be precise.
  if (diffMs > 30 * DAY) return then.toISOString().slice(0, 10);

  if (diffMs < MINUTE) return 'just now';
  if (diffMs < HOUR) {
    const minutes = Math.floor(diffMs / MINUTE);
    return `${minutes} min ago`;
  }
  if (diffMs < DAY) {
    const hours = Math.floor(diffMs / HOUR);
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  }
  const days = Math.floor(diffMs / DAY);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

export function formatAheadBehind(summary: CleanupCommitSummary): string {
  return `+${summary.aheadCount} / −${summary.behindCount}`;
}

/**
 * Compact dirty indicator. `null` when the subtext should omit the
 * dirty segment entirely (clean worktree + classification is not
 * dirty), mirroring `git status --short` letters.
 */
export function formatDirty(
  summary: CleanupDirtySummary | undefined,
  classification: CleanupCandidateAssessment['classification'],
): string | null {
  if (!summary) {
    return classification === 'dirty' ? 'uncommitted' : null;
  }
  const parts: string[] = [];
  if (summary.modified) parts.push(`M${summary.modified}`);
  if (summary.added) parts.push(`A${summary.added}`);
  if (summary.deleted) parts.push(`D${summary.deleted}`);
  if (summary.renamed) parts.push(`R${summary.renamed}`);
  if (summary.untracked) parts.push(`U${summary.untracked}`);
  if (parts.length === 0) {
    return classification === 'dirty' ? 'clean' : null;
  }
  if (classification === 'generated_only') {
    return `generated ${parts.join(' ')}`;
  }
  return parts.join(' ');
}

import type {
  GitHubPRState,
  GitHubIssueState,
  GitHubStateChange,
  GitHubReviewThread,
} from './github-types.js';

/**
 * Diff two snapshots of GitHub PR state and return actionable changes.
 * Returns an empty array if there are no meaningful changes.
 */
export function diffPRState(
  prev: GitHubPRState | null,
  current: GitHubPRState,
): GitHubStateChange[] {
  const changes: GitHubStateChange[] = [];
  const ref = current.ref;

  if (!prev) {
    // First fetch — no diff, but report current issues
    if (current.checks.some((c) => c.conclusion === 'failure')) {
      const failedCheck = current.checks.find((c) => c.conclusion === 'failure')!;
      changes.push({ type: 'ci_failed', ref, check: { name: failedCheck.name, conclusion: failedCheck.conclusion ?? 'failure' } });
    }
    if (current.reviewDecision === 'changes_requested') {
      const reviewer = current.reviewers.find((r) => r.state === 'changes_requested');
      if (reviewer) {
        changes.push({ type: 'review_requested_changes', ref, reviewer: reviewer.login });
      }
    }
    for (const thread of current.unresolvedThreads) {
      changes.push({
        type: 'new_unresolved_thread',
        ref,
        thread: { author: thread.author, body: thread.body, path: thread.path },
      });
    }
    return changes;
  }

  // --- PR status changes ---
  if (prev.status !== current.status) {
    if (current.status === 'merged') {
      changes.push({ type: 'pr_merged', ref });
    } else if (current.status === 'closed') {
      changes.push({ type: 'pr_closed', ref });
    }
  }

  if (
    current.status === 'open'
    && prev.mergeable === 'MERGEABLE'
    && current.mergeable === 'CONFLICTING'
  ) {
    changes.push({ type: 'pr_conflicting', ref });
  }

  // --- CI check changes ---
  const prevFailedChecks = new Set(
    prev.checks.filter((c) => c.conclusion === 'failure').map((c) => c.name),
  );
  const prevPassedAll = prev.checks.length > 0 && prev.checks.every(
    (c) => c.status === 'completed' && c.conclusion === 'success',
  );
  const currentPassedAll = current.checks.length > 0 && current.checks.every(
    (c) => c.status === 'completed' && c.conclusion === 'success',
  );

  for (const check of current.checks) {
    if (check.conclusion === 'failure' && !prevFailedChecks.has(check.name)) {
      changes.push({
        type: 'ci_failed',
        ref,
        check: { name: check.name, conclusion: check.conclusion },
      });
    }
  }

  if (!prevPassedAll && currentPassedAll) {
    changes.push({ type: 'ci_passed', ref });
  }

  // --- Review decision changes ---
  if (prev.reviewDecision !== current.reviewDecision) {
    if (current.reviewDecision === 'changes_requested') {
      const reviewer = current.reviewers.find((r) => r.state === 'changes_requested');
      if (reviewer) {
        changes.push({ type: 'review_requested_changes', ref, reviewer: reviewer.login });
      }
    } else if (current.reviewDecision === 'approved' && prev.reviewDecision !== 'approved') {
      const reviewer = current.reviewers.find((r) => r.state === 'approved');
      if (reviewer) {
        changes.push({ type: 'review_approved', ref, reviewer: reviewer.login });
      }
    }
  }

  // --- New unresolved threads ---
  const prevThreadIds = new Set(prev.unresolvedThreads.map((t) => t.id));
  for (const thread of current.unresolvedThreads) {
    if (!prevThreadIds.has(thread.id)) {
      changes.push({
        type: 'new_unresolved_thread',
        ref,
        thread: { author: thread.author, body: thread.body, path: thread.path },
      });
    }
  }

  // --- New comments (by count increase) ---
  if (current.totalComments > prev.totalComments) {
    // We don't have the individual new comments, but we know there are new ones
    // The unresolved threads check above catches review comments;
    // this catches top-level PR comments
    const newCount = current.totalComments - prev.totalComments;
    changes.push({
      type: 'new_comment',
      ref,
      comment: {
        author: 'unknown',
        body: `${newCount} new comment${newCount > 1 ? 's' : ''} on PR`,
      },
    });
  }

  return changes;
}

/**
 * Diff two snapshots of GitHub issue state.
 * Currently only tracks comment count changes.
 */
export function diffIssueState(
  prev: GitHubIssueState | null,
  current: GitHubIssueState,
): GitHubStateChange[] {
  const changes: GitHubStateChange[] = [];

  if (!prev) return changes; // First fetch — no diff for issues

  if (current.commentCount > prev.commentCount) {
    const newCount = current.commentCount - prev.commentCount;
    changes.push({
      type: 'new_comment',
      ref: current.ref,
      comment: {
        author: 'unknown',
        body: `${newCount} new comment${newCount > 1 ? 's' : ''} on issue`,
      },
    });
  }

  return changes;
}

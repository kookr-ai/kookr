import type { GitHubStateChange } from './github-types.js';

export interface GitHubAlert {
  summary: string;
  severity: 'info' | 'warning' | 'critical';
}

/**
 * Convert a GitHub state change into a human-readable alert.
 * Returns null for change types that don't warrant an alert.
 */
export function formatGitHubAlert(change: GitHubStateChange, label: string): GitHubAlert | null {
  switch (change.type) {
    case 'new_unresolved_thread':
      return {
        summary: `PR ${label}: new review comment from @${change.thread.author}`,
        severity: 'warning',
      };
    case 'ci_failed':
      return {
        summary: `PR ${label}: CI check "${change.check.name}" failed`,
        severity: 'warning',
      };
    case 'review_requested_changes':
      return {
        summary: `PR ${label}: @${change.reviewer} requested changes`,
        severity: 'warning',
      };
    case 'ci_passed':
      return {
        summary: `PR ${label}: all CI checks passed`,
        severity: 'info',
      };
    case 'review_approved':
      return {
        summary: `PR ${label}: approved by @${change.reviewer}`,
        severity: 'info',
      };
    case 'pr_merged':
      return {
        summary: `PR ${label}: merged`,
        severity: 'info',
      };
    case 'pr_closed':
      return {
        summary: `PR ${label}: closed`,
        severity: 'info',
      };
    case 'pr_conflicting':
      return {
        summary: `PR ${label}: merge conflicts detected`,
        severity: 'warning',
      };
    case 'new_comment':
      return {
        summary: `PR ${label}: ${change.comment.body}`,
        severity: 'info',
      };
  }
}

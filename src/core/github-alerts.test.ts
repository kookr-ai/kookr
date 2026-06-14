import { describe, expect, it } from 'vitest';
import { formatGitHubAlert } from './github-alerts.js';
import type { GitHubReference, GitHubStateChange } from './github-types.js';

const ref: GitHubReference = {
  type: 'pr',
  owner: 'kookr-ai',
  repo: 'kookr',
  number: 974,
  url: 'https://github.com/kookr-ai/kookr/pull/974',
  detectedAt: new Date('2026-06-14T00:00:00.000Z'),
  detectedFrom: 'test-session',
  taskId: 'task-974',
};

const issueRef: GitHubReference = {
  ...ref,
  type: 'issue',
  number: 16,
  url: 'https://github.com/kookr-ai/kookr/issues/16',
};

function change(type: GitHubStateChange['type']): GitHubStateChange {
  switch (type) {
    case 'new_unresolved_thread':
      return {
        type,
        ref,
        thread: { author: 'reviewer', body: 'Please update this.' },
      };
    case 'ci_failed':
      return {
        type,
        ref,
        check: { name: 'test', conclusion: 'failure' },
      };
    case 'review_requested_changes':
      return {
        type,
        ref,
        reviewer: 'reviewer',
      };
    case 'review_approved':
      return {
        type,
        ref,
        reviewer: 'reviewer',
      };
    case 'new_comment':
      return {
        type,
        ref,
        comment: { author: 'reviewer', body: 'Looks ready.' },
      };
    case 'ci_passed':
    case 'pr_merged':
    case 'pr_closed':
      return {
        type,
        ref,
      };
  }
}

describe('formatGitHubAlert', () => {
  it.each([
    ['new_unresolved_thread', 'new review comment from @reviewer'],
    ['ci_failed', 'CI check "test" failed'],
    ['review_requested_changes', '@reviewer requested changes'],
  ] as const)('formats %s as a warning alert', (type, summaryText) => {
    expect(formatGitHubAlert(change(type), '#974')).toEqual({
      summary: `PR #974: ${summaryText}`,
      severity: 'warning',
    });
  });

  it.each([
    ['ci_passed', 'all CI checks passed'],
    ['review_approved', 'approved by @reviewer'],
    ['pr_merged', 'merged'],
    ['pr_closed', 'closed'],
    ['new_comment', 'Looks ready.'],
  ] as const)('formats %s as an info alert', (type, summaryText) => {
    expect(formatGitHubAlert(change(type), '#974')).toEqual({
      summary: `PR #974: ${summaryText}`,
      severity: 'info',
    });
  });

  it('wires the supplied label and source fields into the summary', () => {
    const lintFailure = {
      type: 'ci_failed',
      ref,
      check: { name: 'lint', conclusion: 'failure' },
    } satisfies GitHubStateChange;

    expect(
      formatGitHubAlert(lintFailure, 'kookr-ai/kookr#974'),
    ).toEqual({
      summary: 'PR kookr-ai/kookr#974: CI check "lint" failed',
      severity: 'warning',
    });
  });

  it.fails('formats pr_conflicting as a warning alert per F7.4', () => {
    expect(
      formatGitHubAlert(
        { type: 'pr_conflicting', ref } as unknown as GitHubStateChange,
        '#974',
      ),
    ).toEqual({
      summary: 'PR #974: has merge conflicts',
      severity: 'warning',
    });
  });

  it.fails('formats issue new_comment alerts with an issue label', () => {
    const issueComment = {
      type: 'new_comment',
      ref: issueRef,
      comment: { author: 'unknown', body: '2 new comments on issue' },
    } satisfies GitHubStateChange;

    expect(formatGitHubAlert(issueComment, 'kookr-ai/kookr#16')).toEqual({
      summary: 'Issue kookr-ai/kookr#16: 2 new comments on issue',
      severity: 'info',
    });
  });

  it.fails('returns null for unknown non-actionable change types', () => {
    expect(
      formatGitHubAlert(
        { type: 'ignored_change', ref } as unknown as GitHubStateChange,
        '#974',
      ),
    ).toBeNull();
  });
});

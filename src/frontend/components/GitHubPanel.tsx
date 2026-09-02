import React from 'react';
import type { GitHubPRState, GitHubIssueState, GitHubReviewThread, GitHubCheck } from '../../shared/protocol.js';

interface Props {
  prs: GitHubPRState[];
  issues: GitHubIssueState[];
}

function PRStatusBadge({ status }: { status: GitHubPRState['status'] }) {
  const classes: Record<string, string> = {
    open: 'gh-badge gh-badge-open',
    closed: 'gh-badge gh-badge-closed',
    merged: 'gh-badge gh-badge-merged',
    draft: 'gh-badge gh-badge-draft',
  };
  return <span className={classes[status] ?? 'gh-badge'}>{status.toUpperCase()}</span>;
}

function CheckIcon({ check }: { check: GitHubCheck }) {
  if (check.status !== 'completed') return <span className="gh-check gh-check-pending">-</span>;
  if (check.conclusion === 'success') return <span className="gh-check gh-check-pass">+</span>;
  if (check.conclusion === 'failure') return <span className="gh-check gh-check-fail">x</span>;
  return <span className="gh-check gh-check-neutral">~</span>;
}

function ReviewThread({ thread }: { thread: GitHubReviewThread }) {
  return (
    <div className="gh-thread">
      <div className="gh-thread-header">
        <span className="gh-thread-author">@{thread.author}</span>
        {thread.path && <span className="gh-thread-path">{thread.path}{thread.line ? `:${thread.line}` : ''}</span>}
      </div>
      <div className="gh-thread-body">{thread.body.slice(0, 300)}{thread.body.length > 300 ? '...' : ''}</div>
    </div>
  );
}

function PRCard({ pr }: { pr: GitHubPRState }) {
  const unresolvedCount = pr.unresolvedThreads.length;
  const failedChecks = pr.checks.filter((c) => c.conclusion === 'failure');
  const allChecksPass = pr.checks.length > 0 && pr.checks.every((c) => c.conclusion === 'success');

  return (
    <div className="gh-pr-card">
      <div className="gh-pr-header">
        <a href={pr.ref.url} target="_blank" rel="noopener noreferrer" className="gh-pr-title">
          #{pr.ref.number} {pr.title}
        </a>
        <PRStatusBadge status={pr.status} />
        {pr.mergeable === 'CONFLICTING' && (
          <span
            className="gh-badge gh-badge-conflict"
            data-testid="gh-pr-conflict-badge"
            title="This PR has merge conflicts and cannot be merged until they are resolved"
          >
            Conflict
          </span>
        )}
      </div>

      <div className="gh-pr-meta">
        <span>{pr.branch} → {pr.baseBranch}</span>
        <span>by @{pr.author}</span>
      </div>

      {/* Review decision */}
      {pr.reviewDecision && (
        <div className={`gh-review-decision gh-review-${pr.reviewDecision}`}>
          {pr.reviewDecision === 'approved' && 'Approved'}
          {pr.reviewDecision === 'changes_requested' && 'Changes requested'}
          {pr.reviewDecision === 'review_required' && 'Review required'}
          {pr.reviewers.length > 0 && (
            <span className="gh-reviewers">
              {pr.reviewers.map((r) => `@${r.login} (${r.state})`).join(', ')}
            </span>
          )}
        </div>
      )}

      {/* CI Checks */}
      {pr.checks.length > 0 && (
        <div className="gh-checks">
          <div className="gh-checks-summary">
            {allChecksPass && <span className="gh-check-pass">All checks pass</span>}
            {failedChecks.length > 0 && <span className="gh-check-fail">{failedChecks.length} check{failedChecks.length > 1 ? 's' : ''} failed</span>}
          </div>
          {failedChecks.map((check) => (
            <div key={check.name} className="gh-check-item gh-check-fail">
              <CheckIcon check={check} /> {check.name}
            </div>
          ))}
        </div>
      )}

      {/* Unresolved threads */}
      {unresolvedCount > 0 && (
        <div className="gh-threads">
          <div className="gh-threads-header">
            {unresolvedCount} unresolved comment{unresolvedCount > 1 ? 's' : ''}
          </div>
          {pr.unresolvedThreads.map((thread) => (
            <ReviewThread key={thread.id} thread={thread} />
          ))}
        </div>
      )}
    </div>
  );
}

export function GitHubPanel({ prs, issues }: Props) {
  if (prs.length === 0 && issues.length === 0) {
    return (
      <div className="gh-panel gh-empty">
        <p>No GitHub references detected yet.</p>
        <p className="gh-hint">When the agent creates PRs or references issues, they will appear here.</p>
      </div>
    );
  }

  return (
    <div className="gh-panel">
      {prs.map((pr) => (
        <PRCard key={`${pr.ref.owner}/${pr.ref.repo}#${pr.ref.number}`} pr={pr} />
      ))}
      {issues.length > 0 && (
        <div className="gh-issues-section">
          <div className="gh-section-header">Issues</div>
          {issues.map((issue) => (
            <div key={`${issue.ref.owner}/${issue.ref.repo}#${issue.ref.number}`} className="gh-issue-card">
              <div className="gh-issue-header">
                <a href={issue.ref.url} target="_blank" rel="noopener noreferrer" className="gh-issue-title">
                  #{issue.ref.number} {issue.title}
                </a>
                <span className={`gh-badge gh-badge-${issue.status}`}>{issue.status.toUpperCase()}</span>
              </div>
              <div className="gh-issue-meta">
                {issue.labels.length > 0 && (
                  <span className="gh-issue-labels">
                    {issue.labels.map((label) => (
                      <span key={label} className="gh-label">{label}</span>
                    ))}
                  </span>
                )}
                {issue.commentCount > 0 && <span className="gh-comment-count">{issue.commentCount} comments</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

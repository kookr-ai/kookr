/**
 * Tests for the pure derived-data helpers exported from OssProductivityView.tsx.
 *
 * These cover the T-F1..T-F6 shape-of-render assertions from
 * rfc-oss-zombie-pr-detection §11.4 without requiring @testing-library/react —
 * the project doesn't install it, and the only rendering logic that actually
 * needs testing is "how do we derive the stale count, the stale column, and
 * the feed badge info from the store". The tsx file then trivially maps those
 * values to DOM nodes; `pnpm check:e2e` verifies the JSX types separately.
 */

import { describe, it, expect } from 'vitest';
import {
  computeRepoRows,
  computeLifecycleFeed,
  type RepoRow,
  type FeedItem,
} from './OssProductivityView.js';
import type {
  ContributionAttempt,
  LinkedIssueState,
  StateObservation,
} from '../../core/oss-attempt-store.js';

function mkObs(state: ContributionAttempt['state'], at: string): StateObservation {
  return { state, at, source: 'refresh_poll', note: null, url: null };
}

function mkPr(
  opts: Partial<ContributionAttempt> & { prNumber: number; repo: string; state: ContributionAttempt['state'] },
): ContributionAttempt {
  const at = opts.createdAt ?? '2026-04-10T00:00:00Z';
  return {
    id: `${opts.repo}#${opts.prNumber}`,
    repo: opts.repo,
    issueNumber: null,
    issueUrl: null,
    prNumber: opts.prNumber,
    prUrl: `https://github.com/${opts.repo}/pull/${opts.prNumber}`,
    prTitle: `PR ${opts.prNumber}`,
    state: opts.state,
    history: opts.history ?? [mkObs(opts.state, at)],
    closing: null,
    linkedIssue: opts.linkedIssue,
    createdAt: at,
    updatedAt: at,
  };
}

const closedByDifferentPR: LinkedIssueState = {
  number: 42,
  state: 'closed',
  closedAt: '2026-04-12T00:00:00Z',
  closingPrNumber: 99,
  verifiedAt: '2026-04-12T01:00:00Z',
};

const openLinked: LinkedIssueState = {
  number: 42,
  state: 'open',
  closedAt: null,
  closingPrNumber: null,
  verifiedAt: '2026-04-12T01:00:00Z',
};

describe('computeRepoRows — stale column math (T-F1, T-F2)', () => {
  it('T-F1: a repo with one zombie shows stale=1 and open=rest', () => {
    const attempts = [
      mkPr({ repo: 'grafana/grafana', prNumber: 1, state: 'pr_open', linkedIssue: closedByDifferentPR }),
      mkPr({ repo: 'grafana/grafana', prNumber: 2, state: 'pr_open', linkedIssue: openLinked }),
      mkPr({ repo: 'grafana/grafana', prNumber: 3, state: 'pr_open' }),
    ];
    const rows = computeRepoRows(attempts, []);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.repo).toBe('grafana/grafana');
    expect(row.opened).toBe(3);
    expect(row.stale).toBe(1);
    expect(row.open).toBe(2);
  });

  it('T-F2: stale is a SUBSET of open — open + stale === all pr_open', () => {
    const attempts = [
      mkPr({ repo: 'grafana/grafana', prNumber: 1, state: 'pr_open', linkedIssue: closedByDifferentPR }),
      mkPr({ repo: 'grafana/grafana', prNumber: 2, state: 'pr_open', linkedIssue: closedByDifferentPR }),
      mkPr({ repo: 'grafana/grafana', prNumber: 3, state: 'pr_open' }),
      mkPr({ repo: 'grafana/grafana', prNumber: 4, state: 'merged' }),
    ];
    const row = computeRepoRows(attempts, [])[0];
    expect(row.stale).toBe(2);
    expect(row.open).toBe(1); // 3 pr_open - 2 stale = 1 healthy
    expect(row.merged).toBe(1);
  });

  it('repo with zero stale has stale=0 and open equals all pr_open', () => {
    const attempts = [
      mkPr({ repo: 'grafana/grafana', prNumber: 1, state: 'pr_open' }),
      mkPr({ repo: 'grafana/grafana', prNumber: 2, state: 'pr_open', linkedIssue: openLinked }),
    ];
    const row = computeRepoRows(attempts, [])[0];
    expect(row.stale).toBe(0);
    expect(row.open).toBe(2);
  });

  it('terminal records are never stale even with closed linked issue', () => {
    const attempts = [
      mkPr({ repo: 'grafana/grafana', prNumber: 1, state: 'merged', linkedIssue: closedByDifferentPR }),
      mkPr({ repo: 'grafana/grafana', prNumber: 2, state: 'closed', linkedIssue: closedByDifferentPR }),
    ];
    const row = computeRepoRows(attempts, [])[0];
    expect(row.stale).toBe(0);
    expect(row.merged).toBe(1);
    expect(row.closed).toBe(1);
  });
});

describe('computeLifecycleFeed — stale badge info (T-F3, T-F4, T-F5)', () => {
  // T-F3 flagship: feed item for the litellm #25520 scenario has stale info.
  it('T-F3: populates StaleInfo on feed item when PR is a zombie', () => {
    const attempt = mkPr({
      repo: 'BerriAI/litellm',
      prNumber: 25520,
      state: 'pr_open',
      linkedIssue: {
        number: 25132,
        state: 'closed',
        closedAt: '2026-04-13T03:42:00Z',
        closingPrNumber: 25263,
        verifiedAt: '2026-04-13T10:00:00Z',
      },
    });
    const feed = computeLifecycleFeed([attempt]);
    expect(feed).toHaveLength(1);
    expect(feed[0].stale).not.toBeNull();
    expect(feed[0].stale?.issueNumber).toBe(25132);
    expect(feed[0].stale?.closingPrNumber).toBe(25263);
    expect(feed[0].stale?.closedAt).toBe('2026-04-13T03:42:00Z');
    expect(feed[0].stale?.closingPrUrl).toBe(
      'https://github.com/BerriAI/litellm/pull/25263',
    );
  });

  // T-F4: tooltip signal uses verifiedAt from linkedIssue (not updatedAt).
  it('T-F4: stale info exposes verifiedAt for the tooltip', () => {
    const attempt = mkPr({
      repo: 'grafana/grafana',
      prNumber: 1,
      state: 'pr_open',
      linkedIssue: closedByDifferentPR,
    });
    const feed = computeLifecycleFeed([attempt]);
    expect(feed[0].stale?.verifiedAt).toBe(closedByDifferentPR.verifiedAt);
    // Verify it's DISTINCT from the parent record's updatedAt (which could
    // otherwise masquerade as the same signal).
    expect(feed[0].stale?.verifiedAt).not.toBe(attempt.updatedAt);
  });

  // T-F5: non-stale items have stale: null.
  it('T-F5: non-stale PRs have stale: null', () => {
    const attempts = [
      mkPr({ repo: 'grafana/grafana', prNumber: 1, state: 'pr_open' }), // no linkedIssue
      mkPr({ repo: 'grafana/grafana', prNumber: 2, state: 'merged' }), // terminal
      mkPr({
        repo: 'grafana/grafana',
        prNumber: 3,
        state: 'pr_open',
        linkedIssue: openLinked,
      }),
    ];
    const feed = computeLifecycleFeed(attempts);
    expect(feed).toHaveLength(3);
    for (const item of feed) {
      expect(item.stale).toBeNull();
    }
  });

  it('stale info handles null closingPrNumber (manual close)', () => {
    // Covers E5 / edge case — the linkedIssue is closed but closingPrNumber
    // is null (manual/commit-based close). Still a zombie per isStale.
    const attempt = mkPr({
      repo: 'grafana/grafana',
      prNumber: 1,
      state: 'pr_open',
      linkedIssue: {
        number: 42,
        state: 'closed',
        closedAt: '2026-04-12T00:00:00Z',
        closingPrNumber: null,
        verifiedAt: '2026-04-12T01:00:00Z',
      },
    });
    const feed = computeLifecycleFeed([attempt]);
    expect(feed[0].stale).not.toBeNull();
    expect(feed[0].stale?.closingPrNumber).toBeNull();
    expect(feed[0].stale?.closingPrUrl).toBeNull();
  });

  // T-F6: the slice exposes ossLastRefreshIssueCheckErrors — tested at the
  // slice level (oss-attempts-slice) rather than the component rendering path.
});

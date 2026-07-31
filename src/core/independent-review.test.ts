import { describe, test, expect } from 'vitest';
import {
  INDEPENDENT_REVIEW_MARKER,
  REVIEW_SKIPPED_TIMEOUT_LABEL,
  parseVerdictComment,
  latestVerdict,
  evaluateMergeReviewGate,
  computeReviewCoverage,
} from './independent-review.js';

function verdictComment(opts: {
  verdict: 'pass' | 'block';
  headSha?: string;
  lane?: string;
  extra?: string;
}): string {
  const lines = [INDEPENDENT_REVIEW_MARKER, `kookr-review-verdict: ${opts.verdict}`];
  if (opts.lane) lines.push(`review-lane: ${opts.lane}`);
  if (opts.headSha) lines.push(`review-head-sha: ${opts.headSha}`);
  if (opts.extra) lines.push('', opts.extra);
  return lines.join('\n');
}

describe('parseVerdictComment', () => {
  test('returns null for non-verdict comments', () => {
    expect(parseVerdictComment('just a normal comment')).toBeNull();
    // Marker present but no verdict line is not a valid verdict.
    expect(parseVerdictComment(`${INDEPENDENT_REVIEW_MARKER}\nno verdict here`)).toBeNull();
  });

  test('parses verdict, lane, and head sha', () => {
    const parsed = parseVerdictComment(
      verdictComment({ verdict: 'block', lane: 'codex', headSha: 'ABC123', extra: 'finding: off-by-one' }),
    );
    expect(parsed).toEqual({ verdict: 'block', lane: 'codex', headSha: 'abc123' });
  });

  test('is case-insensitive on the verdict value', () => {
    const parsed = parseVerdictComment(`${INDEPENDENT_REVIEW_MARKER}\nkookr-review-verdict: PASS`);
    expect(parsed?.verdict).toBe('pass');
  });
});

describe('latestVerdict', () => {
  test('last verdict wins by createdAt', () => {
    const comments = [
      { body: verdictComment({ verdict: 'block' }), createdAt: '2026-07-31T10:00:00Z' },
      { body: 'unrelated', createdAt: '2026-07-31T10:05:00Z' },
      { body: verdictComment({ verdict: 'pass' }), createdAt: '2026-07-31T10:10:00Z' },
    ];
    expect(latestVerdict(comments)?.verdict).toBe('pass');
  });

  test('falls back to array order when timestamps are absent', () => {
    const comments = [
      { body: verdictComment({ verdict: 'pass' }) },
      { body: verdictComment({ verdict: 'block' }) },
    ];
    expect(latestVerdict(comments)?.verdict).toBe('block');
  });
});

describe('evaluateMergeReviewGate', () => {
  const head = 'deadbeef';

  test('disabled gate always allows', () => {
    const result = evaluateMergeReviewGate({ comments: [], labels: [], requireReview: false });
    expect(result).toMatchObject({ allowed: true, code: 'disabled' });
  });

  test('blocks when there is no verdict and no timeout label', () => {
    const result = evaluateMergeReviewGate({ comments: [], labels: [], headSha: head });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('no-verdict');
  });

  test('allows a pass verdict bound to the current head', () => {
    const result = evaluateMergeReviewGate({
      comments: [{ body: verdictComment({ verdict: 'pass', headSha: head }) }],
      labels: [],
      headSha: head,
    });
    expect(result).toMatchObject({ allowed: true, code: 'pass' });
  });

  test('blocks a block verdict even when the timeout label is present', () => {
    const result = evaluateMergeReviewGate({
      comments: [{ body: verdictComment({ verdict: 'block', headSha: head }) }],
      labels: [REVIEW_SKIPPED_TIMEOUT_LABEL],
      headSha: head,
    });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('blocked-finding');
  });

  test('a seeded bug is unblocked only after a fresh pass on the fixed commit', () => {
    // Reviewer blocked the buggy commit...
    const blocked = evaluateMergeReviewGate({
      comments: [{ body: verdictComment({ verdict: 'block', headSha: 'oldsha' }) }],
      labels: [],
      headSha: 'newsha',
    });
    expect(blocked.allowed).toBe(false);

    // ...implementer fixes and the reviewer re-runs, posting a pass for newsha.
    const fixed = evaluateMergeReviewGate({
      comments: [
        { body: verdictComment({ verdict: 'block', headSha: 'oldsha' }), createdAt: '2026-07-31T10:00:00Z' },
        { body: verdictComment({ verdict: 'pass', headSha: 'newsha' }), createdAt: '2026-07-31T10:20:00Z' },
      ],
      labels: [],
      headSha: 'newsha',
    });
    expect(fixed).toMatchObject({ allowed: true, code: 'pass' });
  });

  test('a stale pass (old commit) is refused without the timeout label', () => {
    const result = evaluateMergeReviewGate({
      comments: [{ body: verdictComment({ verdict: 'pass', headSha: 'oldsha' }) }],
      labels: [],
      headSha: 'newsha',
    });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('stale-verdict');
  });

  test('timeout label authorizes a merge when no verdict arrived', () => {
    const result = evaluateMergeReviewGate({
      comments: [],
      labels: [REVIEW_SKIPPED_TIMEOUT_LABEL],
      headSha: head,
    });
    expect(result).toMatchObject({ allowed: true, code: 'timeout-label' });
  });

  test('a stale pass rescued by the timeout label is allowed', () => {
    const result = evaluateMergeReviewGate({
      comments: [{ body: verdictComment({ verdict: 'pass', headSha: 'oldsha' }) }],
      labels: [REVIEW_SKIPPED_TIMEOUT_LABEL],
      headSha: 'newsha',
    });
    expect(result).toMatchObject({ allowed: true, code: 'timeout-label' });
  });

  test('a pass without a head-sha binding is accepted (lenient mode)', () => {
    const result = evaluateMergeReviewGate({
      comments: [{ body: verdictComment({ verdict: 'pass' }) }],
      labels: [],
      headSha: head,
    });
    expect(result).toMatchObject({ allowed: true, code: 'pass' });
  });
});

describe('computeReviewCoverage', () => {
  test('classifies merged PRs and computes reviewed-before-merge %', () => {
    const summary = computeReviewCoverage([
      { number: 1, comments: [{ body: verdictComment({ verdict: 'pass', lane: 'codex' }) }], labels: [] },
      { number: 2, comments: [{ body: verdictComment({ verdict: 'pass', lane: 'claude' }) }], labels: [] },
      { number: 3, comments: [], labels: [REVIEW_SKIPPED_TIMEOUT_LABEL] },
      { number: 4, comments: [], labels: [] },
    ]);
    expect(summary.total).toBe(4);
    expect(summary.reviewed).toBe(2);
    expect(summary.timedOut).toBe(1);
    expect(summary.unreviewed).toBe(1);
    expect(summary.coveragePct).toBe(50);
  });

  test('coverage is null when there are no merged PRs', () => {
    expect(computeReviewCoverage([]).coveragePct).toBeNull();
  });

  test('a block verdict still counts as reviewed and % is rounded to one decimal', () => {
    const summary = computeReviewCoverage([
      { number: 1, comments: [{ body: verdictComment({ verdict: 'block' }) }], labels: [] },
      { number: 2, comments: [], labels: [] },
      { number: 3, comments: [], labels: [] },
    ]);
    // A block verdict means "a mind looked" — it counts as reviewed.
    expect(summary.reviewed).toBe(1);
    expect(summary.rows[0]).toMatchObject({ outcome: 'reviewed', verdict: 'block' });
    // 1/3 → 33.3 (rounded to one decimal).
    expect(summary.coveragePct).toBe(33.3);
  });
});

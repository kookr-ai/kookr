import { describe, expect, test } from 'vitest';
import {
  decideRefinementHandoff,
  filterBurnedCandidates,
  isTrustedIssueAuthor,
  parseBatchSize,
  parseBooleanFlag,
  parseBurnedOutTargets,
  parseClosePolicy,
  parseIssueSelector,
  parseTotalLimit,
  remainingLimitBudget,
} from './issue-refinement.js';

describe('parseIssueSelector', () => {
  test('treats blank, whitespace, and comment-only input as all eligible open issues', () => {
    expect(parseIssueSelector('')).toEqual({ kind: 'blank' });
    expect(parseIssueSelector('  \n# comment\n  ')).toEqual({ kind: 'blank' });
  });

  test('parses an explicit number list, stripping hashes and preserving order', () => {
    expect(parseIssueSelector('50, #565 566\n#565')).toEqual({
      kind: 'list',
      numbers: [50, 565, 566],
    });
  });

  test('treats a non-numeric line as a GitHub filter', () => {
    expect(parseIssueSelector('label:idea-scout')).toEqual({
      kind: 'filter',
      query: 'label:idea-scout',
    });
  });

  test('rejects filters that override repo or state via reserved tokens', () => {
    expect(() => parseIssueSelector('repo: other/repo label:bug')).toThrow(/repo:/);
    expect(() => parseIssueSelector('state: closed')).toThrow(/state:/);
    expect(() => parseIssueSelector('is: issue')).toThrow(/is:/);
  });

  test('rejects a mixed list that is neither all numbers nor a clean filter', () => {
    expect(parseIssueSelector('50 label:bug')).toEqual({
      kind: 'filter',
      query: '50 label:bug',
    });
  });
});

describe('parseTotalLimit and parseBatchSize', () => {
  test('accepts all or a positive integer limit', () => {
    expect(parseTotalLimit('all')).toEqual({ kind: 'all' });
    expect(parseTotalLimit(' 3 ')).toEqual({ kind: 'count', n: 3 });
  });

  test('rejects malformed limits', () => {
    expect(() => parseTotalLimit('')).toThrow(/all.*positive integer/);
    expect(() => parseTotalLimit('0')).toThrow(/all.*positive integer/);
    expect(() => parseTotalLimit('-2')).toThrow(/all.*positive integer/);
    expect(() => parseTotalLimit('1.5')).toThrow(/all.*positive integer/);
  });

  test('accepts batchSize from 1 through the shared iteration cap', () => {
    expect(parseBatchSize('1')).toBe(1);
    expect(parseBatchSize('20')).toBe(20);
  });

  test('rejects batchSize outside 1-20', () => {
    expect(() => parseBatchSize('0')).toThrow(/1 through 20/);
    expect(() => parseBatchSize('21')).toThrow(/1 through 20/);
    expect(() => parseBatchSize('all')).toThrow(/1 through 20/);
  });
});

describe('policy flags', () => {
  test('parses exact boolean flags and close policy', () => {
    expect(parseBooleanFlag('true', 'selfContinuation')).toBe(true);
    expect(parseBooleanFlag('false', 'allowOtherAuthors')).toBe(false);
    expect(parseClosePolicy('never')).toBe('never');
    expect(parseClosePolicy('allow-evidenced')).toBe('allow-evidenced');
  });

  test('rejects unrecognized flags', () => {
    expect(() => parseBooleanFlag('yes', 'selfContinuation')).toThrow(/true or false/);
    expect(() => parseClosePolicy('always')).toThrow(/never or allow-evidenced/);
  });
});

describe('author trust', () => {
  test('defaults to the authenticated user only', () => {
    expect(isTrustedIssueAuthor('jean', 'jean', false)).toBe(true);
    expect(isTrustedIssueAuthor('stranger', 'jean', false)).toBe(false);
  });

  test('allows any author when the trust toggle is on', () => {
    expect(isTrustedIssueAuthor('stranger', 'jean', true)).toBe(true);
  });
});

describe('retry-cap burned targets', () => {
  test('treats (none) as an empty skip list', () => {
    expect(parseBurnedOutTargets('(none)')).toEqual([]);
    expect(filterBurnedCandidates([12, 13], '(none)')).toEqual([12, 13]);
  });

  test('filters engine-burned issue numbers out of the candidate set', () => {
    expect(filterBurnedCandidates([12, 13, 14], '#13, 14')).toEqual([12]);
  });
});

describe('decideRefinementHandoff', () => {
  const base = {
    launchMode: 'looped' as const,
    batchCompletedAfter: 1,
    batchSize: 3,
    totalProcessedAfter: 1,
    limit: { kind: 'all' } as const,
    remainingEligibleCount: 4,
    selfContinuation: true,
    hardBlocker: false,
  };

  test('keeps a looped task on the current batch before batchSize', () => {
    expect(decideRefinementHandoff(base)).toBe('continue-batch');
  });

  test('spawns one successor at the batch boundary when work and budget remain', () => {
    expect(decideRefinementHandoff({ ...base, batchCompletedAfter: 3, totalProcessedAfter: 3 })).toBe(
      'spawn-successor',
    );
  });

  test('a standard launch is a batch boundary after the single issue', () => {
    expect(decideRefinementHandoff({
      ...base,
      launchMode: 'standard',
      batchCompletedAfter: 1,
      batchSize: 5,
      totalProcessedAfter: 1,
    })).toBe('spawn-successor');
  });

  test('stops after exactly X completed dispositions across successor tasks', () => {
    expect(decideRefinementHandoff({
      ...base,
      batchCompletedAfter: 1,
      totalProcessedAfter: 2,
      limit: { kind: 'count', n: 2 },
      remainingEligibleCount: 9,
    })).toBe('stop-limit');
  });

  test('limit all stops only when the selector has no eligible issue', () => {
    expect(decideRefinementHandoff({
      ...base,
      batchCompletedAfter: 3,
      totalProcessedAfter: 30,
      remainingEligibleCount: 0,
    })).toBe('stop-exhausted');
  });

  test('does not spawn after a hard blocker', () => {
    expect(decideRefinementHandoff({
      ...base,
      batchCompletedAfter: 3,
      hardBlocker: true,
    })).toBe('stop-blocker');
  });

  test('stops at the batch boundary when self-continuation is off', () => {
    expect(decideRefinementHandoff({
      ...base,
      batchCompletedAfter: 3,
      selfContinuation: false,
    })).toBe('stop-no-continuation');
  });

  test('remaining budget is omitted for an unbounded limit', () => {
    expect(remainingLimitBudget({ kind: 'all' }, 12)).toBeUndefined();
    expect(remainingLimitBudget({ kind: 'count', n: 5 }, 3)).toBe(2);
    expect(remainingLimitBudget({ kind: 'count', n: 5 }, 5)).toBe(0);
  });
});

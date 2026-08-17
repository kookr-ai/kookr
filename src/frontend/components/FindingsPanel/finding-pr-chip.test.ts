import { describe, expect, test } from 'vitest';
import type { GitHubPRState } from '../../../shared/protocol.js';
import { findingPrChipLabel, selectFindingPrChip } from './finding-pr-chip.js';

function makePr(overrides: Partial<GitHubPRState> & { number?: number } = {}): GitHubPRState {
  const { number: explicitNumber, ref, ...rest } = overrides;
  const number = explicitNumber ?? ref?.number ?? 42;
  return {
    ref: {
      type: 'pr',
      owner: 'kookr-ai',
      repo: 'kookr',
      number,
      url: `https://github.com/kookr-ai/kookr/pull/${number}`,
      detectedAt: new Date('2026-08-17T10:00:00.000Z'),
      detectedFrom: 'test',
      taskId: 'task-1',
      ...ref,
      number,
    },
    title: 'Show PR status',
    status: 'open',
    mergeable: 'UNKNOWN',
    author: 'jeanibarz',
    branch: 'feat-issue-2601-finding-pr-chip',
    baseBranch: 'main',
    reviewDecision: null,
    reviewers: [],
    unresolvedThreads: [],
    totalComments: 0,
    checks: [],
    lastFetchedAt: new Date('2026-08-17T10:05:00.000Z'),
    ...rest,
  };
}

describe('selectFindingPrChip', () => {
  test('returns null when the task has no PRs', () => {
    expect(selectFindingPrChip([])).toBeNull();
  });

  test('surfaces the only PR number and status', () => {
    expect(selectFindingPrChip([makePr({ number: 88, status: 'draft' })])).toEqual({
      number: 88,
      status: 'draft',
      ciFailed: false,
      changesRequested: false,
    });
  });

  test('prefers a PR that failed CI over a quiet open PR in either order', () => {
    const quiet = makePr({ number: 10, status: 'open' });
    const laterQuiet = makePr({ number: 12, status: 'open' });
    const failed = makePr({
      number: 11,
      status: 'open',
      checks: [{ name: 'ci', status: 'completed', conclusion: 'failure' }],
    });
    expect(selectFindingPrChip([quiet, failed, laterQuiet])).toEqual({
      number: 11,
      status: 'open',
      ciFailed: true,
      changesRequested: false,
    });
    expect(selectFindingPrChip([failed, quiet, laterQuiet])?.number).toBe(11);
  });

  test('prefers an open PR over a merged one when neither needs attention', () => {
    expect(selectFindingPrChip([
      makePr({ number: 3, status: 'merged' }),
      makePr({ number: 9, status: 'open' }),
    ])?.status).toBe('open');
  });

  test('breaks quiet-PR ties by the lower number', () => {
    expect(selectFindingPrChip([
      makePr({ number: 20, status: 'open' }),
      makePr({ number: 7, status: 'open' }),
    ])?.number).toBe(7);
  });

  test('marks changes_requested on the selected PR', () => {
    const model = selectFindingPrChip([makePr({ reviewDecision: 'changes_requested' })]);
    expect(model?.changesRequested).toBe(true);
    expect(findingPrChipLabel(model!)).toBe('#42 · open · changes requested');
  });
});

import { describe, expect, test } from 'vitest';

import {
  derivePrDeliveryState,
  failingTestsFromVerifyLog,
  parseTrainEvents,
  revertFactsFromTrainEvents,
  type PrDeliveryFacts,
} from './pr-delivery-state.js';

const SHA = 'a'.repeat(40);

function facts(overrides: Partial<PrDeliveryFacts> & { pr?: Partial<PrDeliveryFacts['pr']> } = {}): PrDeliveryFacts {
  const { pr, ...rest } = overrides;
  return {
    pr: {
      status: 'merged',
      baseBranch: 'staging',
      openedAt: '2026-11-16T09:00:00.000Z',
      mergedAt: '2026-11-16T10:00:00.000Z',
      mergeCommit: SHA,
      ...pr,
    },
    integrationBranch: 'staging',
    integrationSince: '2026-11-01T00:00:00.000Z',
    onMain: false,
    revert: null,
    ...rest,
  };
}

describe('derivePrDeliveryState', () => {
  test('an open PR is "PR open", with the time it was opened', () => {
    expect(derivePrDeliveryState(facts({ pr: { status: 'open', mergedAt: undefined, mergeCommit: undefined } }))).toEqual({
      stage: 'pr-open',
      integrationBranch: 'staging',
      openedAt: '2026-11-16T09:00:00.000Z',
    });
  });

  test('a draft PR is "PR open" too', () => {
    expect(derivePrDeliveryState(facts({ pr: { status: 'draft' } }))?.stage).toBe('pr-open');
  });

  test('merged into staging and not on main is "in staging", since its merge', () => {
    expect(derivePrDeliveryState(facts({ onMain: false }))).toEqual({
      stage: 'in-staging',
      integrationBranch: 'staging',
      openedAt: '2026-11-16T09:00:00.000Z',
      mergedAt: '2026-11-16T10:00:00.000Z',
    });
  });

  test('merged into staging and contained in main is "on main", with the promotion time', () => {
    const state = derivePrDeliveryState(facts({ onMain: true, onMainAt: '2026-11-16T10:40:00.000Z' }));
    expect(state).toMatchObject({ stage: 'on-main', onMainAt: '2026-11-16T10:40:00.000Z', mergedAt: '2026-11-16T10:00:00.000Z' });
    expect(state?.skippedTrain).toBeUndefined();
  });

  test('a revert wins over main containing the commit (the revert reaches main with it)', () => {
    const state = derivePrDeliveryState(facts({
      onMain: true,
      revert: {
        revertCommit: 'b'.repeat(40),
        at: '2026-11-16T10:30:00.000Z',
        attempt: 2,
        maxAttempts: 3,
        fixTaskKey: 'train-fix-issue-3915-2',
        needsHuman: false,
        failingTests: ['src/a.test.ts > a > b'],
      },
    }));
    expect(state).toEqual({
      stage: 'reverted',
      integrationBranch: 'staging',
      openedAt: '2026-11-16T09:00:00.000Z',
      mergedAt: '2026-11-16T10:00:00.000Z',
      revertedAt: '2026-11-16T10:30:00.000Z',
      revert: {
        revertCommit: 'b'.repeat(40),
        attempt: 2,
        maxAttempts: 3,
        fixTaskKey: 'train-fix-issue-3915-2',
        needsHuman: false,
        failingTests: ['src/a.test.ts > a > b'],
      },
    });
  });

  test('a PR merged straight into main after the train was turned on is on main, flagged as having skipped the train', () => {
    const state = derivePrDeliveryState(facts({
      pr: { baseBranch: 'main', mergedAt: '2026-11-16T10:00:00.000Z' },
      onMain: null,
      onMainAt: '2026-11-16T10:00:00.000Z',
    }));
    expect(state).toMatchObject({ stage: 'on-main', skippedTrain: true, onMainAt: '2026-11-16T10:00:00.000Z' });
  });

  test('a PR merged into main before the train existed is on main, not flagged', () => {
    const state = derivePrDeliveryState(facts({ pr: { baseBranch: 'main', mergedAt: '2026-10-20T10:00:00.000Z' } }));
    expect(state?.stage).toBe('on-main');
    expect(state?.skippedTrain).toBeUndefined();
  });

  test('a merge into main is not flagged when the train start time is unknown', () => {
    const state = derivePrDeliveryState(facts({ pr: { baseBranch: 'main' }, integrationSince: undefined }));
    expect(state?.stage).toBe('on-main');
    expect(state?.skippedTrain).toBeUndefined();
  });

  test('says nothing when git cannot tell whether main has the commit', () => {
    expect(derivePrDeliveryState(facts({ onMain: null }))).toBeNull();
  });

  test('says nothing for a repository without an integration branch', () => {
    expect(derivePrDeliveryState(facts({ integrationBranch: null, onMain: true }))).toBeNull();
    expect(derivePrDeliveryState(facts({ integrationBranch: null, pr: { status: 'open' } }))).toBeNull();
  });

  test('says nothing for a closed PR or a PR into another branch', () => {
    expect(derivePrDeliveryState(facts({ pr: { status: 'closed' } }))).toBeNull();
    expect(derivePrDeliveryState(facts({ pr: { baseBranch: 'feature-x' }, onMain: true }))).toBeNull();
  });
});

describe('revertFactsFromTrainEvents', () => {
  const events = parseTrainEvents([
    JSON.stringify({ at: '2026-11-16T08:00:00.000Z', kind: 'reverted', detail: `reverted ${'c'.repeat(40)} as ${'d'.repeat(40)} on staging; fix task train-fix-issue-1-1 spawned (automatic re-land 1 of 3)` }),
    'not json',
    JSON.stringify({ at: '2026-11-16T10:30:00.000Z', kind: 'reverted', detail: `reverted ${SHA} as ${'b'.repeat(40)} on staging; fix task train-fix-issue-3915-2 spawned (automatic re-land 2 of 3)` }),
    JSON.stringify({ at: '2026-11-16T10:31:00.000Z', kind: 'halted', detail: `reverted ${SHA} decoy` }),
  ].join('\n'));

  test('reads the attempt and the fix task of the revert of this commit', () => {
    expect(revertFactsFromTrainEvents(events, SHA)).toEqual({
      at: '2026-11-16T10:30:00.000Z',
      fixTaskKey: 'train-fix-issue-3915-2',
      attempt: 2,
      maxAttempts: 3,
      needsHuman: false,
    });
  });

  test('a used-up budget or a failed spawn needs a human', () => {
    const exhausted = parseTrainEvents(JSON.stringify({ kind: 'reverted', detail: `reverted ${SHA} as x on staging; fix budget exhausted for issue-3915 (PR #3920)` }));
    expect(revertFactsFromTrainEvents(exhausted, SHA)).toEqual({ needsHuman: true });
    const failed = parseTrainEvents(JSON.stringify({ kind: 'reverted', detail: `reverted ${SHA} as x on staging; fix task train-fix-issue-3915-3 could not be spawned` }));
    expect(revertFactsFromTrainEvents(failed, SHA)).toEqual({ fixTaskKey: 'train-fix-issue-3915-3', needsHuman: true });
  });

  test('null when the log has no revert of this commit', () => {
    expect(revertFactsFromTrainEvents(events, 'e'.repeat(40))).toBeNull();
  });
});

describe('failingTestsFromVerifyLog', () => {
  test('reads vitest FAIL lines behind the lane prefix and project tag, deduplicated', () => {
    const log = [
      '[unit_lane]      × persists wrapped ring buffer 30282ms (retry x2)',
      '[unit_lane]  FAIL  |serial| src/adapters/local-dtach-backend.test.ts > LocalDtachBackend > persists wrapped ring buffer',
      '[unit_lane]  FAIL  |serial| src/adapters/local-dtach-backend.test.ts > LocalDtachBackend > persists wrapped ring buffer',
      '\u001b[31m FAIL \u001b[39m src/core/x.test.ts > x > y',
      '[unit_lane] [reap-warning] grace elapsed — reaping',
    ].join('\n');
    expect(failingTestsFromVerifyLog(log)).toEqual([
      'src/adapters/local-dtach-backend.test.ts > LocalDtachBackend > persists wrapped ring buffer',
      'src/core/x.test.ts > x > y',
    ]);
  });

  test('keeps at most five', () => {
    const log = Array.from({ length: 8 }, (_, i) => ` FAIL  src/t${i}.test.ts > t`).join('\n');
    expect(failingTestsFromVerifyLog(log)).toHaveLength(5);
  });
});

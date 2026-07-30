import { describe, expect, it } from 'vitest';
import {
  CI_BLIND_DEBT_SCHEMA,
  computeCiBlindDebt,
  formatCiBlindDebtLogLine,
} from './ci-blind-debt.js';
import { buildRetroVerifyEntry } from './retro-verify-queue.js';

function entry(
  partial: {
    sha: string;
    prNumber?: number;
    repo?: string;
    reason?: string;
    createdAt: string;
    verifyFailed?: boolean;
  },
) {
  return buildRetroVerifyEntry({
    sha: partial.sha,
    prNumber: partial.prNumber ?? 1,
    repo: partial.repo ?? 'jeanibarz/lucy',
    reason: partial.reason ?? 'verified-locally',
    createdAt: partial.createdAt,
    ...(partial.verifyFailed ? { verifyFailed: true } : {}),
  });
}

describe('computeCiBlindDebt (issue #1703)', () => {
  it('returns a zero-debt snapshot for an empty queue', () => {
    const now = new Date('2026-07-30T12:00:00.000Z');
    const debt = computeCiBlindDebt([], { now });
    expect(debt).toEqual({
      schemaVersion: CI_BLIND_DEBT_SCHEMA,
      blindMergeCount: 0,
      queueDepth: 0,
      verifyFailedCount: 0,
      byRepo: {},
      sample: [],
      generatedAt: now.toISOString(),
    });
  });

  it('counts blind merges, queue depth, verify-failed, and per-repo breakdown', () => {
    const now = new Date('2026-07-30T12:00:00.000Z');
    const entries = [
      entry({
        sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        createdAt: '2026-07-28T00:00:00.000Z',
        repo: 'jeanibarz/lucy',
      }),
      entry({
        sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        createdAt: '2026-07-29T00:00:00.000Z',
        repo: 'jeanibarz/lucy',
        verifyFailed: true,
      }),
      entry({
        sha: 'cccccccccccccccccccccccccccccccccccccccc',
        createdAt: '2026-07-29T12:00:00.000Z',
        repo: 'kookr-ai/kookr',
        reason: 'ci-signal-absent',
      }),
    ];
    const debt = computeCiBlindDebt(entries, { now, sampleSize: 2 });
    expect(debt.blindMergeCount).toBe(3);
    expect(debt.queueDepth).toBe(3);
    expect(debt.verifyFailedCount).toBe(1);
    expect(debt.byRepo).toEqual({
      'jeanibarz/lucy': 2,
      'kookr-ai/kookr': 1,
    });
    // oldest first in sample
    expect(debt.sample).toHaveLength(2);
    expect(debt.sample[0]!.sha).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(debt.sample[1]!.verifyFailed).toBe(true);
    expect(debt.oldestCreatedAt).toBe('2026-07-28T00:00:00.000Z');
    // 2.5 days in ms
    expect(debt.oldestAgeMs).toBe(2.5 * 24 * 60 * 60 * 1000);
  });

  it('formats a stable daily-report log line including zero-debt days', () => {
    const empty = computeCiBlindDebt([], { now: new Date('2026-07-30T00:00:00.000Z') });
    expect(formatCiBlindDebtLogLine(empty)).toBe(
      'ci_blind_debt: blindMergeCount=0 queueDepth=0 verifyFailedCount=0 repos=0',
    );

    const debt = computeCiBlindDebt(
      [
        entry({
          sha: 'dddddddddddddddddddddddddddddddddddddddd',
          createdAt: '2026-07-29T00:00:00.000Z',
        }),
      ],
      { now: new Date('2026-07-30T00:00:00.000Z') },
    );
    expect(formatCiBlindDebtLogLine(debt)).toMatch(
      /ci_blind_debt: blindMergeCount=1 queueDepth=1 verifyFailedCount=0 repos=1 oldestAgeMs=86400000/,
    );
  });
});

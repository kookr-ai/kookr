import { describe, test, expect } from 'vitest';
import {
  summarizeCheckState,
  parsePrList,
  decidePrAction,
  planBehindPrSweep,
  runBehindPrSweep,
  renderSweepAuditLog,
  type RawPrListEntry,
  type SweepPrState,
  type SweepExecutor,
  type SweepExecResult,
} from './behind-pr-sweep.js';

function pr(overrides: Partial<SweepPrState> = {}): SweepPrState {
  return {
    number: 1,
    title: 'test PR',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    checks: 'passing',
    ...overrides,
  };
}

/** Records every executor call; merge/update succeed unless configured otherwise. */
class FakeExecutor implements SweepExecutor {
  updateCalls: number[] = [];
  mergeCalls: number[] = [];
  refetchCalls: number[] = [];
  updateResult: SweepExecResult = { ok: true };
  mergeResult: SweepExecResult = { ok: true };
  refetchState: (n: number) => SweepPrState | null = () => null;

  async updateBranch(n: number): Promise<SweepExecResult> {
    this.updateCalls.push(n);
    return this.updateResult;
  }
  async merge(n: number): Promise<SweepExecResult> {
    this.mergeCalls.push(n);
    return this.mergeResult;
  }
  async refetch(n: number): Promise<SweepPrState | null> {
    this.refetchCalls.push(n);
    return this.refetchState(n);
  }
}

describe('summarizeCheckState', () => {
  test('empty/absent rollup is none', () => {
    expect(summarizeCheckState(undefined)).toBe('none');
    expect(summarizeCheckState(null)).toBe('none');
    expect(summarizeCheckState([])).toBe('none');
  });

  test('all successful check runs are passing', () => {
    expect(
      summarizeCheckState([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
      ]),
    ).toBe('passing');
  });

  test('any failure dominates', () => {
    expect(
      summarizeCheckState([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'COMPLETED', conclusion: 'FAILURE' },
      ]),
    ).toBe('failing');
  });

  test('incomplete run is pending', () => {
    expect(
      summarizeCheckState([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'IN_PROGRESS', conclusion: null },
      ]),
    ).toBe('pending');
  });

  test('neutral/skipped are ignored, not failing', () => {
    expect(
      summarizeCheckState([
        { status: 'COMPLETED', conclusion: 'SKIPPED' },
        { status: 'COMPLETED', conclusion: 'NEUTRAL' },
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
      ]),
    ).toBe('passing');
  });

  test('legacy status contexts use state', () => {
    expect(summarizeCheckState([{ state: 'SUCCESS' }])).toBe('passing');
    expect(summarizeCheckState([{ state: 'FAILURE' }])).toBe('failing');
    expect(summarizeCheckState([{ state: 'PENDING' }])).toBe('pending');
  });
});

describe('parsePrList', () => {
  test('normalizes raw gh output and unknown enums', () => {
    const raw: RawPrListEntry[] = [
      {
        number: 1515,
        title: 'Implements #1465',
        isDraft: false,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BEHIND',
        statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
      },
      {
        number: 2,
        mergeable: 'weird',
        mergeStateStatus: 'also-weird',
        statusCheckRollup: null,
      },
    ];
    const parsed = parsePrList(raw);
    expect(parsed[0]).toEqual({
      number: 1515,
      title: 'Implements #1465',
      isDraft: false,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BEHIND',
      checks: 'passing',
    });
    expect(parsed[1]).toEqual({
      number: 2,
      title: '',
      isDraft: false,
      mergeable: 'UNKNOWN',
      mergeStateStatus: 'UNKNOWN',
      checks: 'none',
    });
  });
});

describe('decidePrAction — actionable', () => {
  test('MERGEABLE + BEHIND + passing => update-branch', () => {
    const d = decidePrAction(pr({ mergeStateStatus: 'BEHIND' }));
    expect(d.action).toBe('update-branch');
  });

  test('MERGEABLE + CLEAN + passing => merge', () => {
    const d = decidePrAction(pr({ mergeStateStatus: 'CLEAN' }));
    expect(d.action).toBe('merge');
  });
});

describe('decidePrAction — exclusions (never touched)', () => {
  test('draft is skipped', () => {
    expect(decidePrAction(pr({ isDraft: true, mergeStateStatus: 'BEHIND' })).action).toBe('skip');
    expect(decidePrAction(pr({ mergeStateStatus: 'DRAFT' })).action).toBe('skip');
  });

  test('CONFLICTING / DIRTY is skipped', () => {
    expect(decidePrAction(pr({ mergeable: 'CONFLICTING', mergeStateStatus: 'BEHIND' })).reason).toMatch(/conflicting/);
    expect(decidePrAction(pr({ mergeStateStatus: 'DIRTY' })).reason).toMatch(/conflicting/);
  });

  test('failing checks skipped even when BEHIND', () => {
    const d = decidePrAction(pr({ mergeStateStatus: 'BEHIND', checks: 'failing' }));
    expect(d.action).toBe('skip');
    expect(d.reason).toMatch(/failing/);
  });

  test('pending checks skipped', () => {
    expect(decidePrAction(pr({ mergeStateStatus: 'CLEAN', checks: 'pending' })).action).toBe('skip');
  });

  test('no checks reported skipped', () => {
    expect(decidePrAction(pr({ mergeStateStatus: 'CLEAN', checks: 'none' })).action).toBe('skip');
  });

  test('unknown mergeability skipped', () => {
    expect(decidePrAction(pr({ mergeable: 'UNKNOWN', mergeStateStatus: 'BEHIND' })).action).toBe('skip');
  });

  test('BLOCKED (review required) skipped despite green', () => {
    const d = decidePrAction(pr({ mergeStateStatus: 'BLOCKED' }));
    expect(d.action).toBe('skip');
    expect(d.reason).toMatch(/blocked/);
  });
});

describe('planBehindPrSweep', () => {
  test('preserves input order, one entry per PR', () => {
    const plan = planBehindPrSweep([
      pr({ number: 1, mergeStateStatus: 'BEHIND' }),
      pr({ number: 2, isDraft: true }),
      pr({ number: 3, mergeStateStatus: 'CLEAN' }),
    ]);
    expect(plan.map((p) => [p.number, p.action])).toEqual([
      [1, 'update-branch'],
      [2, 'skip'],
      [3, 'merge'],
    ]);
  });
});

describe('runBehindPrSweep', () => {
  test('AC: a green CLEAN PR is merged on the first run', async () => {
    const ex = new FakeExecutor();
    const result = await runBehindPrSweep([pr({ number: 42, mergeStateStatus: 'CLEAN' })], ex);
    expect(ex.mergeCalls).toEqual([42]);
    expect(result.merged).toEqual([42]);
    expect(result.audit[0].outcome).toBe('merged');
  });

  test('AC: a green BEHIND PR is updated then merged on the first run when it becomes CLEAN', async () => {
    const ex = new FakeExecutor();
    // After update-branch, the branch is now up to date with checks still green.
    ex.refetchState = (n) => pr({ number: n, mergeStateStatus: 'CLEAN', checks: 'passing' });
    const result = await runBehindPrSweep([pr({ number: 1515, mergeStateStatus: 'BEHIND' })], ex);
    expect(ex.updateCalls).toEqual([1515]);
    expect(ex.mergeCalls).toEqual([1515]);
    expect(result.merged).toEqual([1515]);
  });

  test('BEHIND PR whose checks re-run: updated, merge deferred (not merged)', async () => {
    const ex = new FakeExecutor();
    ex.refetchState = (n) => pr({ number: n, mergeStateStatus: 'BLOCKED', checks: 'pending' });
    const result = await runBehindPrSweep([pr({ number: 7, mergeStateStatus: 'BEHIND' })], ex);
    expect(ex.updateCalls).toEqual([7]);
    expect(ex.mergeCalls).toEqual([]);
    expect(result.updated).toEqual([7]);
  });

  test('AC: CONFLICTING, draft, and failing PRs are never touched', async () => {
    const ex = new FakeExecutor();
    const result = await runBehindPrSweep(
      [
        pr({ number: 1, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }),
        pr({ number: 2, isDraft: true }),
        pr({ number: 3, mergeStateStatus: 'BEHIND', checks: 'failing' }),
      ],
      ex,
    );
    expect(ex.updateCalls).toEqual([]);
    expect(ex.mergeCalls).toEqual([]);
    expect(result.skipped).toEqual([1, 2, 3]);
  });

  test('dry-run performs no executor calls but logs intended actions', async () => {
    const ex = new FakeExecutor();
    const result = await runBehindPrSweep(
      [pr({ number: 1, mergeStateStatus: 'BEHIND' }), pr({ number: 2, mergeStateStatus: 'CLEAN' })],
      ex,
      { dryRun: true },
    );
    expect(ex.updateCalls).toEqual([]);
    expect(ex.mergeCalls).toEqual([]);
    expect(result.audit[0].reason).toMatch(/dry-run: would update-branch/);
    expect(result.audit[1].reason).toMatch(/dry-run: would merge/);
  });

  test('a failed merge is recorded as failed, not merged', async () => {
    const ex = new FakeExecutor();
    ex.mergeResult = { ok: false, detail: 'required status check pending' };
    const result = await runBehindPrSweep([pr({ number: 9, mergeStateStatus: 'CLEAN' })], ex);
    expect(result.failed).toEqual([9]);
    expect(result.merged).toEqual([]);
    expect(result.audit[0].reason).toMatch(/merge failed: required status check pending/);
  });

  test('a failed update-branch is recorded and does not attempt merge', async () => {
    const ex = new FakeExecutor();
    ex.updateResult = { ok: false, detail: 'merge conflict' };
    const result = await runBehindPrSweep([pr({ number: 5, mergeStateStatus: 'BEHIND' })], ex);
    expect(ex.mergeCalls).toEqual([]);
    expect(result.failed).toEqual([5]);
  });
});

describe('renderSweepAuditLog', () => {
  test('lists every PR touched with its outcome and a summary', async () => {
    const ex = new FakeExecutor();
    const result = await runBehindPrSweep(
      [
        pr({ number: 1, title: 'green clean', mergeStateStatus: 'CLEAN' }),
        pr({ number: 2, title: 'draft', isDraft: true }),
      ],
      ex,
    );
    const log = renderSweepAuditLog(result, '2026-07-28T00:00:00Z');
    expect(log).toContain('#1 [merged]');
    expect(log).toContain('#2 [skipped] draft');
    expect(log).toContain('summary: 1 merged, 0 updated, 1 skipped, 0 failed');
  });

  test('empty PR set produces a well-formed empty log', () => {
    const log = renderSweepAuditLog({ audit: [], merged: [], updated: [], skipped: [], failed: [] }, 'now');
    expect(log).toContain('no open PRs to evaluate');
  });
});

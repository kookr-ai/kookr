import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FINISHED_MERGED_SETTLE_MS,
  DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS,
  buildDeliveredCompletionDigest,
  buildDeliveredCompletionNote,
  classifyDeliveredCompletion,
  finishedSettleStartMs,
  selectDeliveredMergedPr,
  type MergedPrAttribution,
  type TrackedPrRef,
} from './delivered-task-completion.js';
import type { Task } from '../task-read-model.js';

const T0 = Date.parse('2026-07-26T00:00:00.000Z');
const MERGED: MergedPrAttribution = {
  prNumber: 1542,
  prUrl: 'https://github.com/kookr-ai/kookr/pull/1542',
  owner: 'kookr-ai',
  repo: 'kookr',
};

/** Minimal running, opted-in task with no pending signal and no Ralph loop. */
function runningTask(
  overrides: Partial<Task> = {},
): Pick<Task, 'status' | 'ralphLoop' | 'pendingSignal' | 'autoCloseOnSignal'> {
  return { status: 'inProgress', autoCloseOnSignal: true, ...overrides } as Pick<
    Task,
    'status' | 'ralphLoop' | 'pendingSignal' | 'autoCloseOnSignal'
  >;
}

describe('classifyDeliveredCompletion', () => {
  it('defaults the budget to 10 minutes', () => {
    expect(DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS).toBe(10 * 60 * 1000);
  });

  it('auto-completes a running, merged task once elapsed reaches the budget', () => {
    const decision = classifyDeliveredCompletion(runningTask(), MERGED, {
      now: new Date(T0 + DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS),
      firstObservedMergedAtMs: T0,
    });
    expect(decision).toEqual({
      autoComplete: true,
      reason: 'post_merge_budget_exceeded',
      elapsedSinceMergeMs: DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS,
    });
  });

  it('does not complete on the tick that first observes the merge (elapsed 0)', () => {
    const decision = classifyDeliveredCompletion(runningTask(), MERGED, {
      now: new Date(T0),
      firstObservedMergedAtMs: T0,
    });
    expect(decision.autoComplete).toBe(false);
    expect(decision.reason).toBe('within_budget');
  });

  it('treats a missing first-observed timestamp as elapsed 0 (never immediate)', () => {
    const decision = classifyDeliveredCompletion(runningTask(), MERGED, {
      now: new Date(T0),
      // firstObservedMergedAtMs omitted → observed = now
      budgetMs: 60_000,
    });
    expect(decision.autoComplete).toBe(false);
    expect(decision.elapsedSinceMergeMs).toBe(0);
  });

  // INVARIANT 1 — merged-PR precondition: a task with no attributable merged PR
  // is NEVER auto-completed by this path, regardless of how much time passed.
  it('INV1: never auto-completes without a merged PR (property over elapsed/budget)', () => {
    for (let elapsedMin = 0; elapsedMin <= 600; elapsedMin += 37) {
      for (const budgetMin of [1, 5, 10, 60, 120]) {
        const decision = classifyDeliveredCompletion(runningTask(), null, {
          now: new Date(T0 + elapsedMin * 60_000),
          firstObservedMergedAtMs: T0,
          budgetMs: budgetMin * 60_000,
        });
        expect(decision.autoComplete).toBe(false);
        expect(decision.reason).toBe('not_merged');
      }
    }
  });

  // INVARIANT 2 — budget monotonicity: given a merged, running, unsignaled task,
  // autoComplete is true IFF elapsed >= budget. Exhaustive over a grid.
  it('INV2: auto-completes iff elapsed >= budget (property over a grid)', () => {
    for (const budgetMin of [1, 10, 60, 120]) {
      const budgetMs = budgetMin * 60_000;
      for (let elapsedMs = 0; elapsedMs <= budgetMs * 2; elapsedMs += budgetMs / 4) {
        const decision = classifyDeliveredCompletion(runningTask(), MERGED, {
          now: new Date(T0 + elapsedMs),
          firstObservedMergedAtMs: T0,
          budgetMs,
        });
        expect(decision.autoComplete).toBe(elapsedMs >= budgetMs);
      }
    }
  });

  // INVARIANT 3 — state guards: a non-running task, an active Ralph loop, an
  // already-pending completion_ready signal, or a provider pause are never
  // auto-completed here, no matter how far past the budget.
  it('INV3: state guards are never overridden by an exceeded budget', () => {
    const wayPast = { now: new Date(T0 + 10 * 60 * 60_000), firstObservedMergedAtMs: T0, budgetMs: 60_000 };

    for (const status of ['open', 'pending', 'completed', 'terminated', 'cancelled'] as const) {
      const d = classifyDeliveredCompletion(runningTask({ status }), MERGED, wayPast);
      expect(d.autoComplete).toBe(false);
      expect(d.reason).toBe('not_in_progress');
    }

    for (const loopStatus of ['running', 'paused'] as const) {
      const d = classifyDeliveredCompletion(
        runningTask({ ralphLoop: { status: loopStatus } as Task['ralphLoop'] }),
        MERGED,
        wayPast,
      );
      expect(d.autoComplete).toBe(false);
      expect(d.reason).toBe('ralph_active');
    }

    const signaled = classifyDeliveredCompletion(
      runningTask({ pendingSignal: { kind: 'completion_ready', raisedAt: new Date(T0).toISOString() } }),
      MERGED,
      wayPast,
    );
    expect(signaled.autoComplete).toBe(false);
    expect(signaled.reason).toBe('already_signaled');

    // Not opted into autoCloseOnSignal → ask-first / human-review path owns it.
    for (const optIn of [false, undefined]) {
      const notOptedIn = classifyDeliveredCompletion(
        runningTask({ autoCloseOnSignal: optIn }),
        MERGED,
        wayPast,
      );
      expect(notOptedIn.autoComplete).toBe(false);
      expect(notOptedIn.reason).toBe('not_opted_in');
    }

    // Issue #1667: provider pause blocks delivered auto-complete.
    const paused = classifyDeliveredCompletion(runningTask(), MERGED, {
      ...wayPast,
      providerPaused: true,
    });
    expect(paused.autoComplete).toBe(false);
    expect(paused.reason).toBe('provider_paused');
  });

  // INVARIANT 4 — exact boundary under a controlled clock.
  it('INV4: fires at exactly elapsed === budget, not one ms before', () => {
    const budgetMs = 10 * 60_000;
    const justBefore = classifyDeliveredCompletion(runningTask(), MERGED, {
      now: new Date(T0 + budgetMs - 1),
      firstObservedMergedAtMs: T0,
      budgetMs,
    });
    expect(justBefore.autoComplete).toBe(false);

    const exactly = classifyDeliveredCompletion(runningTask(), MERGED, {
      now: new Date(T0 + budgetMs),
      firstObservedMergedAtMs: T0,
      budgetMs,
    });
    expect(exactly.autoComplete).toBe(true);
  });
});

describe('selectDeliveredMergedPr', () => {
  const agentPr = (n: number, status = 'merged'): TrackedPrRef => ({
    status,
    number: n,
    url: `https://github.com/kookr-ai/kookr/pull/${n}`,
    owner: 'kookr-ai',
    repo: 'kookr',
    detectedFrom: 'kookr-task-abc',
  });
  const promptPr = (n: number, status = 'merged'): TrackedPrRef => ({ ...agentPr(n, status), detectedFrom: 'prompt' });

  it('returns the task’s own merged PR (agent-detected)', () => {
    expect(selectDeliveredMergedPr([agentPr(1542)])).toEqual({
      prNumber: 1542,
      prUrl: 'https://github.com/kookr-ai/kookr/pull/1542',
      owner: 'kookr-ai',
      repo: 'kookr',
    });
  });

  it('INV1: never attributes a prompt-referenced merged PR (false-positive guard)', () => {
    // A live task whose prompt cites an already-merged PR must not be delivered.
    expect(selectDeliveredMergedPr([promptPr(1500)])).toBeNull();
    // Mixed: the prompt-referenced merge is ignored; only the agent's own counts.
    expect(selectDeliveredMergedPr([promptPr(1500), agentPr(1542)])?.prNumber).toBe(1542);
  });

  it('returns null when the task’s own PR is not yet merged', () => {
    expect(selectDeliveredMergedPr([agentPr(1542, 'open')])).toBeNull();
    expect(selectDeliveredMergedPr([])).toBeNull();
  });

  describe('notBefore — the task creation bound (issue #3746)', () => {
    const TASK_CREATED = new Date('2026-11-14T13:56:12.000Z');
    /** A PR opened and merged at `iso` (opened-at only matters in the #3678 cases below). */
    const mergedAt = (n: number, iso: string): TrackedPrRef => ({
      ...agentPr(n),
      openedAt: new Date(iso),
      mergedAt: new Date(iso),
    });

    it('never attributes a PR merged before the task existed', () => {
      // Prod: task 07eeed57 was completed over PR #855, merged five months earlier.
      expect(
        selectDeliveredMergedPr([mergedAt(855, '2026-06-10T09:00:00.000Z')], { notBefore: TASK_CREATED }),
      ).toBeNull();
    });

    it('rejects a PR merged one millisecond before creation and accepts one merged exactly at it', () => {
      expect(
        selectDeliveredMergedPr([mergedAt(1, '2026-11-14T13:56:11.999Z')], { notBefore: TASK_CREATED }),
      ).toBeNull();
      expect(
        selectDeliveredMergedPr([mergedAt(2, '2026-11-14T13:56:12.000Z')], { notBefore: TASK_CREATED })?.prNumber,
      ).toBe(2);
    });

    it('attributes a PR merged after creation', () => {
      expect(
        selectDeliveredMergedPr([mergedAt(3800, '2026-11-14T15:00:00.000Z')], { notBefore: TASK_CREATED }),
      ).toEqual({
        prNumber: 3800,
        prUrl: 'https://github.com/kookr-ai/kookr/pull/3800',
        owner: 'kookr-ai',
        repo: 'kookr',
        mergedAt: new Date('2026-11-14T15:00:00.000Z'),
      });
    });

    it('skips a stale PR listed first and returns the real delivery after it', () => {
      expect(
        selectDeliveredMergedPr(
          [mergedAt(855, '2026-06-10T09:00:00.000Z'), mergedAt(3800, '2026-11-14T15:00:00.000Z')],
          { notBefore: TASK_CREATED },
        )?.prNumber,
      ).toBe(3800);
    });

    it('fails closed when the merge time is unknown', () => {
      // Opened after the task was created, so only the unknown merge time can reject it.
      const noMergedAt: TrackedPrRef = { ...agentPr(855), openedAt: new Date('2026-11-14T14:00:00.000Z') };
      expect(selectDeliveredMergedPr([noMergedAt], { notBefore: TASK_CREATED })).toBeNull();
    });

    it('accepts an ISO-string creation time (persisted task records)', () => {
      expect(
        selectDeliveredMergedPr([mergedAt(855, '2026-06-10T09:00:00.000Z')], {
          notBefore: '2026-11-14T13:56:12.000Z',
        }),
      ).toBeNull();
      expect(
        selectDeliveredMergedPr([mergedAt(3800, '2026-11-14T15:00:00.000Z')], {
          notBefore: '2026-11-14T13:56:12.000Z',
        })?.prNumber,
      ).toBe(3800);
    });

    it('fails closed on an unparseable creation time', () => {
      expect(
        selectDeliveredMergedPr([mergedAt(3800, '2026-11-14T15:00:00.000Z')], { notBefore: 'not-a-date' }),
      ).toBeNull();
    });

    it('issue #3678: never attributes a PR opened before the task existed, even when it merged after', () => {
      // A chain successor mentioned its predecessor's PR, which was waiting on
      // auto-merge when the successor started.
      const predecessorPr: TrackedPrRef = {
        ...agentPr(3603),
        openedAt: new Date('2026-11-14T13:00:00.000Z'),
        mergedAt: new Date('2026-11-14T14:30:00.000Z'),
      };
      expect(selectDeliveredMergedPr([predecessorPr], { notBefore: TASK_CREATED })).toBeNull();
    });

    it('issue #3678: rejects a PR opened one millisecond before creation and accepts one opened exactly at it', () => {
      const opened = (n: number, iso: string): TrackedPrRef => ({
        ...agentPr(n),
        openedAt: new Date(iso),
        mergedAt: new Date('2026-11-14T15:00:00.000Z'),
      });
      expect(
        selectDeliveredMergedPr([opened(1, '2026-11-14T13:56:11.999Z')], { notBefore: TASK_CREATED }),
      ).toBeNull();
      expect(
        selectDeliveredMergedPr([opened(2, '2026-11-14T13:56:12.000Z')], { notBefore: TASK_CREATED })?.prNumber,
      ).toBe(2);
    });

    it('issue #3678: fails closed when the opening time is unknown', () => {
      const noOpenedAt: TrackedPrRef = { ...agentPr(3800), mergedAt: new Date('2026-11-14T15:00:00.000Z') };
      expect(selectDeliveredMergedPr([noOpenedAt], { notBefore: TASK_CREATED })).toBeNull();
    });

    it('issue #3678: skips the predecessor\'s PR and returns the task\'s own PR listed after it', () => {
      const predecessorPr: TrackedPrRef = {
        ...agentPr(3603),
        openedAt: new Date('2026-11-14T13:00:00.000Z'),
        mergedAt: new Date('2026-11-14T14:30:00.000Z'),
      };
      expect(
        selectDeliveredMergedPr([predecessorPr, mergedAt(3800, '2026-11-14T15:00:00.000Z')], {
          notBefore: TASK_CREATED,
        })?.prNumber,
      ).toBe(3800);
    });

    it('without notBefore, keeps the pre-#3746 behaviour (merge time ignored)', () => {
      expect(selectDeliveredMergedPr([mergedAt(855, '2026-06-10T09:00:00.000Z')])?.prNumber).toBe(855);
    });
  });
});

describe('buildDeliveredCompletionNote', () => {
  it('names the merged PR number and the budget', () => {
    const note = buildDeliveredCompletionNote(1542, 10 * 60_000);
    expect(note).toContain('PR #1542');
    expect(note).toContain('10m');
  });
});

describe('buildDeliveredCompletionDigest', () => {
  it('names the merged PR number in the first bullet and carries the URL', () => {
    const digest = buildDeliveredCompletionDigest(MERGED, 10 * 60_000);
    expect(digest.bullets[0]).toContain('PR #1542');
    expect(digest.prUrls).toEqual([MERGED.prUrl]);
    expect(digest.bullets.some((b) => b.includes(MERGED.prUrl!))).toBe(true);
  });

  it('still names the PR number when no URL is known', () => {
    const digest = buildDeliveredCompletionDigest({ prNumber: 77 }, 5 * 60_000);
    expect(digest.bullets[0]).toContain('PR #77');
    expect(digest.prUrls).toBeUndefined();
  });
});

/**
 * Issue #3930: a task that said "finished" after its own PR merged completes
 * after a short settle time instead of the full cleanup budget.
 */
describe('classifyDeliveredCompletion — settle path after a post-merge "finished" (issue #3930)', () => {
  const MERGED_AT = new Date(T0);
  const MERGED_WITH_TIME: MergedPrAttribution = { ...MERGED, mergedAt: MERGED_AT };
  const SIGNAL_AT = T0 + 60_000;
  const finished = (overrides: Partial<Task> = {}) =>
    ({ ...runningTask(), finishedSignalAt: new Date(SIGNAL_AT).toISOString(), ...overrides }) as Pick<
      Task,
      'status' | 'ralphLoop' | 'pendingSignal' | 'autoCloseOnSignal' | 'finishedSignalAt'
    >;

  it('defaults the settle time to 2 minutes', () => {
    expect(DEFAULT_FINISHED_MERGED_SETTLE_MS).toBe(2 * 60 * 1000);
  });

  it('completes once the settle time has passed since the "finished" signal', () => {
    expect(
      classifyDeliveredCompletion(finished(), MERGED_WITH_TIME, {
        now: new Date(SIGNAL_AT + DEFAULT_FINISHED_MERGED_SETTLE_MS),
        firstObservedMergedAtMs: SIGNAL_AT,
      }),
    ).toEqual({
      autoComplete: true,
      reason: 'finished_after_merge',
      elapsedSinceMergeMs: DEFAULT_FINISHED_MERGED_SETTLE_MS,
    });
  });

  it('waits inside the settle time', () => {
    const decision = classifyDeliveredCompletion(finished(), MERGED_WITH_TIME, {
      now: new Date(SIGNAL_AT + DEFAULT_FINISHED_MERGED_SETTLE_MS - 1),
    });
    expect(decision).toMatchObject({ autoComplete: false, reason: 'within_settle' });
  });

  it('honours a configured settle time', () => {
    const decision = classifyDeliveredCompletion(finished(), MERGED_WITH_TIME, {
      now: new Date(SIGNAL_AT + 3 * 60_000),
      settleMs: 5 * 60_000,
    });
    expect(decision.reason).toBe('within_settle');
  });

  it('completes while the "finished" signal is still pending (it no longer refuses as already_signaled)', () => {
    const decision = classifyDeliveredCompletion(
      finished({
        pendingSignal: { kind: 'completion_ready', raisedAt: new Date(SIGNAL_AT).toISOString() },
      }),
      MERGED_WITH_TIME,
      { now: new Date(SIGNAL_AT + DEFAULT_FINISHED_MERGED_SETTLE_MS) },
    );
    expect(decision).toMatchObject({ autoComplete: true, reason: 'finished_after_merge' });
  });

  it('a "finished" raised before the merge settles from the merge time (issue #3983)', () => {
    // GitHub auto-merge: the agent said "finished", the merge came later.
    const before = new Date(T0 - 60_000).toISOString();
    const task = finished({ finishedSignalAt: before });
    const opts = { firstObservedMergedAtMs: T0 };
    expect(
      classifyDeliveredCompletion(task, MERGED_WITH_TIME, { ...opts, now: new Date(T0 + DEFAULT_FINISHED_MERGED_SETTLE_MS - 1) }),
    ).toMatchObject({ autoComplete: false, reason: 'within_settle', elapsedSinceMergeMs: DEFAULT_FINISHED_MERGED_SETTLE_MS - 1 });
    expect(
      classifyDeliveredCompletion(task, MERGED_WITH_TIME, { ...opts, now: new Date(T0 + DEFAULT_FINISHED_MERGED_SETTLE_MS) }),
    ).toEqual({ autoComplete: true, reason: 'finished_after_merge', elapsedSinceMergeMs: DEFAULT_FINISHED_MERGED_SETTLE_MS });
  });

  it('a "finished" raised before the merge and still pending also takes the settle path', () => {
    const before = new Date(T0 - 60_000).toISOString();
    const decision = classifyDeliveredCompletion(
      finished({ finishedSignalAt: before, pendingSignal: { kind: 'completion_ready', raisedAt: before } }),
      MERGED_WITH_TIME,
      { now: new Date(T0 + DEFAULT_FINISHED_MERGED_SETTLE_MS), firstObservedMergedAtMs: T0 },
    );
    expect(decision).toMatchObject({ autoComplete: true, reason: 'finished_after_merge' });
  });

  it('with no "finished" on record (a new prompt cleared it), the budget path stays in charge', () => {
    const decision = classifyDeliveredCompletion(
      finished({ finishedSignalAt: undefined }),
      MERGED_WITH_TIME,
      { now: new Date(T0 + 5 * 60_000), firstObservedMergedAtMs: T0 },
    );
    expect(decision.reason).toBe('within_budget');
  });

  it('a pending signal with an unknown merge time keeps the old refusal', () => {
    const decision = classifyDeliveredCompletion(
      finished({ pendingSignal: { kind: 'completion_ready', raisedAt: new Date(SIGNAL_AT).toISOString() } }),
      MERGED,
      { now: new Date(T0 + DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS), firstObservedMergedAtMs: T0 },
    );
    expect(decision.reason).toBe('already_signaled');
  });

  it('an unknown merge time fails closed to the budget path', () => {
    const decision = classifyDeliveredCompletion(finished(), MERGED, {
      now: new Date(SIGNAL_AT + DEFAULT_FINISHED_MERGED_SETTLE_MS),
      firstObservedMergedAtMs: SIGNAL_AT,
    });
    expect(decision.reason).toBe('within_budget');
  });

  it('no merged PR: never completes, whatever the signal', () => {
    const decision = classifyDeliveredCompletion(finished(), null, {
      now: new Date(SIGNAL_AT + 60 * 60_000),
    });
    expect(decision).toEqual({ autoComplete: false, reason: 'not_merged' });
  });

  it.each([
    ['not_opted_in', { autoCloseOnSignal: false }, false],
    ['ralph_active', { ralphLoop: { status: 'running' } as Task['ralphLoop'] }, false],
    ['provider_paused', {}, true],
  ] as const)('%s still blocks the settle path', (reason, overrides, providerPaused) => {
    const decision = classifyDeliveredCompletion(finished(overrides as Partial<Task>), MERGED_WITH_TIME, {
      now: new Date(SIGNAL_AT + 60 * 60_000),
      providerPaused,
    });
    expect(decision).toEqual({ autoComplete: false, reason });
  });

  it('the note and digest name the PR and the settle time, not the cleanup budget', () => {
    const note = buildDeliveredCompletionNote(1542, 2 * 60_000, 'finished_after_merge');
    expect(note).toContain('PR #1542');
    expect(note).toContain('2m settle time');
    expect(note).not.toContain('budget');
    const digest = buildDeliveredCompletionDigest(MERGED, 2 * 60_000, 'finished_after_merge');
    expect(digest.bullets[0]).toContain('PR #1542');
    expect(digest.bullets[0]).toContain('settle time');
  });
});

describe('finishedSettleStartMs (issues #3930, #3983)', () => {
  const mergedAt = new Date(T0);
  it('returns the signal time when it is at or after the merge', () => {
    expect(finishedSettleStartMs({ finishedSignalAt: new Date(T0 + 5).toISOString() }, { mergedAt })).toBe(T0 + 5);
    expect(finishedSettleStartMs({ finishedSignalAt: new Date(T0).toISOString() }, { mergedAt })).toBe(T0);
  });
  it('returns the merge time for a signal raised before the merge', () => {
    expect(finishedSettleStartMs({ finishedSignalAt: new Date(T0 - 1).toISOString() }, { mergedAt })).toBe(T0);
  });
  it('is undefined for an unparseable signal, no signal, or an unknown merge time', () => {
    expect(finishedSettleStartMs({ finishedSignalAt: 'not a date' }, { mergedAt })).toBeUndefined();
    expect(finishedSettleStartMs({}, { mergedAt })).toBeUndefined();
    expect(finishedSettleStartMs({ finishedSignalAt: new Date(T0).toISOString() }, {})).toBeUndefined();
  });
});

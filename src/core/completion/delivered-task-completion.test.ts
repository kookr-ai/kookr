import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS,
  buildDeliveredCompletionDigest,
  buildDeliveredCompletionNote,
  classifyDeliveredCompletion,
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

import { describe, expect, it } from 'vitest';
import type { AgentEvent } from './agent-events.js';
import {
  PROVIDER_PAUSED_REASON,
  classifyProviderPause,
  isProviderPaused,
} from './provider-pause.js';
import {
  classifyDeliveredCompletion,
  DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS,
  type MergedPrAttribution,
} from './delivered-task-completion.js';
import { deriveStuckReason } from './stuck-reason.js';
import { listStaleCompletionReadyTasks } from './completion-ready-cleanup.js';
import type { Task } from './task-read-model.js';

const T0 = Date.parse('2026-07-28T17:18:00.000Z');
const MERGED: MergedPrAttribution = {
  prNumber: 1742,
  prUrl: 'https://github.com/jeanibarz/lucy/pull/1742',
  owner: 'jeanibarz',
  repo: 'lucy',
};

/** 74d1d038 / c21629df shape: GH Actions spending-limit annotation text. */
const GH_ACTIONS_BILLING_TEXT =
  "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing' page.";

function stopFailure(error: string, lastMessage: string): AgentEvent {
  return { type: 'stop_failure', sessionId: 's1', error, lastMessage };
}

function runningTask(
  overrides: Partial<Task> = {},
): Pick<Task, 'status' | 'ralphLoop' | 'pendingSignal' | 'autoCloseOnSignal'> {
  return { status: 'inProgress', autoCloseOnSignal: true, ...overrides } as Pick<
    Task,
    'status' | 'ralphLoop' | 'pendingSignal' | 'autoCloseOnSignal'
  >;
}

describe('classifyProviderPause (issue #1667)', () => {
  it('detects stop_failure billing_error as provider_paused', () => {
    const d = classifyProviderPause({
      events: [stopFailure('billing_error', 'Credit balance is too low')],
    });
    expect(d).toEqual({
      paused: true,
      reason: PROVIDER_PAUSED_REASON,
      detail: 'stop_failure:billing_error',
    });
  });

  it('detects rate_limit and authentication_failed stop errors', () => {
    expect(isProviderPaused({ events: [stopFailure('rate_limit', 'slow down')] })).toBe(true);
    expect(isProviderPaused({ events: [stopFailure('authentication_failed', 'relogin')] })).toBe(true);
  });

  it('detects the 74d1d038 GH Actions spending-limit fingerprint in free text', () => {
    const d = classifyProviderPause({ texts: [GH_ACTIONS_BILLING_TEXT] });
    expect(d.paused).toBe(true);
    expect(d.reason).toBe(PROVIDER_PAUSED_REASON);
    expect(d.detail).toBe('text_surface');
  });

  it('detects GH Actions billing annotations inside a tool_result (gh run view)', () => {
    const d = classifyProviderPause({
      events: [
        {
          type: 'tool_result',
          sessionId: 's1',
          toolName: 'Bash',
          toolResponse: JSON.stringify({
            conclusion: 'failure',
            annotations: [GH_ACTIONS_BILLING_TEXT],
          }),
        },
      ],
    });
    expect(d.paused).toBe(true);
    expect(d.detail).toBe('tool_result');
  });

  it('detects api_error anomaly with billing explanation', () => {
    expect(
      isProviderPaused({
        anomalyType: 'api_error',
        anomalyExplanation: 'API error: billing_error. Last message: "Credit balance is too low"',
      }),
    ).toBe(true);
  });

  it('does not pause on unrelated events / anomalies', () => {
    expect(
      isProviderPaused({
        events: [{ type: 'stop', sessionId: 's1', lastMessage: 'done' }],
        anomalyType: 'needs_input',
      }),
    ).toBe(false);
    expect(isProviderPaused({})).toBe(false);
  });
});

describe('classifyDeliveredCompletion + provider_paused (issue #1667)', () => {
  const wayPast = {
    now: new Date(T0 + DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS + 60_000),
    firstObservedMergedAtMs: T0,
    budgetMs: DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS,
  };

  it('INV: never auto-completes as delivered while providerPaused, even past the budget', () => {
    const decision = classifyDeliveredCompletion(runningTask(), MERGED, {
      ...wayPast,
      providerPaused: true,
    });
    expect(decision).toEqual({ autoComplete: false, reason: 'provider_paused' });
  });

  it('still auto-completes once the pause clears (resume path)', () => {
    const paused = classifyDeliveredCompletion(runningTask(), MERGED, {
      ...wayPast,
      providerPaused: true,
    });
    expect(paused.autoComplete).toBe(false);

    const resumed = classifyDeliveredCompletion(runningTask(), MERGED, {
      ...wayPast,
      providerPaused: false,
    });
    expect(resumed).toEqual({
      autoComplete: true,
      reason: 'post_merge_budget_exceeded',
      elapsedSinceMergeMs: DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS + 60_000,
    });
  });
});

describe('deriveStuckReason provider_paused (issue #1667)', () => {
  it('surfaces provider_paused ahead of hung_suspect', () => {
    const reason = deriveStuckReason({
      status: 'inProgress',
      providerPaused: true,
      hungSuspect: true,
      anomalyType: 'stale_agent',
    });
    expect(reason).toBe('provider_paused');
  });

  it('completion_ready still outranks provider_paused', () => {
    const reason = deriveStuckReason({
      status: 'inProgress',
      pendingSignal: { kind: 'completion_ready' },
      providerPaused: true,
    });
    expect(reason).toBe('awaiting_completion_ack');
  });
});

/**
 * Fixture reproducing the 74d1d038 shape end-to-end at the pure layer:
 * delivery-owning child, merged-PR attribution past the budget, billing
 * evidence in recent tool output → stall → not completed → resume.
 */
describe('74d1d038 fixture: stall → not completed → resume (issue #1667)', () => {
  it('holds delivered auto-complete across the billing stall, then completes on resume', () => {
    const billingEvidence = {
      events: [
        {
          type: 'tool_result' as const,
          sessionId: 'kookr-da679768',
          toolName: 'Bash',
          toolResponse: GH_ACTIONS_BILLING_TEXT,
        },
      ],
    };

    // 1) Stall: provider paused.
    expect(isProviderPaused(billingEvidence)).toBe(true);
    const stalled = classifyDeliveredCompletion(runningTask(), MERGED, {
      now: new Date(T0 + DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS + 1),
      firstObservedMergedAtMs: T0,
      providerPaused: true,
    });
    expect(stalled.autoComplete).toBe(false);
    expect(stalled.reason).toBe('provider_paused');
    expect(deriveStuckReason({ status: 'inProgress', providerPaused: true })).toBe('provider_paused');

    // 2) Resume: billing cleared, same task, budget still exceeded → complete.
    const clearEvidence = {
      events: [{ type: 'stop' as const, sessionId: 'kookr-da679768', lastMessage: 'merged via admin exception' }],
    };
    expect(isProviderPaused(clearEvidence)).toBe(false);
    const resumed = classifyDeliveredCompletion(runningTask(), MERGED, {
      now: new Date(T0 + DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS + 1),
      firstObservedMergedAtMs: T0,
      providerPaused: false,
    });
    expect(resumed.autoComplete).toBe(true);
    expect(resumed.reason).toBe('post_merge_budget_exceeded');
  });

  it('completion-ready auto-close skips provider-paused children (signal held, not completed)', () => {
    const task = {
      id: 'c21629df-fixture',
      status: 'inProgress' as const,
      autoCloseOnSignal: true,
      pendingSignal: {
        kind: 'completion_ready' as const,
        raisedAt: new Date(T0).toISOString(),
        source: 'http' as const,
      },
      sessions: [
        {
          tmuxSession: 'kookr-da679768',
          agentType: 'codex-cli' as const,
          cwd: '/tmp',
          createdAt: new Date(T0 - 60_000),
          lastStatus: undefined,
        },
      ],
    } as unknown as Task;

    const pastDelay = new Date(T0 + 60 * 60_000);
    const withoutGuard = listStaleCompletionReadyTasks([task], {
      now: pastDelay,
      thresholdMs: 30 * 60_000,
    });
    expect(withoutGuard).toHaveLength(1);
    expect(withoutGuard[0]!.canAutoClose).toBe(true);

    const withGuard = listStaleCompletionReadyTasks([task], {
      now: pastDelay,
      thresholdMs: 30 * 60_000,
      isProviderPaused: () => true,
    });
    expect(withGuard).toHaveLength(0);

    // Resume: pause clears → eligible again.
    const afterResume = listStaleCompletionReadyTasks([task], {
      now: pastDelay,
      thresholdMs: 30 * 60_000,
      isProviderPaused: () => false,
    });
    expect(afterResume).toHaveLength(1);
  });
});

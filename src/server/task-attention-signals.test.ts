import { describe, expect, it } from 'vitest';

import { resolveTaskAttentionSignals } from './task-attention-signals.js';

const HOUR_MS = 60 * 60 * 1000;

function subject(overrides: Partial<Parameters<typeof resolveTaskAttentionSignals>[0]> = {}) {
  return {
    status: 'inProgress' as const,
    sessions: [{ tmuxSession: 'kookr-test1234' }],
    ...overrides,
  };
}

describe('resolveTaskAttentionSignals', () => {
  it('returns the all-false default for a task with no sessions', () => {
    const signals = resolveTaskAttentionSignals(subject({ sessions: [] }), {}, Date.now());
    expect(signals).toEqual({ hungSuspect: false, queuedAnomalyType: null, providerPaused: false, mergeReady: false });
  });

  it('trusts a queued stale_agent verdict directly', () => {
    const signals = resolveTaskAttentionSignals(
      subject(),
      { queue: { peek: () => ({ type: 'stale_agent' }) as never } },
      Date.now(),
    );
    expect(signals.hungSuspect).toBe(true);
    expect(signals.queuedAnomalyType).toBe('stale_agent');
    expect(signals.providerPaused).toBe(false);
  });

  it('issue #1667: flags providerPaused from a billing-shaped api_error anomaly', () => {
    const signals = resolveTaskAttentionSignals(
      subject(),
      {
        queue: {
          peek: () =>
            ({
              type: 'api_error',
              explanation: 'API error: billing_error. Last message: "Credit balance is too low"',
            }) as never,
        },
      },
      Date.now(),
    );
    expect(signals.providerPaused).toBe(true);
    expect(signals.queuedAnomalyType).toBe('api_error');
  });

  it('flags all-channels-silent liveness past the watchdog threshold, but never a live tool call', () => {
    const now = Date.now();
    const stale = now - 10 * HOUR_MS;
    const watchdog = (toolInProgress: boolean) => ({
      getState: () => ({ lastEventAt: stale, lastPaneChangeAt: stale, lastTokenActivityAt: stale }) as never,
      getConfig: () => ({ unconditionalStaleThresholdMs: HOUR_MS }) as never,
      hasToolInProgress: () => toolInProgress,
    });
    expect(resolveTaskAttentionSignals(subject(), { watchdog: watchdog(false) }, now).hungSuspect).toBe(true);
    expect(resolveTaskAttentionSignals(subject(), { watchdog: watchdog(true) }, now).hungSuspect).toBe(false);
  });

  it('#1653: exposes the agent liveness timestamps mapped from watchdog state', () => {
    const now = Date.now();
    const state = { lastEventAt: now - 1_000, lastPaneChangeAt: now - 2_000, lastTokenActivityAt: now - 3_000 };
    const signals = resolveTaskAttentionSignals(
      subject(),
      {
        watchdog: {
          getState: () => state as never,
          getConfig: () => ({ unconditionalStaleThresholdMs: HOUR_MS }) as never,
          hasToolInProgress: () => false,
        },
      },
      now,
    );
    expect(signals.liveness).toEqual({
      lastHookEventAt: state.lastEventAt,
      lastPaneChangeAt: state.lastPaneChangeAt,
      lastTokenActivityAt: state.lastTokenActivityAt,
    });
  });

  it('#1653: liveness is undefined when the watchdog has no state for the agent', () => {
    const now = Date.now();
    const signals = resolveTaskAttentionSignals(
      subject(),
      {
        watchdog: {
          getState: () => undefined,
          getConfig: () => ({ unconditionalStaleThresholdMs: HOUR_MS }) as never,
          hasToolInProgress: () => false,
        },
      },
      now,
    );
    expect(signals.liveness).toBeUndefined();
  });

  describe('#1148: publish/merge reconciliation', () => {
    it('flags mergeReady and surfaces the reconciliation verdict from a pr-green-mergeable queued anomaly', () => {
      const signals = resolveTaskAttentionSignals(
        subject(),
        {
          queue: {
            peek: () =>
              ({
                type: 'needs_input',
                explanation: 'PR is green and mergeable...',
                reconciliation: {
                  classification: 'pr-green-mergeable',
                  reasonCode: 'pr_green_mergeable_auto_merge_authorized',
                  evidence: {} as never,
                },
              }) as never,
          },
        },
        Date.now(),
      );
      expect(signals.mergeReady).toBe(true);
      expect(signals.reconciliation).toEqual({
        classification: 'pr-green-mergeable',
        reasonCode: 'pr_green_mergeable_auto_merge_authorized',
      });
    });

    it('does not flag mergeReady for a real-blocker reconciliation verdict', () => {
      const signals = resolveTaskAttentionSignals(
        subject(),
        {
          queue: {
            peek: () =>
              ({
                type: 'needs_input',
                explanation: 'Agent is waiting for input.',
                reconciliation: {
                  classification: 'real-blocker',
                  reasonCode: 'no_reconciling_evidence',
                  evidence: {} as never,
                },
              }) as never,
          },
        },
        Date.now(),
      );
      expect(signals.mergeReady).toBe(false);
      expect(signals.reconciliation).toEqual({ classification: 'real-blocker', reasonCode: 'no_reconciling_evidence' });
    });

    it('omits reconciliation when the queued anomaly has none', () => {
      const signals = resolveTaskAttentionSignals(
        subject(),
        { queue: { peek: () => ({ type: 'needs_input', explanation: 'Agent is waiting for input.' }) as never } },
        Date.now(),
      );
      expect(signals.mergeReady).toBe(false);
      expect(signals.reconciliation).toBeUndefined();
    });
  });
});

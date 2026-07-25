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
    expect(signals).toEqual({ hungSuspect: false, queuedAnomalyType: null });
  });

  it('trusts a queued stale_agent verdict directly', () => {
    const signals = resolveTaskAttentionSignals(
      subject(),
      { queue: { peek: () => ({ type: 'stale_agent' }) as never } },
      Date.now(),
    );
    expect(signals.hungSuspect).toBe(true);
    expect(signals.queuedAnomalyType).toBe('stale_agent');
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
});

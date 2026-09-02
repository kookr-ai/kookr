import { describe, it, expect, vi } from 'vitest';
import type { ServerMessage } from '../shared/contracts/messages.js';
import type { PinnedBatchScheduleInfo } from '../core/batch-selector-pin.js';
import { ScheduleBatchPinAlerter } from './schedule-batch-pin-alert.js';

function pinned(overrides: Partial<PinnedBatchScheduleInfo> = {}): PinnedBatchScheduleInfo {
  return {
    id: 'sched-1',
    name: 'Kookr parallel issue batch',
    issues: [2756, 2757, 2758],
    selector: '2756 2757 2758',
    ...overrides,
  };
}

function makeAlerter() {
  const broadcast = vi.fn();
  const alerter = new ScheduleBatchPinAlerter({ broadcast });
  return { broadcast, alerter };
}

function alerts(broadcast: ReturnType<typeof vi.fn>): Extract<ServerMessage, { type: 'alert' }>[] {
  return broadcast.mock.calls.map((c) => c[0] as Extract<ServerMessage, { type: 'alert' }>);
}

describe('ScheduleBatchPinAlerter (issue #2982)', () => {
  it('fires once on the healthy→pinned edge with an actionable warning', () => {
    const { broadcast, alerter } = makeAlerter();
    alerter.check([pinned()], ['sched-1']);
    const fired = alerts(broadcast);
    expect(fired).toHaveLength(1);
    expect(fired[0].severity).toBe('warning');
    expect(fired[0].operationalAlert).toMatchObject({
      key: 'schedule:batch_drained_pin:sched-1',
      metric: 'schedule_batch_drained_pin',
      state: 'fired',
    });
    // The alert names the pinned issues and the fix.
    expect(fired[0].details).toContain('#2756 #2757 #2758');
    expect(fired[0].details).toContain('Blank the `issueSelector`');
  });

  it('does not re-fire while the schedule stays pinned across cycles', () => {
    const { broadcast, alerter } = makeAlerter();
    alerter.check([pinned()], ['sched-1']);
    alerter.check([pinned()], ['sched-1']);
    alerter.check([pinned({ selector: '2756 2757 2758' })], ['sched-1']);
    // Exactly one broadcast total — one fire, and (crucially) no spurious
    // recovery emitted mid-sequence while the schedule stays pinned.
    expect(alerts(broadcast)).toHaveLength(1);
    expect(alerts(broadcast)[0].operationalAlert?.state).toBe('fired');
  });

  it('emits a recovery alert when the pin is cleared but the schedule remains', () => {
    const { broadcast, alerter } = makeAlerter();
    alerter.check([pinned()], ['sched-1']);
    broadcast.mockClear();
    // Selector blanked: no longer in the pinned set, but still evaluated.
    alerter.check([], ['sched-1']);
    const recovered = alerts(broadcast);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].severity).toBe('info');
    expect(recovered[0].operationalAlert).toMatchObject({
      key: 'schedule:batch_drained_pin:sched-1',
      state: 'recovered',
    });
  });

  it('clears silently (no recovery alert) when the schedule is deleted', () => {
    const { broadcast, alerter } = makeAlerter();
    alerter.check([pinned()], ['sched-1']);
    broadcast.mockClear();
    // Schedule gone entirely: not pinned AND not in evaluatedIds.
    alerter.check([], []);
    expect(alerts(broadcast)).toHaveLength(0);
  });

  it('re-fires after a clear→pin cycle (edge-triggered, not one-shot forever)', () => {
    const { broadcast, alerter } = makeAlerter();
    alerter.check([pinned()], ['sched-1']);
    alerter.check([], ['sched-1']); // recovered
    broadcast.mockClear();
    alerter.check([pinned()], ['sched-1']); // pinned again
    const fired = alerts(broadcast);
    expect(fired).toHaveLength(1);
    expect(fired[0].operationalAlert?.state).toBe('fired');
  });

  it('keys per schedule id so several pinned batches fire independently', () => {
    const { broadcast, alerter } = makeAlerter();
    alerter.check(
      [pinned({ id: 'a' }), pinned({ id: 'b', name: 'Other batch', issues: [1], selector: '1' })],
      ['a', 'b'],
    );
    const fired = alerts(broadcast);
    expect(fired).toHaveLength(2);
    expect(new Set(fired.map((f) => f.operationalAlert?.key))).toEqual(
      new Set(['schedule:batch_drained_pin:a', 'schedule:batch_drained_pin:b']),
    );
  });

  it('never throws on empty input', () => {
    const { alerter } = makeAlerter();
    expect(() => alerter.check([])).not.toThrow();
  });
});

import { describe, expect, test } from 'vitest';
import { deriveStuckReason } from './stuck-reason.js';

describe('deriveStuckReason', () => {
  test('not inProgress → null, regardless of other signals', () => {
    for (const status of ['open', 'pending', 'completed', 'terminated', 'cancelled'] as const) {
      expect(
        deriveStuckReason({
          status,
          pendingSignal: { kind: 'completion_ready' },
          hungSuspect: true,
          anomalyType: 'permission_blocked',
        }),
      ).toBeNull();
    }
  });

  test('pendingSignal completion_ready → awaiting_completion_ack, highest priority', () => {
    const reason = deriveStuckReason({
      status: 'inProgress',
      pendingSignal: { kind: 'completion_ready' },
      hungSuspect: true,
      anomalyType: 'permission_blocked',
    });
    expect(reason).toBe('awaiting_completion_ack');
  });

  test('hungSuspect true (no pendingSignal) → hung_suspect', () => {
    const reason = deriveStuckReason({ status: 'inProgress', hungSuspect: true, anomalyType: null });
    expect(reason).toBe('hung_suspect');
  });

  test('anomalyType stale_agent alone (hungSuspect omitted) also maps to hung_suspect', () => {
    const reason = deriveStuckReason({ status: 'inProgress', anomalyType: 'stale_agent' });
    expect(reason).toBe('hung_suspect');
  });

  test('anomalyType needs_input → waiting_on_input', () => {
    const reason = deriveStuckReason({ status: 'inProgress', hungSuspect: false, anomalyType: 'needs_input' });
    expect(reason).toBe('waiting_on_input');
  });

  test('anomalyType permission_blocked → permission_blocked', () => {
    const reason = deriveStuckReason({ status: 'inProgress', hungSuspect: false, anomalyType: 'permission_blocked' });
    expect(reason).toBe('permission_blocked');
  });

  test('boundary: watchdog state absent (hungSuspect omitted, no anomaly) → null, i.e. genuinely working', () => {
    const reason = deriveStuckReason({ status: 'inProgress' });
    expect(reason).toBeNull();
  });

  test('an unrelated anomaly type (e.g. repeated_error) does not produce a stuck reason', () => {
    const reason = deriveStuckReason({ status: 'inProgress', hungSuspect: false, anomalyType: 'repeated_error' });
    expect(reason).toBeNull();
  });

  test('inProgress with no signals at all → null', () => {
    expect(deriveStuckReason({ status: 'inProgress' })).toBeNull();
  });
});

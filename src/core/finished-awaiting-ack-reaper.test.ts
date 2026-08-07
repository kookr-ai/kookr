import { describe, it, expect } from 'vitest';
import { aSession, aTask } from './__fixtures__/task-builders.js';
import {
  DEFAULT_FAA_ACK_REAP_DEADLINE_MS,
  DEFAULT_FAA_ACK_REAP_GRACE_SECONDS,
  MIN_FAA_ACK_REAP_DEADLINE_MIN,
  MAX_FAA_ACK_REAP_DEADLINE_MIN,
  clampFaaAckReapDeadlineMinutes,
  isFinishedAwaitingAckCloseCandidate,
} from './finished-awaiting-ack-reaper.js';

describe('finished-awaiting-ack-reaper constants (issue #2170)', () => {
  it('defaults the deadline to 5m — tighter than the 15m strict TTL it front-runs', () => {
    expect(DEFAULT_FAA_ACK_REAP_DEADLINE_MS).toBe(5 * 60_000);
    // Ceiling is the strict TTL floor so this fast path can never be slower.
    expect(MAX_FAA_ACK_REAP_DEADLINE_MIN).toBe(15);
    expect(MIN_FAA_ACK_REAP_DEADLINE_MIN).toBe(1);
    expect(DEFAULT_FAA_ACK_REAP_GRACE_SECONDS).toBe(60);
  });

  it('clamps the deadline into [1, 15] minutes and rounds', () => {
    expect(clampFaaAckReapDeadlineMinutes(5)).toBe(5);
    expect(clampFaaAckReapDeadlineMinutes(0)).toBe(1);
    expect(clampFaaAckReapDeadlineMinutes(-10)).toBe(1);
    expect(clampFaaAckReapDeadlineMinutes(15)).toBe(15);
    expect(clampFaaAckReapDeadlineMinutes(99)).toBe(15);
    expect(clampFaaAckReapDeadlineMinutes(4.6)).toBe(5);
  });
});

describe('isFinishedAwaitingAckCloseCandidate (issue #2170)', () => {
  const faaSignal = { kind: 'completion_ready' as const, raisedAt: '2026-08-07T00:00:00.000Z' };

  it('is true for an in-progress task with a completion_ready signal', () => {
    expect(
      isFinishedAwaitingAckCloseCandidate(
        aTask({ status: 'inProgress', pendingSignal: faaSignal, sessions: [aSession({})] }),
      ),
    ).toBe(true);
  });

  it('is false when not in progress, even with the signal', () => {
    expect(
      isFinishedAwaitingAckCloseCandidate(
        aTask({ status: 'completed', pendingSignal: faaSignal, sessions: [aSession({})] }),
      ),
    ).toBe(false);
  });

  it('is false with no pending signal', () => {
    expect(
      isFinishedAwaitingAckCloseCandidate(
        aTask({ status: 'inProgress', pendingSignal: undefined, sessions: [aSession({})] }),
      ),
    ).toBe(false);
  });
});

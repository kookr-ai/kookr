import { describe, expect, it } from 'vitest';
import {
  decidePostRecoveryQueueFill,
  POST_RECOVERY_MIN_FREE_SLOTS,
  postRecoveryKickIdempotencyKey,
  utcDayKey,
} from './post-recovery-queue-fill.js';

const DAY = Date.parse('2026-08-10T12:00:00.000Z');

function base(overrides: Partial<Parameters<typeof decidePostRecoveryQueueFill>[0]> = {}) {
  return {
    free: 7,
    pendingQueueDepth: 0,
    dispatchHealthy: true,
    scoutOrBatchInFlight: false,
    lastKickUtcDay: null,
    repo: 'jeanibarz/lucy',
    nowMs: DAY,
    ...overrides,
  };
}

describe('utcDayKey', () => {
  it('returns YYYY-MM-DD in UTC', () => {
    expect(utcDayKey(DAY)).toBe('2026-08-10');
    // Near midnight UTC still previous day
    expect(utcDayKey(Date.parse('2026-08-10T00:00:00.000Z'))).toBe('2026-08-10');
    expect(utcDayKey(Date.parse('2026-08-09T23:59:59.000Z'))).toBe('2026-08-09');
  });
});

describe('decidePostRecoveryQueueFill', () => {
  it('kicks when free≥N, empty queue, healthy dispatch, nothing in flight, not yet today', () => {
    expect(decidePostRecoveryQueueFill(base())).toEqual({
      kick: true,
      utcDay: '2026-08-10',
    });
  });

  it(`uses free-slot floor of ${POST_RECOVERY_MIN_FREE_SLOTS}`, () => {
    expect(
      decidePostRecoveryQueueFill(base({ free: POST_RECOVERY_MIN_FREE_SLOTS - 1 })).kick,
    ).toBe(false);
    expect(
      decidePostRecoveryQueueFill(base({ free: POST_RECOVERY_MIN_FREE_SLOTS })).kick,
    ).toBe(true);
  });

  it('skips when pending queue is non-empty', () => {
    expect(decidePostRecoveryQueueFill(base({ pendingQueueDepth: 1 }))).toEqual({
      kick: false,
      reason: 'queue_not_empty',
      utcDay: '2026-08-10',
    });
  });

  it('skips when dispatch/auth is unhealthy', () => {
    expect(decidePostRecoveryQueueFill(base({ dispatchHealthy: false }))).toEqual({
      kick: false,
      reason: 'dispatch_unhealthy',
      utcDay: '2026-08-10',
    });
  });

  it('skips when scout or batch already active', () => {
    expect(decidePostRecoveryQueueFill(base({ scoutOrBatchInFlight: true }))).toEqual({
      kick: false,
      reason: 'scout_or_batch_in_flight',
      utcDay: '2026-08-10',
    });
  });

  it('skips when already kicked this UTC day (idempotent)', () => {
    expect(
      decidePostRecoveryQueueFill(base({ lastKickUtcDay: '2026-08-10' })),
    ).toEqual({
      kick: false,
      reason: 'already_kicked_utc_day',
      utcDay: '2026-08-10',
    });
  });

  it('allows kick again on a new UTC day', () => {
    expect(
      decidePostRecoveryQueueFill(
        base({
          lastKickUtcDay: '2026-08-09',
          nowMs: Date.parse('2026-08-10T01:00:00.000Z'),
        }),
      ),
    ).toEqual({ kick: true, utcDay: '2026-08-10' });
  });

  it('skips empty repo', () => {
    expect(decidePostRecoveryQueueFill(base({ repo: '  ' }))).toEqual({
      kick: false,
      reason: 'no_repo',
      utcDay: '2026-08-10',
    });
  });
});

describe('postRecoveryKickIdempotencyKey', () => {
  it('is stable per repo + UTC day', () => {
    expect(postRecoveryKickIdempotencyKey('jeanibarz/lucy', '2026-08-10')).toBe(
      'post-recovery-queue-fill:jeanibarz-lucy:2026-08-10',
    );
  });
});

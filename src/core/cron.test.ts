import { describe, it, expect } from 'vitest';
import {
  nextRun,
  isValidCron,
  describeCron,
  isPracticalCron,
  minimumCronIntervalMs,
} from './cron.js';

describe('nextRun', () => {
  it('returns the next minute for * * * * *', () => {
    const after = new Date('2026-04-01T12:00:00Z');
    const result = nextRun('* * * * *', after);
    expect(result).toEqual(new Date('2026-04-01T12:01:00Z'));
  });

  it('returns next midnight for 0 0 * * * (local time)', () => {
    const after = new Date('2026-04-01T12:00:00Z');
    const result = nextRun('0 0 * * *', after)!;
    // cron-parser uses local timezone — just verify it's after the reference and at minute 0
    expect(result.getTime()).toBeGreaterThan(after.getTime());
    expect(result.getMinutes()).toBe(0);
  });

  it('returns null for invalid expression', () => {
    expect(nextRun('not a cron')).toBeNull();
  });

  it('handles every-5-minutes', () => {
    const after = new Date('2026-04-01T12:03:00Z');
    const result = nextRun('*/5 * * * *', after);
    expect(result).toEqual(new Date('2026-04-01T12:05:00Z'));
  });
});

describe('isValidCron', () => {
  it('accepts valid expressions', () => {
    expect(isValidCron('0 0 * * *')).toBe(true);
    expect(isValidCron('*/5 * * * *')).toBe(true);
    expect(isValidCron('30 9 * * 1')).toBe(true);
  });

  it('rejects invalid expressions', () => {
    expect(isValidCron('not valid')).toBe(false);
    expect(isValidCron('abc def ghi jkl mno')).toBe(false);
  });
});

describe('minimumCronIntervalMs', () => {
  it('finds one-minute intervals for every-minute schedules', () => {
    expect(minimumCronIntervalMs('* * * * *')).toBe(60_000);
    expect(minimumCronIntervalMs('*/1 * * * *')).toBe(60_000);
  });

  it('accepts the five-minute boundary as practical', () => {
    expect(minimumCronIntervalMs('*/5 * * * *')).toBe(5 * 60_000);
    expect(isPracticalCron('*/5 * * * *')).toBe(true);
  });

  it('rejects expressions below the practical interval threshold', () => {
    expect(isPracticalCron('* * * * *')).toBe(false);
    expect(isPracticalCron('*/4 * * * *')).toBe(false);
    expect(isPracticalCron('0,1 * * * *')).toBe(false);
    expect(isPracticalCron('0-4 * * * *')).toBe(false);
  });

  it('catches a sub-threshold gap late in a dense minute list', () => {
    expect(minimumCronIntervalMs('0,5,10,15,20,25,30,35,40,45,50,55,56 * * * *')).toBe(60_000);
  });

  it('uses a stable hash seed for H expressions', () => {
    const cron = 'H(0-3),59 * * * *';

    expect(Array.from({ length: 5 }, () => minimumCronIntervalMs(cron))).toEqual([
      3 * 60_000,
      3 * 60_000,
      3 * 60_000,
      3 * 60_000,
      3 * 60_000,
    ]);
    expect(isPracticalCron(cron)).toBe(false);
  });

  it('accepts hourly and daily schedules as practical', () => {
    expect(isPracticalCron('0 * * * *')).toBe(true);
    expect(isPracticalCron('0 9 * * *')).toBe(true);
  });

  it('handles sparse schedules without iterating future fire dates', () => {
    expect(minimumCronIntervalMs('0 0 29 2 *')).toBe(24 * 60 * 60_000);
    expect(isPracticalCron('0 0 29 2 *')).toBe(true);
  });

  it('returns null for invalid expressions', () => {
    expect(minimumCronIntervalMs('not a cron')).toBeNull();
  });
});

describe('describeCron', () => {
  it('describes every minute', () => {
    expect(describeCron('* * * * *')).toBe('Every minute');
  });

  it('describes every N minutes', () => {
    expect(describeCron('*/5 * * * *')).toBe('Every 5 minutes');
  });

  it('describes every N hours', () => {
    expect(describeCron('0 */6 * * *')).toBe('Every 6 hours');
  });

  it('describes daily at specific time', () => {
    expect(describeCron('0 0 * * *')).toBe('Daily at 00:00');
    expect(describeCron('30 9 * * *')).toBe('Daily at 09:30');
  });

  it('describes weekly on a day', () => {
    expect(describeCron('0 9 * * 1')).toBe('Every Mon at 09:00');
  });

  it('describes both Sunday day-of-week aliases', () => {
    expect(describeCron('0 9 * * 0')).toBe('Every Sun at 09:00');
    expect(describeCron('0 9 * * 7')).toBe('Every Sun at 09:00');
  });

  it('preserves non-alias day-of-week labels', () => {
    expect(describeCron('0 9 * * 1-5')).toBe('Every 1-5 at 09:00');
    expect(describeCron('0 9 * * 1,3,5')).toBe('Every 1,3,5 at 09:00');
    expect(describeCron('0 9 * * 8')).toBe('Every 8 at 09:00');
  });

  it('describes monthly', () => {
    expect(describeCron('0 0 15 * *')).toBe('Monthly on day 15 at 00:00');
  });

  it('falls back to raw expression for complex patterns', () => {
    expect(describeCron('0 9 * 1-6 1,3,5')).toBe('0 9 * 1-6 1,3,5');
  });
});

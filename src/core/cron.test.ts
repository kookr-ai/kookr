import { describe, it, expect } from 'vitest';
import { nextRun, isValidCron, describeCron } from './cron.js';

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

  it('describes monthly', () => {
    expect(describeCron('0 0 15 * *')).toBe('Monthly on day 15 at 00:00');
  });

  it('falls back to raw expression for complex patterns', () => {
    expect(describeCron('0 9 * 1-6 1,3,5')).toBe('0 9 * 1-6 1,3,5');
  });
});

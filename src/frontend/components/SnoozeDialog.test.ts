import { describe, expect, test } from 'vitest';
import { msUntilClockTime, END_OF_DAY } from './SnoozeDialog.js';

// Fixed reference instant: 2026-08-12 10:00:00 local time.
const NOW = new Date(2026, 7, 12, 10, 0, 0, 0).getTime();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('msUntilClockTime', () => {
  test('a later time today is exactly targetTime - now', () => {
    // 10:00 → 11:30 is 90 minutes away.
    expect(msUntilClockTime('11:30', NOW)).toBe(90 * MIN);
  });

  test('a time earlier than now rolls forward to the next day', () => {
    // 10:00 → 09:00 already passed today, so it resolves to 09:00 tomorrow (23h).
    expect(msUntilClockTime('09:00', NOW)).toBe(23 * HOUR);
  });

  test('a time exactly equal to now is non-positive before rollover → rolls to tomorrow (24h)', () => {
    // targetTime - now === 0; the non-positive guard rolls it a full day forward.
    expect(msUntilClockTime('10:00', NOW)).toBe(DAY);
  });

  test('the result is always strictly positive for a valid time', () => {
    for (const t of ['00:00', '10:00', '10:01', '09:59', '23:59']) {
      const ms = msUntilClockTime(t, NOW);
      expect(ms).not.toBeNull();
      expect(ms as number).toBeGreaterThan(0);
    }
  });

  test('END_OF_DAY resolves to 23:59 today when now is earlier', () => {
    // 10:00 → 23:59 is 13h59m away.
    expect(msUntilClockTime(END_OF_DAY, NOW)).toBe(13 * HOUR + 59 * MIN);
  });

  test('returns null for unparseable input', () => {
    for (const bad of ['', 'noon', '9', '9am', '10:5', '10-30', '10:00:00']) {
      expect(msUntilClockTime(bad, NOW)).toBeNull();
    }
  });

  test('returns null for out-of-range hours or minutes', () => {
    expect(msUntilClockTime('24:00', NOW)).toBeNull();
    expect(msUntilClockTime('10:60', NOW)).toBeNull();
    expect(msUntilClockTime('99:99', NOW)).toBeNull();
  });

  test('tolerates surrounding whitespace', () => {
    expect(msUntilClockTime('  11:30  ', NOW)).toBe(90 * MIN);
  });

  test('rollover advances the calendar day (DST-safe), not a fixed 24h', () => {
    // In a non-DST window, rolling "09:00" forward from 10:00 is exactly 23h.
    // The value comes from calendar arithmetic (setDate + getTime), so on a DST
    // transition night it tracks the wall-clock time rather than a fixed 24h.
    expect(msUntilClockTime('09:00', NOW)).toBe(23 * HOUR);
    // Sanity: the rolled target lands on the next calendar day at the given time.
    const rolled = new Date(NOW + (msUntilClockTime('09:00', NOW) as number));
    expect(rolled.getHours()).toBe(9);
    expect(rolled.getMinutes()).toBe(0);
    expect(rolled.getDate()).toBe(new Date(NOW).getDate() + 1);
  });
});

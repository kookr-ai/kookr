import { describe, it, expect } from 'vitest';
import {
  parseHhMm,
  validateQuietHours,
  MAX_QUIET_HOURS_WINDOWS,
  type QuietHoursWindow,
} from './quiet-hours.js';

/**
 * Characterization tests for the untrusted-config sanitizer `validateQuietHours`
 * (and its `parseHhMm` helper). These pin the *silent* invariants that reshape
 * user settings — invalid times dropped, ambiguous `start === end` rejected, the
 * window cap, and day-list normalization — asserting both the returned windows
 * *and* the `warnings` array so a regression can't silently discard a user's
 * quiet-hours without a test failing.
 */

describe('parseHhMm', () => {
  it('parses valid HH:MM to minutes since local midnight', () => {
    expect(parseHhMm('00:00')).toBe(0);
    expect(parseHhMm('00:01')).toBe(1);
    expect(parseHhMm('01:00')).toBe(60);
    expect(parseHhMm('22:00')).toBe(22 * 60);
    expect(parseHhMm('23:59')).toBe(23 * 60 + 59);
  });

  it('returns null for out-of-range hours or minutes', () => {
    expect(parseHhMm('24:00')).toBeNull();
    expect(parseHhMm('25:00')).toBeNull();
    expect(parseHhMm('12:60')).toBeNull();
    expect(parseHhMm('12:99')).toBeNull();
  });

  it('returns null for malformed strings', () => {
    expect(parseHhMm('')).toBeNull();
    expect(parseHhMm('9:00')).toBeNull(); // hour must be zero-padded
    expect(parseHhMm('09:5')).toBeNull(); // minute must be zero-padded
    expect(parseHhMm('1200')).toBeNull(); // missing separator
    expect(parseHhMm('ab:cd')).toBeNull();
    expect(parseHhMm('12:00:00')).toBeNull(); // trailing seconds rejected
    expect(parseHhMm(' 12:00')).toBeNull(); // leading whitespace rejected
  });
});

describe('validateQuietHours', () => {
  describe('non-array / absent input', () => {
    it('returns empty windows and no warnings when undefined', () => {
      expect(validateQuietHours(undefined)).toEqual({ windows: [], warnings: [] });
    });

    it('rejects a non-array value with a warning', () => {
      expect(validateQuietHours(null)).toEqual({
        windows: [],
        warnings: ['quietHours must be an array of windows; ignoring'],
      });
      expect(validateQuietHours({ start: '22:00', end: '08:00' })).toEqual({
        windows: [],
        warnings: ['quietHours must be an array of windows; ignoring'],
      });
      expect(validateQuietHours('nope')).toEqual({
        windows: [],
        warnings: ['quietHours must be an array of windows; ignoring'],
      });
    });

    it('returns empty windows and no warnings for an empty array', () => {
      expect(validateQuietHours([])).toEqual({ windows: [], warnings: [] });
    });
  });

  describe('happy path', () => {
    it('keeps a valid same-day window with no days key', () => {
      const result = validateQuietHours([{ start: '12:00', end: '13:00' }]);
      expect(result.windows).toEqual([{ start: '12:00', end: '13:00' }]);
      expect(result.warnings).toEqual([]);
    });

    it('keeps a valid wrap-past-midnight window', () => {
      const result = validateQuietHours([{ start: '22:00', end: '08:00' }]);
      expect(result.windows).toEqual([{ start: '22:00', end: '08:00' }]);
      expect(result.warnings).toEqual([]);
    });

    it('keeps a partial days subset (sorted, deduped) and no warning', () => {
      const result = validateQuietHours([{ start: '22:00', end: '08:00', days: [5, 1, 5, 3] }]);
      expect(result.windows).toEqual([{ start: '22:00', end: '08:00', days: [1, 3, 5] }]);
      expect(result.warnings).toEqual([]);
    });

    it('preserves multiple valid windows in order', () => {
      const result = validateQuietHours([
        { start: '00:00', end: '06:00' },
        { start: '13:00', end: '14:00', days: [1, 2, 3, 4, 5] },
      ]);
      expect(result.windows).toEqual([
        { start: '00:00', end: '06:00' },
        { start: '13:00', end: '14:00', days: [1, 2, 3, 4, 5] },
      ]);
      expect(result.warnings).toEqual([]);
    });
  });

  describe('per-entry drops', () => {
    it('drops a non-object entry with a warning', () => {
      const result = validateQuietHours([null, 'x', 42, { start: '01:00', end: '02:00' }]);
      expect(result.windows).toEqual([{ start: '01:00', end: '02:00' }]);
      expect(result.warnings).toEqual([
        'quietHours window must be an object; ignoring',
        'quietHours window must be an object; ignoring',
        'quietHours window must be an object; ignoring',
      ]);
    });

    it('drops a window whose start time is invalid, echoing the raw times', () => {
      const result = validateQuietHours([{ start: '25:00', end: '08:00' }]);
      expect(result.windows).toEqual([]);
      expect(result.warnings).toEqual([
        `quietHours window has invalid time(s) ${JSON.stringify({ start: '25:00', end: '08:00' })}; ignoring`,
      ]);
    });

    it('drops a window whose end time is invalid', () => {
      const result = validateQuietHours([{ start: '22:00', end: 'nope' }]);
      expect(result.windows).toEqual([]);
      expect(result.warnings).toEqual([
        `quietHours window has invalid time(s) ${JSON.stringify({ start: '22:00', end: 'nope' })}; ignoring`,
      ]);
    });

    it('drops a window with missing / non-string times (coerced to empty, invalid)', () => {
      const result = validateQuietHours([
        { end: '08:00' }, // missing start
        { start: 5, end: '08:00' }, // non-string start
        { start: '22:00' }, // missing end
        { start: '22:00', end: 5 }, // non-string end
      ]);
      expect(result.windows).toEqual([]);
      expect(result.warnings).toEqual([
        `quietHours window has invalid time(s) ${JSON.stringify({ start: undefined, end: '08:00' })}; ignoring`,
        `quietHours window has invalid time(s) ${JSON.stringify({ start: 5, end: '08:00' })}; ignoring`,
        `quietHours window has invalid time(s) ${JSON.stringify({ start: '22:00', end: undefined })}; ignoring`,
        `quietHours window has invalid time(s) ${JSON.stringify({ start: '22:00', end: 5 })}; ignoring`,
      ]);
    });

    it('treats an array entry as a time-invalid window, not a non-object drop', () => {
      // `typeof [] === 'object'` so an array slips past the "must be an object"
      // guard and falls into the invalid-time path (its start/end are undefined).
      const result = validateQuietHours([['x', 'y'], { start: '01:00', end: '02:00' }]);
      expect(result.windows).toEqual([{ start: '01:00', end: '02:00' }]);
      expect(result.warnings).toEqual([
        `quietHours window has invalid time(s) ${JSON.stringify({ start: undefined, end: undefined })}; ignoring`,
      ]);
    });

    it('rejects an ambiguous start === end window', () => {
      const result = validateQuietHours([{ start: '09:00', end: '09:00' }]);
      expect(result.windows).toEqual([]);
      expect(result.warnings).toEqual([
        'quietHours window start equals end (09:00); ignoring ambiguous window',
      ]);
    });
  });

  describe('day-list normalization', () => {
    it('collapses an empty days array to "every day" (days omitted) with no warning', () => {
      const result = validateQuietHours([{ start: '22:00', end: '08:00', days: [] }]);
      expect(result.windows).toEqual([{ start: '22:00', end: '08:00' }]);
      expect(result.warnings).toEqual([]);
    });

    it('collapses a full 7-element days array to "every day" (days omitted)', () => {
      const result = validateQuietHours([
        { start: '22:00', end: '08:00', days: [0, 1, 2, 3, 4, 5, 6] },
      ]);
      expect(result.windows).toEqual([{ start: '22:00', end: '08:00' }]);
      expect(result.warnings).toEqual([]);
    });

    it('treats explicit null days as "every day" with no warning', () => {
      const result = validateQuietHours([{ start: '22:00', end: '08:00', days: null }]);
      expect(result.windows).toEqual([{ start: '22:00', end: '08:00' }]);
      expect(result.warnings).toEqual([]);
    });

    it('warns and ignores days when it is not an array', () => {
      const result = validateQuietHours([{ start: '22:00', end: '08:00', days: 5 }]);
      expect(result.windows).toEqual([{ start: '22:00', end: '08:00' }]);
      expect(result.warnings).toEqual([
        'quietHours window "days" must be an array of 0-6; ignoring',
      ]);
    });

    it('drops invalid day entries, keeps the valid ones, and warns', () => {
      const result = validateQuietHours([
        { start: '22:00', end: '08:00', days: [1, 7, -1, 2.5, '3', 4] },
      ]);
      expect(result.windows).toEqual([{ start: '22:00', end: '08:00', days: [1, 4] }]);
      expect(result.warnings).toEqual([
        'quietHours window "days" had invalid entries; dropped',
      ]);
    });

    it('collapses to "every day" when every day entry is invalid, and warns', () => {
      const result = validateQuietHours([
        { start: '22:00', end: '08:00', days: ['x', 9, null] },
      ]);
      expect(result.windows).toEqual([{ start: '22:00', end: '08:00' }]);
      expect(result.warnings).toEqual([
        'quietHours window "days" had invalid entries; dropped',
      ]);
    });
  });

  describe('window cap', () => {
    it('caps at MAX_QUIET_HOURS_WINDOWS and warns once', () => {
      const many: QuietHoursWindow[] = Array.from({ length: MAX_QUIET_HOURS_WINDOWS + 5 }, () => ({
        start: '01:00',
        end: '02:00',
      }));
      const result = validateQuietHours(many);
      expect(result.windows).toHaveLength(MAX_QUIET_HOURS_WINDOWS);
      expect(result.warnings).toEqual([
        `quietHours capped at ${MAX_QUIET_HOURS_WINDOWS} windows; extra windows ignored`,
      ]);
    });

    it('counts only kept windows toward the cap (dropped windows do not consume budget)', () => {
      // Interleave invalid entries: they warn+continue without consuming a slot,
      // so all 20 valid windows still fit under the cap with no cap warning.
      const entries: unknown[] = [];
      for (let i = 0; i < MAX_QUIET_HOURS_WINDOWS; i++) {
        entries.push({ start: '09:00', end: '09:00' }); // ambiguous, dropped
        entries.push({ start: '01:00', end: '02:00' }); // valid, kept
      }
      const result = validateQuietHours(entries);
      expect(result.windows).toHaveLength(MAX_QUIET_HOURS_WINDOWS);
      // Exactly one ambiguous warning per dropped entry, and no cap warning —
      // asserted in full so an unrelated extra warning can't slip through.
      expect(result.warnings).toEqual(
        Array(MAX_QUIET_HOURS_WINDOWS).fill(
          'quietHours window start equals end (09:00); ignoring ambiguous window',
        ),
      );
    });
  });
});

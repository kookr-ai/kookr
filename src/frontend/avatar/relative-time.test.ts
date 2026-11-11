import { describe, expect, test } from 'vitest';
import { formatRelativeTime } from './relative-time.js';

const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const D = 24 * H;
const NOW = 1_700_000_000_000;
const ago = (ms: number) => formatRelativeTime(NOW - ms, NOW);

describe('formatRelativeTime', () => {
  test('under a minute is "just now", including 0 s and 59 s', () => {
    expect(ago(0)).toBe('just now');
    expect(ago(59 * S)).toBe('just now');
    expect(ago(59 * S + 999)).toBe('just now');
  });

  test('60 s is the first minute', () => {
    expect(ago(60 * S)).toBe('1 min ago');
    expect(ago(119 * S)).toBe('1 min ago');
    expect(ago(120 * S)).toBe('2 min ago');
  });

  test('59 min is still minutes, 60 min is the first hour', () => {
    expect(ago(59 * MIN)).toBe('59 min ago');
    expect(ago(60 * MIN - 1)).toBe('59 min ago');
    expect(ago(60 * MIN)).toBe('1 h ago');
    expect(ago(90 * MIN)).toBe('1 h ago');
  });

  test('23 h is still hours, 24 h is the first day', () => {
    expect(ago(23 * H)).toBe('23 h ago');
    expect(ago(24 * H - 1)).toBe('23 h ago');
    expect(ago(24 * H)).toBe('1 d ago');
    expect(ago(3 * D + 5 * H)).toBe('3 d ago');
  });

  test('a time in the future (clock moved back) counts as "just now"', () => {
    expect(formatRelativeTime(NOW + 5 * MIN, NOW)).toBe('just now');
  });
});

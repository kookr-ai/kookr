import { describe, test, expect } from 'vitest';
import { bandFor } from './context-feedback.js';

describe('bandFor', () => {
  describe('default cycler triggerRatio = 0.75', () => {
    const T = 0.75;
    const M = T * (2 / 3); // 0.50

    test('below MODERATE returns 0', () => {
      expect(bandFor(0.0, T)).toBe(0);
      expect(bandFor(0.1, T)).toBe(0);
      expect(bandFor(0.49, T)).toBe(0);
      expect(bandFor(M - 0.0001, T)).toBe(0);
    });

    test('exactly at MODERATE returns 50 (inclusive boundary)', () => {
      expect(bandFor(M, T)).toBe(50);
    });

    test('between MODERATE and CRITICAL returns 50', () => {
      expect(bandFor(0.51, T)).toBe(50);
      expect(bandFor(0.6, T)).toBe(50);
      expect(bandFor(0.74999, T)).toBe(50);
    });

    test('exactly at CRITICAL (triggerRatio) returns 0 — cycler territory', () => {
      expect(bandFor(T, T)).toBe(0);
    });

    test('above CRITICAL returns 0 — cycler territory', () => {
      expect(bandFor(0.8, T)).toBe(0);
      expect(bandFor(0.95, T)).toBe(0);
      expect(bandFor(1.0, T)).toBe(0);
      expect(bandFor(1.5, T)).toBe(0); // overshoots are bounded by cycler-territory rule
    });
  });

  describe('cycler triggerRatio scaling', () => {
    test('triggerRatio = 0.6 makes MODERATE = 0.4', () => {
      const T = 0.6;
      expect(bandFor(0.39, T)).toBe(0);
      expect(bandFor(0.4, T)).toBe(50);
      expect(bandFor(0.55, T)).toBe(50);
      expect(bandFor(0.6, T)).toBe(0); // cycler territory
    });

    test('triggerRatio = 0.9 makes MODERATE = 0.6', () => {
      const T = 0.9;
      expect(bandFor(0.59, T)).toBe(0);
      expect(bandFor(0.6, T)).toBe(50);
      expect(bandFor(0.85, T)).toBe(50);
      expect(bandFor(0.9, T)).toBe(0); // cycler territory
    });
  });

  describe('invalid inputs return 0 (fail-safe)', () => {
    test('NaN ratio', () => {
      expect(bandFor(Number.NaN, 0.75)).toBe(0);
    });

    test('Infinity ratio', () => {
      expect(bandFor(Number.POSITIVE_INFINITY, 0.75)).toBe(0);
    });

    test('NaN triggerRatio', () => {
      expect(bandFor(0.6, Number.NaN)).toBe(0);
    });

    test('negative ratio', () => {
      expect(bandFor(-0.1, 0.75)).toBe(0);
    });

    test('zero ratio', () => {
      expect(bandFor(0, 0.75)).toBe(0);
    });

    test('zero triggerRatio', () => {
      expect(bandFor(0.5, 0)).toBe(0);
    });

    test('negative triggerRatio', () => {
      expect(bandFor(0.5, -0.5)).toBe(0);
    });

    test('triggerRatio > 1', () => {
      expect(bandFor(0.5, 1.5)).toBe(0);
    });

    test('triggerRatio = 1 is allowed (degenerate but not invalid)', () => {
      // MODERATE = 2/3 ≈ 0.6667
      expect(bandFor(0.6, 1)).toBe(0);
      expect(bandFor(0.7, 1)).toBe(50);
      expect(bandFor(1, 1)).toBe(0); // cycler territory at exactly 1
    });
  });
});

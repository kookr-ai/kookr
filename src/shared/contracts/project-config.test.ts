import { describe, expect, test } from 'vitest';
import { sanitizeProjectConfig } from './project-config.js';

describe('sanitizeProjectConfig', () => {
  test('requires a non-empty project string', () => {
    expect(sanitizeProjectConfig(null)).toBeNull();
    expect(sanitizeProjectConfig({})).toBeNull();
    expect(sanitizeProjectConfig({ project: '' })).toBeNull();
    expect(sanitizeProjectConfig({ project: '   ' })).toBeNull();
    expect(sanitizeProjectConfig({ project: 'github.com/org/repo' })?.project).toBe(
      'github.com/org/repo',
    );
  });

  test('accepts non-negative integer PR limits including zero', () => {
    const config = sanitizeProjectConfig({
      project: 'github.com/org/repo',
      dailyPrLimit: 0,
      weeklyPrLimit: 10,
    });
    expect(config).toEqual({
      project: 'github.com/org/repo',
      dailyPrLimit: 0,
      weeklyPrLimit: 10,
    });
  });

  test('drops Infinity, NaN, negative, and fractional PR limits', () => {
    const invalid = [Infinity, -Infinity, NaN, -1, -0.5, 1.5, 3.7];
    for (const value of invalid) {
      const config = sanitizeProjectConfig({
        project: 'p',
        dailyPrLimit: value,
        weeklyPrLimit: value,
      });
      expect(config).toEqual({ project: 'p' });
      expect(config?.dailyPrLimit).toBeUndefined();
      expect(config?.weeklyPrLimit).toBeUndefined();
    }

    // JSON-parsed 1e400 becomes Infinity (documented attack surface).
    const fromJson = JSON.parse('{"project":"p","dailyPrLimit":1e400,"weeklyPrLimit":1e400}');
    expect(fromJson.dailyPrLimit).toBe(Infinity);
    expect(sanitizeProjectConfig(fromJson)).toEqual({ project: 'p' });
  });

  test('drops non-number PR limit types without affecting other fields', () => {
    const config = sanitizeProjectConfig({
      project: 'p',
      dailyPrLimit: '3' as unknown as number,
      weeklyPrLimit: null as unknown as number,
      notes: 'keep me',
      tracked: true,
    });
    expect(config).toEqual({
      project: 'p',
      notes: 'keep me',
      tracked: true,
    });
  });

  test('clamps negative budgetWarnUsd to 0 and accepts finite values including 0', () => {
    expect(sanitizeProjectConfig({ project: 'p', budgetWarnUsd: 7.5 })?.budgetWarnUsd).toBe(7.5);
    expect(sanitizeProjectConfig({ project: 'p', budgetWarnUsd: 0 })?.budgetWarnUsd).toBe(0);
    expect(sanitizeProjectConfig({ project: 'p', budgetWarnUsd: -1 })?.budgetWarnUsd).toBe(0);
  });

  test('drops non-finite budgetWarnUsd', () => {
    expect(sanitizeProjectConfig({ project: 'p', budgetWarnUsd: Infinity })?.budgetWarnUsd).toBeUndefined();
    expect(sanitizeProjectConfig({ project: 'p', budgetWarnUsd: NaN })?.budgetWarnUsd).toBeUndefined();
  });
});

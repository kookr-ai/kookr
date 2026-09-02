import { describe, expect, test } from 'vitest';
import { MAX_PROJECT_NOTES_LENGTH, sanitizeProjectConfig } from './project-config.js';

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

  test('TS-EMISSION-001: accepts -1 only for the zero-drain issue limit', () => {
    expect(sanitizeProjectConfig({
      project: 'github.com/org/repo',
      zeroDrainIssueLimit: -1,
    })?.zeroDrainIssueLimit).toBe(-1);
    expect(sanitizeProjectConfig({
      project: 'github.com/org/repo',
      zeroDrainIssueLimit: -2,
    })?.zeroDrainIssueLimit).toBeUndefined();
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

  test('sanitizes daily and weekly PR limits independently', () => {
    expect(
      sanitizeProjectConfig({ project: 'p', dailyPrLimit: 1.5, weeklyPrLimit: 4 }),
    ).toEqual({ project: 'p', weeklyPrLimit: 4 });
    expect(
      sanitizeProjectConfig({ project: 'p', dailyPrLimit: 2, weeklyPrLimit: Infinity }),
    ).toEqual({ project: 'p', dailyPrLimit: 2 });
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

  test('truncates an over-cap notes string to the leading maximum-length characters', () => {
    // Heterogeneous head/tail so the assertion distinguishes front-truncation
    // (slice(0, cap)) from a wrong-end variant like slice(-cap)/substring(n).
    const head = 'HEAD';
    const overCap = head + 'x'.repeat(MAX_PROJECT_NOTES_LENGTH) + 'TAIL';
    const config = sanitizeProjectConfig({ project: 'p', notes: overCap });
    expect(config?.notes).toHaveLength(MAX_PROJECT_NOTES_LENGTH);
    expect(config?.notes?.startsWith(head)).toBe(true);
    expect(config?.notes).not.toContain('TAIL');
    expect(config?.notes).toBe(overCap.slice(0, MAX_PROJECT_NOTES_LENGTH));
  });

  test('stores an at-cap notes string unchanged', () => {
    const atCap = 'b'.repeat(MAX_PROJECT_NOTES_LENGTH);
    const config = sanitizeProjectConfig({ project: 'p', notes: atCap });
    expect(config?.notes).toBe(atCap);
    expect(config?.notes).toHaveLength(MAX_PROJECT_NOTES_LENGTH);
  });

  test('stores an under-cap notes string unchanged without affecting other fields', () => {
    const config = sanitizeProjectConfig({
      project: 'p',
      notes: 'a normal project note',
      tracked: true,
      dailyPrLimit: 5,
    });
    expect(config).toEqual({
      project: 'p',
      notes: 'a normal project note',
      tracked: true,
      dailyPrLimit: 5,
    });
  });

  test('keeps automationEnabled false (typeof === boolean, not truthy)', () => {
    expect(sanitizeProjectConfig({ project: 'p', automationEnabled: false })).toEqual({
      project: 'p',
      automationEnabled: false,
    });
    expect(sanitizeProjectConfig({ project: 'p', automationEnabled: true })?.automationEnabled).toBe(true);
  });

  test('drops a non-boolean automationEnabled (omit = allowed)', () => {
    expect(sanitizeProjectConfig({ project: 'p', automationEnabled: 'false' as unknown as boolean }))
      .toEqual({ project: 'p' });
    expect(sanitizeProjectConfig({ project: 'p', automationEnabled: 0 as unknown as boolean }))
      .toEqual({ project: 'p' });
  });

  test('a notes patch through sanitize preserves automationEnabled false', () => {
    const paused = sanitizeProjectConfig({
      project: 'github.com/jeanibarz/lucy',
      automationEnabled: false,
      automationPausedSince: '2026-09-03T00:00:00.000Z',
      notes: 'old',
    });
    expect(sanitizeProjectConfig({ ...paused, notes: 'new' })).toEqual({
      project: 'github.com/jeanibarz/lucy',
      automationEnabled: false,
      automationPausedSince: '2026-09-03T00:00:00.000Z',
      notes: 'new',
    });
  });
});

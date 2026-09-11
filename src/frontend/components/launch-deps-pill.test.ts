import { describe, expect, test } from 'vitest';
import {
  formatLaunchDepsLabel,
  formatLaunchDepsTitle,
  shouldShowLaunchDepsPill,
} from './launch-deps-pill.js';

describe('launch-deps-pill helpers (issue #2364)', () => {
  test('shouldShowLaunchDepsPill is elevated-only', () => {
    expect(shouldShowLaunchDepsPill(null)).toBe(false);
    expect(shouldShowLaunchDepsPill(undefined)).toBe(false);
    expect(shouldShowLaunchDepsPill({ totalDegradedTasks: 0, dependencies: [] })).toBe(false);
    expect(shouldShowLaunchDepsPill({ totalDegradedTasks: 1, dependencies: [] })).toBe(true);
    expect(shouldShowLaunchDepsPill({ totalDegradedTasks: 0, dependencies: [], parkedTaskCount: 2 })).toBe(true);
  });

  test('formatLaunchDepsLabel prefers dependency×count segments', () => {
    expect(formatLaunchDepsLabel({
      totalDegradedTasks: 8,
      dependencies: [
        { dependency: 'kb', degradedTaskCount: 8, categories: ['provider_api'] },
      ],
    })).toBe('Deps: kb×8');

    expect(formatLaunchDepsLabel({
      totalDegradedTasks: 3,
      dependencies: [
        { dependency: 'kb', degradedTaskCount: 2, categories: [] },
        { dependency: 'gh', degradedTaskCount: 1, categories: ['auth'] },
      ],
    })).toBe('Deps: kb×2 · gh×1');

    expect(formatLaunchDepsLabel({
      totalDegradedTasks: 5,
      dependencies: [],
    })).toBe('Deps: 5');
  });

  test('formatLaunchDepsTitle lists categories and health pointer', () => {
    const title = formatLaunchDepsTitle({
      totalDegradedTasks: 8,
      totalFindings: 9,
      dependencies: [
        { dependency: 'kb', degradedTaskCount: 8, categories: ['provider_api'] },
      ],
    });
    expect(title).toContain('8 tasks launched with degraded dependencies');
    expect(title).toContain('findings=9');
    expect(title).toContain('kb=8 (provider_api)');
    expect(title).toContain('GET /api/health.launchDependencies');
  });

  test('formats parked work separately from launched degraded work', () => {
    const status = {
      totalDegradedTasks: 0,
      dependencies: [],
      parkedTaskCount: 2,
      parkedByDependency: [{ dependency: 'kb', taskCount: 2, reasons: ['provider down'] }],
    };

    expect(formatLaunchDepsLabel(status)).toBe('Deps: 0 · Parked: kb×2');
    const title = formatLaunchDepsTitle(status);
    expect(title).toContain('2 tasks parked awaiting dependency recovery');
    expect(title).toContain('kb=2 (provider down)');
  });

  test('keeps parked-only status visible when dependency rows are unavailable', () => {
    expect(formatLaunchDepsLabel({
      totalDegradedTasks: 0,
      dependencies: [],
      parkedTaskCount: 3,
    })).toBe('Deps: 0 · Parked: 3');
  });
});

describe('confirmed vs unknown launch-dependency split (issue #3153)', () => {
  test('does NOT elevate for unknown-only findings (confirmed=0, unknown>0)', () => {
    // Live gap: totalDegradedTasks=136 == totalUnknownTasks=136 from a kb probe
    // that could not be bounded — the truthful state is "probe unavailable",
    // not "degraded", so the degradation pill must stay hidden.
    expect(shouldShowLaunchDepsPill({
      totalDegradedTasks: 136,
      totalUnknownTasks: 136,
      dependencies: [{ dependency: 'kb', degradedTaskCount: 136, categories: ['unknown'] }],
    })).toBe(false);
  });

  test('elevates when there is confirmed degradation, even alongside unknowns', () => {
    expect(shouldShowLaunchDepsPill({
      totalDegradedTasks: 10,
      totalConfirmedDegradedTasks: 4,
      totalUnknownTasks: 6,
      dependencies: [{ dependency: 'kb', degradedTaskCount: 10, categories: ['provider_api', 'unknown'] }],
    })).toBe(true);
  });

  test('still elevates for unknown-only when parked work is present', () => {
    expect(shouldShowLaunchDepsPill({
      totalDegradedTasks: 5,
      totalUnknownTasks: 5,
      dependencies: [],
      parkedTaskCount: 2,
    })).toBe(true);
  });

  test('falls back to the conflated total for an older server without the split', () => {
    expect(shouldShowLaunchDepsPill({
      totalDegradedTasks: 8,
      dependencies: [{ dependency: 'kb', degradedTaskCount: 8, categories: ['provider_api'] }],
    })).toBe(true);
  });

  test('tooltip distinguishes confirmed-degraded from unknown counts', () => {
    const title = formatLaunchDepsTitle({
      totalDegradedTasks: 136,
      totalUnknownTasks: 136,
      dependencies: [{ dependency: 'kb', degradedTaskCount: 136, categories: ['unknown'] }],
    });
    expect(title).toContain('0 confirmed degraded, 136 unknown (probe unavailable)');
    expect(title).not.toContain('launched with degraded dependencies');
    expect(title).toContain('kb=136 (unknown)');
    expect(title).toContain('GET /api/health.launchDependencies');
  });

  test('tooltip reports both confirmed and unknown when both are present', () => {
    const title = formatLaunchDepsTitle({
      totalDegradedTasks: 10,
      totalConfirmedDegradedTasks: 4,
      totalUnknownTasks: 6,
      dependencies: [],
    });
    expect(title).toContain('4 confirmed degraded, 6 unknown (probe unavailable)');
  });

  test('tooltip keeps the legacy phrasing for an older server without the split', () => {
    const title = formatLaunchDepsTitle({
      totalDegradedTasks: 8,
      dependencies: [],
    });
    expect(title).toContain('8 tasks launched with degraded dependencies');
  });
});

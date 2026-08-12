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
});

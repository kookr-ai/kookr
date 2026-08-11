import { describe, test, expect } from 'vitest';
import type { TaskStatus, WorktreeHealth } from './types.js';
import {
  isMissingWorktreeHealth,
  normalizeTerminalWorktreeHealth,
} from './worktree-health.js';

describe('isMissingWorktreeHealth', () => {
  test.each<[WorktreeHealth | undefined, boolean]>([
    ['missing', true],
    ['missing_unexpectedly', true],
    ['ok', false],
    ['stale', false],
    ['cleaned_up', false],
    [undefined, false],
  ])('health=%j → %s', (health, expected) => {
    expect(isMissingWorktreeHealth(health)).toBe(expected);
  });
});

describe('normalizeTerminalWorktreeHealth', () => {
  const allHealth: Array<WorktreeHealth | undefined> = [
    'ok',
    'stale',
    'missing',
    'missing_unexpectedly',
    'cleaned_up',
    undefined,
  ];

  test.each<[TaskStatus, WorktreeHealth | undefined, WorktreeHealth | undefined]>([
    // completed + missing-class health → cleaned_up
    ['completed', 'missing', 'cleaned_up'],
    ['completed', 'missing_unexpectedly', 'cleaned_up'],
    // completed + non-missing health passes through
    ['completed', 'ok', 'ok'],
    ['completed', 'stale', 'stale'],
    ['completed', 'cleaned_up', 'cleaned_up'],
    ['completed', undefined, undefined],
    // non-terminal / other terminal statuses never rewrite missing → cleaned_up
    ['open', 'missing', 'missing'],
    ['open', 'missing_unexpectedly', 'missing_unexpectedly'],
    ['pending', 'missing', 'missing'],
    ['inProgress', 'missing', 'missing'],
    ['terminated', 'missing', 'missing'],
    ['terminated', 'missing_unexpectedly', 'missing_unexpectedly'],
    ['cancelled', 'missing', 'missing'],
    ['cancelled', 'missing_unexpectedly', 'missing_unexpectedly'],
  ])('status=%s health=%j → %j', (status, health, expected) => {
    expect(normalizeTerminalWorktreeHealth(status, health)).toBe(expected);
  });

  test.each<TaskStatus>(['open', 'pending', 'inProgress', 'terminated', 'cancelled'])(
    'non-completed status %s preserves every health value unchanged',
    (status) => {
      for (const health of allHealth) {
        expect(normalizeTerminalWorktreeHealth(status, health)).toBe(health);
      }
    },
  );
});

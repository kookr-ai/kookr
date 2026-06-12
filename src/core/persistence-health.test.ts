import { describe, expect, test } from 'vitest';
import { PersistenceHealthTracker, normalizePersistenceError } from './persistence-health.js';

describe('PersistenceHealthTracker', () => {
  test('records failures and clears active error state on recovery', () => {
    let now = new Date('2026-06-12T10:00:00.000Z');
    const tracker = new PersistenceHealthTracker(() => now);
    const error = Object.assign(new Error('disk full'), { code: 'ENOSPC' });

    tracker.recordFailure('task_state', error);
    tracker.recordFailure('task_state', error);

    expect(tracker.snapshot().targets.task_state).toMatchObject({
      totalAttempts: 2,
      totalFailures: 2,
      consecutiveFailures: 2,
      lastError: {
        message: 'disk full',
        code: 'ENOSPC',
        hard: true,
      },
    });

    now = new Date('2026-06-12T10:01:00.000Z');
    tracker.recordSuccess('task_state');

    expect(tracker.snapshot().targets.task_state).toMatchObject({
      totalAttempts: 3,
      totalFailures: 2,
      consecutiveFailures: 0,
      lastSuccessAt: '2026-06-12T10:01:00.000Z',
      lastError: null,
    });
  });

  test('classifies non-durable-write errors as non-hard', () => {
    expect(normalizePersistenceError(new Error('temporary busy'))).toMatchObject({
      message: 'temporary busy',
      hard: false,
    });
  });
});

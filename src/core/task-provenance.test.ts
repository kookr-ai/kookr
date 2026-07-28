import { describe, test, expect } from 'vitest';
import { deriveTaskProvenance, UNKNOWN_PROVENANCE } from './task-provenance.js';

describe('deriveTaskProvenance (issue #1583)', () => {
  test('schedule launch with scheduleId → schedule provenance carrying the scheduleId', () => {
    expect(deriveTaskProvenance({ launchSource: 'schedule', scheduleId: 'sched-42' })).toEqual({
      kind: 'schedule',
      sourceId: 'sched-42',
    });
  });

  test('schedule launch without a scheduleId → schedule provenance with no sourceId', () => {
    expect(deriveTaskProvenance({ launchSource: 'schedule' })).toEqual({ kind: 'schedule' });
  });

  test('plain api launch → manual provenance with the launcher identity as sourceId', () => {
    expect(deriveTaskProvenance({ launchSource: 'api' })).toEqual({ kind: 'manual', sourceId: 'api' });
  });

  test.each(['ui', 'cli', 'websocket', 'remote-chat-telegram', 'remote-relay'] as const)(
    'non-schedule launchSource %s → manual provenance',
    (launchSource) => {
      expect(deriveTaskProvenance({ launchSource })).toEqual({ kind: 'manual', sourceId: launchSource });
    },
  );

  test('child spawn → parent provenance carrying the parent task id', () => {
    expect(deriveTaskProvenance({ parentTaskId: 'parent-1' })).toEqual({
      kind: 'parent',
      sourceId: 'parent-1',
    });
  });

  test('parentTaskId wins over launchSource (kookr-spawn-child-task sets both)', () => {
    expect(deriveTaskProvenance({ parentTaskId: 'parent-1', launchSource: 'api' })).toEqual({
      kind: 'parent',
      sourceId: 'parent-1',
    });
  });

  test('no launch signal at all → explicit unknown provenance', () => {
    expect(deriveTaskProvenance({})).toEqual({ kind: 'unknown' });
  });

  test('returns a fresh object, never a shared UNKNOWN_PROVENANCE reference', () => {
    const derived = deriveTaskProvenance({});
    expect(derived).toEqual(UNKNOWN_PROVENANCE);
    expect(derived).not.toBe(UNKNOWN_PROVENANCE);
  });
});

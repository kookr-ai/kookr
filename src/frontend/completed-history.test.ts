import { describe, expect, test } from 'vitest';
import type { AgentState } from '../shared/protocol.js';
import {
  mergeCompletedHistory,
  oldestLiveCompletedMs,
  parseTaskArchivePage,
  scopeArchivedAgents,
  TASK_ARCHIVE_SCHEMA_VERSION,
} from './completed-history.js';

function agent(id: string, overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: `sess-${id}`,
    taskId: id,
    taskName: id,
    events: [],
    anomaly: null,
    taskStatus: 'completed',
    finishedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('parseTaskArchivePage', () => {
  test('accepts a task-archive.v1 page', () => {
    const parsed = parseTaskArchivePage({
      schemaVersion: TASK_ARCHIVE_SCHEMA_VERSION,
      count: 0,
      records: [],
    });
    expect(parsed).toMatchObject({ schemaVersion: TASK_ARCHIVE_SCHEMA_VERSION, count: 0, records: [] });
  });

  test('rejects a malformed body so the UI can show archive-error', () => {
    expect(parseTaskArchivePage({ error: 'nope' })).toBeInstanceOf(Error);
    expect(parseTaskArchivePage({ schemaVersion: 'other', count: 0, records: [] })).toBeInstanceOf(Error);
    expect(parseTaskArchivePage(null)).toBeInstanceOf(Error);
  });
});

describe('mergeCompletedHistory', () => {
  test('live rows win on task-id collision and archived rows append', () => {
    const live = [agent('a', { taskName: 'live-a', finishedAt: '2026-08-20T00:00:00.000Z' })];
    const archived = [
      agent('a', { taskName: 'archive-a', finishedAt: '2026-08-20T00:00:00.000Z' }),
      agent('b', { taskName: 'archive-b', finishedAt: '2026-07-01T00:00:00.000Z' }),
    ];
    const merged = mergeCompletedHistory(live, archived);
    expect(merged.map((row) => row.taskName)).toEqual(['live-a', 'archive-b']);
  });

  test('keeps every live snapshot row even when they share a task id', () => {
    const live = [
      agent('shared', { agentId: 'newer', taskName: 'Newer task', finishedAt: '2026-06-20T11:30:00.000Z' }),
      agent('shared', { agentId: 'older', taskName: 'Older task', finishedAt: '2026-06-20T09:00:00.000Z' }),
    ];
    const merged = mergeCompletedHistory(live, []);
    expect(merged.map((row) => row.taskName)).toEqual(['Newer task', 'Older task']);
  });

  test('sorts newest-first after the merge', () => {
    const merged = mergeCompletedHistory(
      [agent('old', { finishedAt: '2026-01-01T00:00:00.000Z' })],
      [agent('new', { finishedAt: '2026-08-01T00:00:00.000Z' })],
    );
    expect(merged.map((row) => row.taskId)).toEqual(['new', 'old']);
  });
});

describe('oldestLiveCompletedMs', () => {
  test('returns the oldest terminal finish time and ignores active tasks', () => {
    const ms = oldestLiveCompletedMs([
      agent('active', { taskStatus: 'inProgress', finishedAt: undefined }),
      agent('newer', { finishedAt: '2026-08-10T00:00:00.000Z' }),
      agent('older', { finishedAt: '2026-08-01T00:00:00.000Z' }),
    ]);
    expect(ms).toBe(Date.parse('2026-08-01T00:00:00.000Z'));
  });

  test('returns null when the snapshot has no completed rows', () => {
    expect(oldestLiveCompletedMs([
      agent('active', { taskStatus: 'inProgress', finishedAt: undefined }),
    ])).toBeNull();
  });
});

describe('scopeArchivedAgents', () => {
  test('filters archive rows to the selected project', () => {
    const rows = [
      agent('a', { projectId: 'org/one' }),
      agent('b', { projectId: 'org/two' }),
    ];
    expect(scopeArchivedAgents(rows, 'org/one').map((row) => row.taskId)).toEqual(['a']);
    expect(scopeArchivedAgents(rows, null)).toHaveLength(2);
  });
});

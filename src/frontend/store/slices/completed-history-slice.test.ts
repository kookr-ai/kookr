import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentState } from '../../../shared/protocol.js';
import type { ArchivedTaskRecordJson, TaskArchivePage } from '../../completed-history.js';
import { COMPLETED_HISTORY_PAGE_LIMIT, mergeCompletedHistory } from '../../completed-history.js';
import { createCompletedHistorySlice } from './completed-history-slice.js';
import { createKookrStore } from '../useStore.js';

function archiveRecord(id: string, lastActivityMs: number): ArchivedTaskRecordJson {
  return {
    archivedAt: new Date(lastActivityMs).toISOString(),
    lastActivityMs,
    task: {
      id,
      name: id,
      status: 'completed',
      cwd: '/repo',
      createdAt: new Date(lastActivityMs - 60_000).toISOString(),
      finishedAt: new Date(lastActivityMs).toISOString(),
      sessions: [{ tmuxSession: `sess-${id}`, agentType: 'claude-code', cwd: '/repo' }],
    },
  };
}

function archivePage(records: ArchivedTaskRecordJson[], nextCursor?: string): TaskArchivePage {
  return {
    schemaVersion: 'task-archive.v1',
    count: records.length,
    records,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function stubArchivePages(pages: unknown[]) {
  const spy = vi.fn();
  let i = 0;
  vi.stubGlobal('fetch', spy.mockImplementation(() => {
    const body = pages[Math.min(i, pages.length - 1)];
    i += 1;
    const ok = !(body && typeof body === 'object' && 'ok' in (body as object) && (body as { ok: boolean }).ok === false);
    const status = !ok && body && typeof body === 'object' && 'status' in body
      ? (body as { status: number }).status
      : ok ? 200 : 500;
    const jsonBody = !ok && body && typeof body === 'object' && 'json' in body
      ? (body as { json: unknown }).json
      : body;
    return Promise.resolve({
      ok,
      status,
      json: () => Promise.resolve(jsonBody),
    } as Response);
  }));
  return spy;
}

describe('completed-history slice (issue #2760)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('does not request the archive until loadOlderHistory runs', () => {
    expect(typeof createCompletedHistorySlice).toBe('function');
    const spy = stubArchivePages([archivePage([])]);
    createKookrStore();
    expect(spy).not.toHaveBeenCalled();
  });

  test('pages older history, stores the cursor, and hides the control when exhausted', async () => {
    const spy = stubArchivePages([
      archivePage([archiveRecord('old-1', 2_000)], 'cursor-1'),
      archivePage([archiveRecord('old-2', 1_000)]),
    ]);
    const store = createKookrStore();
    await store.getState().loadOlderHistory();
    expect(store.getState().archivedAgents.map((a) => a.taskId)).toEqual(['old-1']);
    expect(store.getState().archiveNextCursor).toBe('cursor-1');
    expect(store.getState().archiveHasMore).toBe(true);

    await store.getState().loadOlderHistory();
    expect(store.getState().archivedAgents.map((a) => a.taskId)).toEqual(['old-1', 'old-2']);
    expect(store.getState().archiveNextCursor).toBeNull();
    expect(store.getState().archiveHasMore).toBe(false);
    expect(spy.mock.calls[1][0]).toContain('cursor=cursor-1');
    expect(String(spy.mock.calls[0][0])).toContain(`limit=${COMPLETED_HISTORY_PAGE_LIMIT}`);
  });

  test('hides live snapshot overlap at display time and keeps the archive copy for later', async () => {
    stubArchivePages([
      archivePage([
        archiveRecord('live-1', 3_000),
        archiveRecord('old-1', 1_000),
      ]),
    ]);
    const store = createKookrStore();
    const live: AgentState = {
      agentId: 'sess-live-1',
      taskId: 'live-1',
      events: [],
      anomaly: null,
      taskStatus: 'completed',
      finishedAt: '2026-08-20T00:00:00.000Z',
    };
    store.getState().handleSnapshot([live]);
    await store.getState().loadOlderHistory();
    expect(mergeCompletedHistory(store.getState().agents, store.getState().archivedAgents).map((a) => a.taskId)).toEqual(['live-1', 'old-1']);
    store.getState().handleSnapshot([]);
    expect(mergeCompletedHistory(store.getState().agents, store.getState().archivedAgents).map((a) => a.taskId)).toEqual(['live-1', 'old-1']);
  });

  test('does not append a duplicate page when the same cursor payload is returned twice', async () => {
    const record = archiveRecord('old-1', 1_000);
    stubArchivePages([
      archivePage([record], 'cursor-1'),
      archivePage([record], 'cursor-1'),
    ]);
    const store = createKookrStore();
    await store.getState().loadOlderHistory();
    await store.getState().loadOlderHistory();
    expect(store.getState().archivedAgents.map((a) => a.taskId)).toEqual(['old-1']);
  });

  test('keeps an archive-only selection across a snapshot refresh', async () => {
    stubArchivePages([archivePage([archiveRecord('old-1', 1_000)])]);
    const store = createKookrStore();
    store.getState().handleSnapshot([]);
    await store.getState().loadOlderHistory();
    const archived = store.getState().archivedAgents[0];
    store.getState().selectAgent(archived.agentId, archived.taskId);
    store.getState().handleSnapshot([]);
    expect(store.getState().selectedAgentId).toBe(archived.agentId);
    expect(store.getState().selectedTaskId).toBe(archived.taskId);
  });

  test('keeps cursor and loaded rows across a snapshot refresh', async () => {
    stubArchivePages([
      archivePage([archiveRecord('old-1', 1_000)], 'cursor-1'),
    ]);
    const store = createKookrStore();
    await store.getState().loadOlderHistory();
    store.getState().handleSnapshot([
      {
        agentId: 'fresh',
        taskId: 'fresh',
        events: [],
        anomaly: null,
        taskStatus: 'inProgress',
      },
    ]);
    expect(store.getState().archivedAgents.map((a) => a.taskId)).toEqual(['old-1']);
    expect(store.getState().archiveNextCursor).toBe('cursor-1');
    expect(store.getState().agents.map((a) => a.taskId)).toEqual(['fresh']);
  });

  test('records an empty history after a successful empty page', async () => {
    stubArchivePages([archivePage([])]);
    const store = createKookrStore();
    await store.getState().loadOlderHistory();
    expect(store.getState().archivedAgents).toEqual([]);
    expect(store.getState().archiveLoadedOnce).toBe(true);
    expect(store.getState().archiveHasMore).toBe(false);
    expect(store.getState().archiveError).toBeNull();
  });

  test('surfaces an archive failure without dropping already-loaded rows', async () => {
    stubArchivePages([
      archivePage([archiveRecord('old-1', 1_000)], 'cursor-1'),
      { ok: false, status: 500, json: { error: 'archive unreadable' } },
    ]);
    const store = createKookrStore();
    await store.getState().loadOlderHistory();
    await store.getState().loadOlderHistory();
    expect(store.getState().archivedAgents.map((a) => a.taskId)).toEqual(['old-1']);
    expect(store.getState().archiveError).toBe('archive unreadable');
    expect(store.getState().archiveHasMore).toBe(true);
    expect(store.getState().archiveLoading).toBe(false);
  });

  test('reuses the original before bound after a snapshot refresh', async () => {
    const spy = stubArchivePages([
      archivePage([archiveRecord('old-1', 1_000)], 'cursor-1'),
      archivePage([archiveRecord('old-2', 500)]),
    ]);
    const store = createKookrStore();
    const originalBefore = Date.parse('2026-08-01T00:00:00.000Z');
    store.getState().handleSnapshot([{
      agentId: 'done',
      taskId: 'done',
      events: [],
      anomaly: null,
      taskStatus: 'completed',
      finishedAt: '2026-08-01T00:00:00.000Z',
    }]);
    await store.getState().loadOlderHistory();
    store.getState().handleSnapshot([{
      agentId: 'newer',
      taskId: 'newer',
      events: [],
      anomaly: null,
      taskStatus: 'completed',
      finishedAt: '2026-08-20T00:00:00.000Z',
    }]);
    await store.getState().loadOlderHistory();
    expect(String(spy.mock.calls[1][0])).toContain(`before=${originalBefore}`);
    expect(String(spy.mock.calls[1][0])).toContain('cursor=cursor-1');
  });

  test('passes before=oldest live completed on the first page', async () => {
    const spy = stubArchivePages([archivePage([])]);
    const store = createKookrStore();
    store.getState().handleSnapshot([
      {
        agentId: 'done',
        taskId: 'done',
        events: [],
        anomaly: null,
        taskStatus: 'completed',
        finishedAt: '2026-08-20T00:00:00.000Z',
      },
    ]);
    await store.getState().loadOlderHistory();
    expect(String(spy.mock.calls[0][0])).toContain(`before=${Date.parse('2026-08-20T00:00:00.000Z')}`);
  });

  test('a second click while loading is ignored', async () => {
    let resolvePage: (value: Response) => void = () => {};
    const spy = vi.fn(() => new Promise<Response>((resolve) => {
      resolvePage = resolve;
    }));
    vi.stubGlobal('fetch', spy);
    const store = createKookrStore();
    const first = store.getState().loadOlderHistory();
    const second = store.getState().loadOlderHistory();
    expect(spy).toHaveBeenCalledTimes(1);
    resolvePage({
      ok: true,
      status: 200,
      json: () => Promise.resolve(archivePage([])),
    } as Response);
    await Promise.all([first, second]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

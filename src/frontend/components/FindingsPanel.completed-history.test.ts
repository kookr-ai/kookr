// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FindingsPanel, COMPLETED_SECTION_COLLAPSED_KEY } from './FindingsPanel.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { AgentState, ClientMessage } from '../../shared/protocol.js';
import type { ArchivedTaskRecordJson, TaskArchivePage } from '../completed-history.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function completedAgent(id: string): AgentState {
  return {
    agentId: `sess-${id}`,
    taskId: id,
    taskName: id,
    description: 'done',
    events: [],
    anomaly: null,
    taskStatus: 'completed',
    finishedAt: '2026-08-20T00:00:00.000Z',
    cwd: '/tmp/project',
  } as AgentState;
}

function archiveRecord(id: string, lastActivityMs: number): ArchivedTaskRecordJson {
  return {
    archivedAt: new Date(lastActivityMs).toISOString(),
    lastActivityMs,
    task: {
      id,
      name: id,
      status: 'completed',
      cwd: '/tmp/project',
      createdAt: new Date(lastActivityMs - 60_000).toISOString(),
      finishedAt: new Date(lastActivityMs).toISOString(),
      sessions: [{ tmuxSession: `sess-${id}`, agentType: 'claude-code', cwd: '/tmp/project' }],
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

describe('FindingsPanel older completed history (issue #2760)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.setItem(COMPLETED_SECTION_COLLAPSED_KEY, '0');
    syncGlobalStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.removeItem(COMPLETED_SECTION_COLLAPSED_KEY);
    vi.unstubAllGlobals();
  });

  function render(completed: AgentState[] = []) {
    act(() => {
      root.render(React.createElement(FindingsPanel, {
        findings: [],
        healthy: [],
        pending: [],
        snoozed: [],
        completed,
        selectedAgentId: null,
        selectedTaskId: null,
        send: vi.fn() as (msg: ClientMessage) => void,
        clearCompletedFinishedCount: completed.length,
        clearCompletedTerminatedCount: 0,
      }));
    });
  }

  test('does not fetch the archive on mount', () => {
    const spy = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(archivePage([])) } as Response));
    vi.stubGlobal('fetch', spy);
    render([completedAgent('live-1')]);
    expect(spy).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="load-older-history"]')?.textContent).toBe('Load older history');
  });

  test('exposes Load older history when there are no live completed rows', () => {
    render([]);
    const button = container.querySelector('[data-testid="load-older-history"]');
    expect(button?.textContent).toBe('Load older history');
    expect(container.querySelector('.completed-section')).toBeNull();
    expect(button?.closest('[aria-hidden="true"]')).toBeNull();
  });

  test('clicking Load older history fetches a page', async () => {
    const spy = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(archivePage([
          archiveRecord('old-1', Date.parse('2026-07-01T00:00:00.000Z')),
        ])),
      } as Response),
    );
    vi.stubGlobal('fetch', spy);
    render([completedAgent('live-1')]);
    const button = container.querySelector('[data-testid="load-older-history"]') as HTMLButtonElement;
    await act(async () => {
      button.click();
    });
    expect(spy).toHaveBeenCalled();
    expect([...container.querySelectorAll('.completed-row-name')].map((el) => el.textContent)).toContain('old-1');
  });

  test('appends paged archive rows without duplicating the live snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(archivePage([
          archiveRecord('live-1', Date.parse('2026-08-20T00:00:00.000Z')),
          archiveRecord('old-1', Date.parse('2026-07-01T00:00:00.000Z')),
        ], 'cursor-1')),
      } as Response),
    ));
    render([completedAgent('live-1')]);
    await act(async () => {
      await useKookrStore.getState().loadOlderHistory();
    });
    const names = [...container.querySelectorAll('.completed-row-name')].map((el) => el.textContent);
    expect(names.filter((name) => name === 'live-1')).toHaveLength(1);
    expect(names).toContain('old-1');
  });

  test('shows empty history after a successful empty archive page', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(archivePage([])),
      } as Response),
    ));
    render([]);
    await act(async () => {
      await useKookrStore.getState().loadOlderHistory();
    });
    expect(container.querySelector('[data-testid="completed-history-empty"]')?.textContent).toBe('No older history');
  });

  test('shows a non-blocking archive-error and keeps live completed rows', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'archive unreadable' }),
      } as Response),
    ));
    render([completedAgent('live-1')]);
    await act(async () => {
      await useKookrStore.getState().loadOlderHistory();
    });
    expect(container.querySelector('[data-testid="completed-history-error"]')?.textContent).toContain('archive unreadable');
    expect(container.querySelector('.completed-row-name')?.textContent).toBe('live-1');
    expect(container.querySelector('[data-testid="load-older-history"]')?.textContent).toBe('Retry older history');
  });
});

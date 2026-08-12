// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FindingsPanel } from './FindingsPanel.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { AgentState, ClientMessage } from '../../shared/protocol.js';

function syncGlobalStore(availableAgentTypes: Array<{ type: string; label: string }> = []) {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState({ ...nextData, availableAgentTypes });
}

function renderPanel(container: HTMLElement, send: (msg: ClientMessage) => void): Root {
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(FindingsPanel, {
      findings: [] as AgentState[],
      healthy: [],
      pending: [],
      snoozed: [],
      completed: [],
      selectedAgentId: null,
      selectedTaskId: null,
      send,
      clearCompletedFinishedCount: 0,
      clearCompletedTerminatedCount: 0,
      abortActiveTaskIds: [],
    }));
  });
  return root;
}

function queryButtonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined;
}

describe('FindingsPanel — batch migrate (RFC: rfc-cross-agent-task-migration)', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  test('hides the Migrate interrupted action when fewer than two agent types are available', () => {
    syncGlobalStore([{ type: 'claude-code', label: 'Claude Code' }]);
    root = renderPanel(container, vi.fn());
    expect(queryButtonByText('Migrate interrupted…')).toBeUndefined();
  });

  test('opening the dialog fetches the migratable count, and confirming posts the batch migrate request', async () => {
    syncGlobalStore([
      { type: 'claude-code', label: 'Claude Code' },
      { type: 'codex-cli', label: 'Codex CLI' },
    ]);
    const fetchSpy = vi.fn((path: string) => {
      if (typeof path === 'string' && path.startsWith('/api/tasks/migratable')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            targetAgent: 'claude-code',
            candidates: [
              { taskId: 't1', eligible: true, name: null, cwd: '/tmp/a', fromAgent: 'codex-cli', status: 'terminated', worktreeShared: false },
              { taskId: 't2', eligible: false, reason: 'live_session_exists', worktreeShared: false },
            ],
          }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          targetAgent: 'claude-code',
          defaultUpdated: false,
          results: [{ taskId: 't1', outcome: 'migrated', newTaskId: 't1-new' }],
        }),
      } as Response);
    });
    vi.stubGlobal('fetch', fetchSpy);

    root = renderPanel(container, vi.fn());

    const openButton = queryButtonByText('Migrate interrupted…');
    expect(openButton).toBeDefined();
    act(() => openButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(document.querySelector('.confirm-dialog')).not.toBeNull();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/tasks/migratable?targetAgent=claude-code'),
      expect.anything(),
    );
    expect(document.body.textContent).toContain('1 task migratable');

    const confirm = queryButtonByText('Migrate');
    expect(confirm).toBeDefined();
    await act(async () => {
      confirm!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchSpy).toHaveBeenCalledWith('/api/tasks/migrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetAgent: 'claude-code',
        scope: { kind: 'all', includeCancelled: false },
        setAsDefault: false,
        onlyIsolated: false,
      }),
    });
  });
});

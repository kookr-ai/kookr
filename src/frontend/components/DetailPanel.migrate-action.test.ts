// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentState, ClientMessage } from '../../shared/protocol.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { DetailPanel } from './DetailPanel.js';

vi.mock('../telemetry.js', () => ({ track: vi.fn(), trackClick: vi.fn() }));
vi.mock('./ActivityPanel.js', () => ({ ActivityPanel: () => React.createElement('div', { 'data-testid': 'activity-panel' }) }));
vi.mock('./GitHubPanel.js', () => ({ GitHubPanel: () => React.createElement('div', { 'data-testid': 'github-panel' }) }));
vi.mock('./TerminalPanel.js', () => ({ TerminalPanel: () => React.createElement('div', { 'data-testid': 'terminal-panel' }) }));
vi.mock('./DiffPane.js', () => ({ DiffPane: () => React.createElement('div', { 'data-testid': 'diff-pane' }) }));
vi.mock('./SnoozeDialog.js', () => ({ SnoozeDialog: () => null }));
vi.mock('./EffectiveHookSettingsModal.js', () => ({ EffectiveHookSettingsModal: () => null }));

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState({
    ...nextData,
    availableAgentTypes: [
      { type: 'claude-code', label: 'Claude Code' },
      { type: 'codex-cli', label: 'Codex CLI' },
    ],
  });
}

function terminatedAgent(): AgentState {
  return {
    agentId: 'agent-1',
    taskId: 'task-1',
    taskName: 'Interrupted task',
    events: [],
    anomaly: null,
    cwd: '/tmp/kookr',
    startedAt: '2026-05-15T19:00:00.000Z',
    taskStatus: 'terminated',
    agentType: 'claude-code',
  };
}

function renderDetailPanel(container: HTMLElement, send: (msg: ClientMessage) => boolean): Root {
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(DetailPanel, {
      agent: terminatedAgent(),
      send,
      onLaunch: vi.fn(),
      onRequestComplete: vi.fn(),
    }));
  });
  return root;
}

describe('DetailPanel migrate action (RFC: rfc-cross-agent-task-migration)', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    syncGlobalStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  test('posts a single-task migrate request and records a success alert', async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          targetAgent: 'codex-cli',
          defaultUpdated: false,
          results: [{ taskId: 'task-1', outcome: 'migrated', newTaskId: 'task-2' }],
        }),
      } as Response),
    );
    vi.stubGlobal('fetch', fetchSpy);

    root = renderDetailPanel(container, () => true);

    const openButton = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent === 'Migrate to…') as HTMLButtonElement | undefined;
    expect(openButton).toBeInstanceOf(HTMLButtonElement);
    act(() => openButton!.click());

    const goButton = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent === 'Go') as HTMLButtonElement | undefined;
    expect(goButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      goButton!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchSpy).toHaveBeenCalledWith('/api/tasks/migrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetAgent: 'codex-cli',
        scope: { kind: 'ids', taskIds: ['task-1'] },
      }),
    });

    const alerts = useKookrStore.getState().alerts;
    expect(alerts.some((a) => a.summary.includes('Migrated to codex-cli') && a.summary.includes('task-2'))).toBe(true);
  });
});

// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentState, ClientMessage, PermissionRequestBinding } from '../../shared/protocol.js';
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
  useKookrStore.setState(nextData);
}

function permissionAgent(): AgentState {
  return {
    agentId: 'agent-1',
    taskId: 'task-1',
    taskName: 'Permission task',
    events: [],
    anomaly: {
      agentId: 'agent-1',
      type: 'permission_blocked',
      severity: 'warning',
      explanation: 'permission required',
      detectedAt: new Date('2026-05-15T19:00:00.000Z'),
    },
    cwd: '/tmp/kookr',
    startedAt: '2026-05-15T19:00:00.000Z',
    taskStatus: 'inProgress',
  };
}

const permissionRequest: PermissionRequestBinding = {
  requestId: 'request-1',
  toolName: 'Bash',
  toolInputHash: 'hash-1',
  detectedAt: '2026-05-15T19:00:00.000Z',
  ttlMs: 300000,
};

function renderDetailPanel(container: HTMLElement, send: (msg: ClientMessage) => boolean): Root {
  useKookrStore.getState().handleSuggestion('agent-1', [], [{
    label: 'Allow: Bash: `git status`',
    value: 'Yes',
    keystroke: '1',
    permissionRequest,
  }]);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(DetailPanel, {
      agent: permissionAgent(),
      send,
      onLaunch: vi.fn(),
    }));
  });
  return root;
}

describe('DetailPanel permission quick actions', () => {
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
  });

  test('forwards permissionRequest when clicking a permission action button', () => {
    const sent: ClientMessage[] = [];
    root = renderDetailPanel(container, (msg) => {
      sent.push(msg);
      return true;
    });

    const button = Array.from(container.querySelectorAll('button'))
      .find((candidate) => candidate.textContent?.includes('Allow: Bash')) as HTMLButtonElement | undefined;
    expect(button).toBeDefined();
    act(() => button!.click());

    expect(sent).toContainEqual({
      type: 'permissionChoice',
      agentId: 'agent-1',
      keystroke: '1',
      permissionRequest,
    });
  });

  test('forwards permissionRequest when using a numeric permission shortcut', () => {
    const sent: ClientMessage[] = [];
    root = renderDetailPanel(container, (msg) => {
      sent.push(msg);
      return true;
    });

    const input = container.querySelector<HTMLInputElement>('.response-row input');
    expect(input).toBeDefined();
    act(() => {
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
    });

    expect(sent).toContainEqual({
      type: 'permissionChoice',
      agentId: 'agent-1',
      keystroke: '1',
      permissionRequest,
    });
  });
});

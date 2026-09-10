// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentState } from '../../shared/protocol.js';
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

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: 'agent-1',
    taskId: 'task-1',
    taskName: 'Implement GitHub Issue',
    events: [],
    anomaly: {
      type: 'needs_input',
      severity: 'info',
      explanation: 'Agent is waiting for input.',
      detectedAt: '2026-05-09T00:00:00.000Z',
    },
    cwd: '/home/jean/git/kookr',
    projectDisplayLabel: 'kookr',
    projectId: 'kookr-ai/kookr',
    startedAt: '2026-05-09T00:00:00.000Z',
    taskStatus: 'inProgress',
    ...overrides,
  } as AgentState;
}

function renderDetailPanel(container: HTMLElement, agent: AgentState): Root {
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(DetailPanel, {
        agent,
        send: vi.fn(() => true),
        onLaunch: vi.fn(),
        onRequestComplete: vi.fn(),
      }),
    );
  });
  return root;
}

function copyButton(container: HTMLElement, cwd: string): HTMLButtonElement | null {
  return container.querySelector(`button[aria-label="Copy working directory ${cwd}"]`);
}

describe('DetailPanel working-directory copy control', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
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
    vi.restoreAllMocks();
  });

  test('shows the copy control in a dedicated Directory row for a normal cwd', () => {
    root = renderDetailPanel(container, makeAgent());
    expect(copyButton(container, '/home/jean/git/kookr')).not.toBeNull();
  });

  test('still shows the copy control when the project label resolves to empty (cwd "/")', () => {
    // Regression: the control was previously nested inside the Project row,
    // which is gated on a non-empty project label. projectLabel('/') === '',
    // so an agent whose cwd is the filesystem root had no way to copy it.
    // The control must be gated on cwd itself, not the derived label.
    root = renderDetailPanel(container, makeAgent({ cwd: '/', projectDisplayLabel: undefined, projectId: undefined }));
    expect(copyButton(container, '/')).not.toBeNull();
  });

  test('omits the copy control entirely when the agent has no cwd', () => {
    root = renderDetailPanel(container, makeAgent({ cwd: undefined, projectDisplayLabel: undefined, projectId: undefined }));
    // No orphaned copy button anywhere in the panel.
    expect(container.querySelector('button[aria-label^="Copy working directory"]')).toBeNull();
  });
});

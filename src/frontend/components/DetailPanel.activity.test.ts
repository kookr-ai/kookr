// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentState } from '../../shared/protocol.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { DetailPanel } from './DetailPanel.js';

vi.mock('../telemetry.js', () => ({ track: vi.fn(), trackClick: vi.fn() }));
vi.mock('./GitHubPanel.js', () => ({ GitHubPanel: () => React.createElement('div', { 'data-testid': 'github-panel' }) }));
vi.mock('./TerminalPanel.js', () => ({ TerminalPanel: () => React.createElement('div', { 'data-testid': 'terminal-panel' }) }));
vi.mock('./DiffPane.js', () => ({ DiffPane: () => React.createElement('div', { 'data-testid': 'diff-pane' }) }));
vi.mock('./SnoozeDialog.js', () => ({ SnoozeDialog: () => null }));
vi.mock('./EffectiveHookSettingsModal.js', () => ({ EffectiveHookSettingsModal: () => null }));
vi.mock('./VoiceInputButton.js', () => ({ VoiceInputButton: () => React.createElement('button', { type: 'button' }, 'Voice') }));

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: 'kookr-test',
    taskId: 'task-1',
    taskName: 'Activity display task',
    events: [
      { type: 'tool_use', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'npm test' }, eventSeq: 51 },
    ],
    anomaly: null,
    agentType: 'codex-cli',
    description: 'Launch prompt',
    cwd: '/repo',
    startedAt: '2026-06-06T00:00:00.000Z',
    taskStatus: 'inProgress',
    ...overrides,
  };
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
        detailPaneMode: 'split',
      }),
    );
  });
  return root;
}

async function flushLazyImports() {
  await act(async () => {
    await vi.dynamicImportSettled();
  });
}

describe('DetailPanel activity wiring', () => {
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
  });

  test('forwards agent metadata so ActivityPanel can render one windowed launch placeholder', async () => {
    root = renderDetailPanel(container, makeAgent());

    await flushLazyImports();

    const messages = [...container.querySelectorAll('.act-msg-user')].map((el) => el.textContent ?? '');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('Launch prompt');
  });
});

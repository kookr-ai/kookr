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
vi.mock('./TerminalPanel.js', () => ({
  TerminalPanel: ({ visible }: { visible?: boolean }) => React.createElement('div', {
    'data-testid': 'terminal-panel',
    'data-visible': String(Boolean(visible)),
  }),
}));
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
    agentType: 'codex-cli',
    cwd: '/home/jean/git/kookr',
    projectDisplayLabel: 'kookr',
    projectId: 'kookr-ai/kookr',
    gitBranch: 'main',
    gitIsWorktree: false,
    worktreeHealth: 'missing',
    startedAt: '2026-05-09T00:00:00.000Z',
    taskStatus: 'inProgress',
    tokenUsage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.42 },
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

function renderFocusedDetailPanel(container: HTMLElement, agent: AgentState): Root {
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(DetailPanel, {
        agent,
        send: vi.fn(() => true),
        onLaunch: vi.fn(),
        onRequestComplete: vi.fn(),
        terminalFocusMode: true,
      }),
    );
  });
  return root;
}

describe('DetailPanel dense metadata', () => {
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

  test('keeps critical task state in the header and moves repeated metadata into details', () => {
    root = renderDetailPanel(container, makeAgent());

    const header = container.querySelector('.detail-header')!;
    expect(header.querySelector('h2')?.textContent).toBe('Implement GitHub Issue');
    expect(header.querySelector('.detail-header-warning')?.textContent).toBe('missing');
    expect(header.querySelector('.detail-badge.input')?.textContent).toBe('NEEDS INPUT');

    expect(header.querySelector('.detail-header-right > .project-badge')).toBeNull();
    expect(header.querySelector('.detail-header-right > .detail-agent-type-group')).toBeNull();
    expect(header.querySelector('.detail-header-right > .detail-branch')).toBeNull();

    const metaMenu = header.querySelector('.detail-meta-menu')!;
    expect(metaMenu.querySelector('.detail-agent-provider--codex-cli')?.textContent).toContain('Codex CLI');
    expect(metaMenu.querySelector('.project-badge')?.textContent).toBe('kookr');
    expect(metaMenu.querySelector('.detail-branch')?.textContent).toContain('main');
    expect(metaMenu.textContent).toContain('$0.42');
    expect(metaMenu.textContent).toContain('1.5k tok');
  });

  test('terminal focus mode removes secondary detail chrome while keeping terminal active', () => {
    root = renderFocusedDetailPanel(container, makeAgent());

    expect(container.querySelector('.detail-panel.terminal-focus')).not.toBeNull();
    expect(container.querySelector('[data-testid="terminal-panel"]')?.getAttribute('data-visible')).toBe('true');
    expect(container.querySelector('.detail-split-left')).toBeNull();
    expect(container.querySelector('.detail-tabs-narrow')).toBeNull();
    expect(container.querySelector('[data-testid="task-dependencies"]')).toBeNull();
  });
});

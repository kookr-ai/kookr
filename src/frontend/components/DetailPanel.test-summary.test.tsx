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

describe('DetailPanel test summary', () => {
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

  function completedAgent(testSummary?: string): AgentState {
    return {
      agentId: 'kookr-done',
      taskId: 'task-1',
      taskName: 'Test summary task',
      events: [],
      anomaly: null,
      taskStatus: 'completed',
      cwd: '/repo',
      startedAt: '2026-06-11T12:00:00.000Z',
      completionDigest: {
        bullets: ['Changed 1 file'],
        filesChanged: ['src/app.ts'],
        ...(testSummary === undefined ? {} : { testSummary }),
      },
    };
  }

  test('renders the test summary line when present', () => {
    root = renderDetailPanel(container, completedAgent('All 42 tests passed'));

    const block = container.querySelector('[data-testid="digest-test-summary"]');
    expect(block).not.toBeNull();
    expect(block?.textContent).toContain('Tests:');
    expect(block?.textContent).toContain('All 42 tests passed');
  });

  test('renders verbatim free text without parsing', () => {
    const raw = '3 failed, 5 passed — see log **run 7**';
    root = renderDetailPanel(container, completedAgent(raw));

    const block = container.querySelector('[data-testid="digest-test-summary"]');
    expect(block?.textContent).toContain(raw);
  });

  test('renders nothing extra when the digest has no test summary', () => {
    root = renderDetailPanel(container, completedAgent(undefined));

    expect(container.querySelector('[data-testid="digest-test-summary"]')).toBeNull();
  });
});

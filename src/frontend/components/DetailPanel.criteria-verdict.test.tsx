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

describe('DetailPanel criteria verdict', () => {
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

  function completedAgent(criteriaVerdict: NonNullable<NonNullable<AgentState['completionDigest']>['criteriaVerdict']>): AgentState {
    return {
      agentId: 'kookr-done',
      taskId: 'task-1',
      taskName: 'Criteria task',
      events: [],
      anomaly: null,
      taskStatus: 'completed',
      cwd: '/repo',
      startedAt: '2026-06-11T12:00:00.000Z',
      completionDigest: {
        bullets: ['Changed 1 file'],
        filesChanged: ['src/app.ts'],
        criteriaVerdict,
      },
    };
  }

  test('renders advisory criteria verdicts inside the completion digest', () => {
    root = renderDetailPanel(container, completedAgent({
      items: [
        { criterion: 'Run tests', verdict: 'pass', reason: 'Test output showed 4 passed.' },
        { criterion: 'Open a PR', verdict: 'unknown', reason: 'No PR URL appeared in the event window.' },
      ],
      summary: { pass: 1, fail: 0, unknown: 1 },
      source: 'llm',
      evaluatedAt: '2026-06-11T12:01:00.000Z',
    }));

    const block = container.querySelector('[data-testid="criteria-verdict"]');
    expect(block?.textContent).toContain('Criteria');
    expect(block?.textContent).toContain('1 criterion unknown');
    expect(block?.textContent).toContain('Run tests');
    expect(block?.textContent).toContain('Passed:');
    expect(block?.textContent).toContain('Test output showed 4 passed.');
    expect(block?.textContent).toContain('Open a PR');
    expect(block?.textContent).toContain('Unknown:');
    expect(block?.textContent).toContain('No PR URL appeared');
  });

  test('renders the all-passed criteria verdict branch', () => {
    root = renderDetailPanel(container, completedAgent({
      items: [
        { criterion: 'Run tests', verdict: 'pass', reason: 'Test output showed 4 passed.' },
      ],
      summary: { pass: 1, fail: 0, unknown: 0 },
      source: 'llm',
      evaluatedAt: '2026-06-11T12:01:00.000Z',
    }));

    const block = container.querySelector('[data-testid="criteria-verdict"]');
    expect(block?.classList.contains('criteria-verdict--pass')).toBe(true);
    expect(block?.textContent).toContain('Criteria passed');
    expect(block?.textContent).toContain('Passed:');
  });

  test('renders the failed criteria verdict branch', () => {
    root = renderDetailPanel(container, completedAgent({
      items: [
        { criterion: 'Open a PR', verdict: 'fail', reason: 'The event window said no PR was opened.' },
        { criterion: 'Run tests', verdict: 'unknown', reason: 'No test output appeared.' },
      ],
      summary: { pass: 0, fail: 1, unknown: 1 },
      source: 'llm',
      evaluatedAt: '2026-06-11T12:01:00.000Z',
    }));

    const block = container.querySelector('[data-testid="criteria-verdict"]');
    expect(block?.classList.contains('criteria-verdict--fail')).toBe(true);
    expect(block?.textContent).toContain('1 criterion failed');
    expect(block?.textContent).toContain('Failed:');
    expect(block?.textContent).toContain('Unknown:');
  });
});

// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentState, AgentType } from '../../shared/protocol.js';
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

function makeAgent(agentType: AgentType): AgentState {
  return {
    agentId: `kookr-${agentType}`,
    taskId: `task-${agentType}`,
    taskName: `${agentType} task`,
    events: [],
    anomaly: null,
    agentType,
    cwd: '/tmp/kookr',
    startedAt: '2026-05-08T20:00:00.000Z',
    taskStatus: 'inProgress',
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
      }),
    );
  });
  return root;
}

describe('DetailPanel agent provider header controls', () => {
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

  test.each([
    {
      agentType: 'claude-code' as const,
      label: 'Claude Code',
    },
    {
      agentType: 'codex-cli' as const,
      label: 'Codex CLI',
    },
  ])('keeps $label out of the task header badge area', ({ agentType, label }) => {
    root = renderDetailPanel(container, makeAgent(agentType));

    const headerRight = container.querySelector('.detail-header-right')!;
    expect(headerRight.querySelector(':scope > .detail-agent-provider')).toBeNull();
    expect(headerRight.querySelector(':scope > .detail-agent-provider-icon')).toBeNull();
    expect(headerRight.querySelector(':scope > .detail-agent-type-group')).toBeNull();
    expect(headerRight.querySelector('summary')?.textContent).toBe('Details');

    const metaMenu = headerRight.querySelector('.detail-meta-menu')!;
    expect(metaMenu.querySelector('.detail-agent-provider')?.textContent).toContain(label);

    const hooksButton = metaMenu.querySelector<HTMLButtonElement>('.detail-hook-settings-btn');
    expect(hooksButton?.textContent).toBe('hooks');
    expect(hooksButton?.getAttribute('aria-label')).toBe(`Hooks: view effective hook settings for ${label} session`);
    expect(hooksButton?.getAttribute('title')).toBe(`Hooks: view effective hook settings for ${label} session`);
  });
});

// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FindingsPanel } from './FindingsPanel.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { AgentState } from '../../shared/protocol.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: overrides.agentId ?? 'agent-1',
    taskId: overrides.taskId ?? 'task-1',
    taskName: overrides.taskName ?? 'Some task',
    description: 'Working',
    events: [],
    anomaly: null,
    taskStatus: 'inProgress',
    cwd: '/tmp/project',
    ...overrides,
  } as AgentState;
}

function renderPanel(container: HTMLElement, lists: {
  findings?: AgentState[];
  healthy?: AgentState[];
  pending?: AgentState[];
  snoozed?: AgentState[];
  completed?: AgentState[];
}): Root {
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(FindingsPanel, {
      findings: lists.findings ?? [],
      healthy: lists.healthy ?? [],
      pending: lists.pending ?? [],
      snoozed: lists.snoozed ?? [],
      completed: lists.completed ?? [],
      selectedAgentId: null,
      send: vi.fn(),
      clearCompletedFinishedCount: 0,
      clearCompletedTerminatedCount: 0,
    }));
  });
  return root;
}

describe('FindingsPanel agent provider marks', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ checks: {}, fires: {}, falsePositives: {} }),
      text: async () => '{}',
    })));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  test('healthy task cards render the agent provider logo in the running status mark', () => {
    root = renderPanel(container, {
      healthy: [makeAgent({ agentId: 'h-codex', agentType: 'codex-cli' })],
    });

    const mark = container.querySelector('.healthy-row .agent-provider-mark');
    expect(mark?.classList.contains('agent-provider-mark--codex-cli')).toBe(true);
    expect(mark?.classList.contains('agent-provider-mark--running')).toBe(true);
    expect(mark?.getAttribute('title')).toBe('Codex CLI by OpenAI');
    expect(mark?.getAttribute('role')).toBe('img');
    expect(mark?.getAttribute('aria-label')).toBe('Codex CLI by OpenAI');
    expect(container.querySelector('.healthy-row .healthy-dot')).toBeNull();
  });

  test('finding task cards render the agent provider logo beside severity', () => {
    root = renderPanel(container, {
      findings: [makeAgent({
        agentId: 'f-claude',
        agentType: 'claude-code',
        anomaly: {
          type: 'needs_input',
          severity: 'warning',
          explanation: 'Waiting for input',
          detectedAt: '2026-05-09T00:00:00.000Z',
        },
      })],
    });

    const mark = container.querySelector('.finding-header-left .agent-provider-mark');
    expect(mark?.classList.contains('agent-provider-mark--claude-code')).toBe(true);
    expect(mark?.getAttribute('title')).toBe('Claude Code by Anthropic');
  });
});

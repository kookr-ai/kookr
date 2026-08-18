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
    startedAt: '2026-03-24T10:00:00.000Z',
    tokenUsage: {
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.42,
    },
    ...overrides,
  } as AgentState;
}

function renderPanel(container: HTMLElement, healthy: AgentState[]): Root {
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(FindingsPanel, {
      findings: [],
      healthy,
      pending: [],
      snoozed: [],
      completed: [],
      selectedAgentId: null,
      send: vi.fn(),
      clearCompletedFinishedCount: 0,
      clearCompletedTerminatedCount: 0,
    }));
  });
  return root;
}

describe('FindingsPanel healthy row current tool', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-24T10:15:00.000Z'));
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
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  test('shows compact toolLabel when last event is tool_use Read of auth.ts', () => {
    root = renderPanel(container, [makeAgent({
      events: [
        { type: 'tool_use', sessionId: 's1', toolName: 'Read', toolInput: { file_path: '/tmp/src/auth.ts' } },
      ],
    })]);

    expect(container.querySelector('.healthy-row-tool')?.textContent).toBe('Read auth.ts');
    expect(container.querySelector('.healthy-row-dur')?.textContent).toBe('15m');
    expect(container.querySelector('.healthy-row-cost')?.textContent).toMatch(/\$0\.42/);
  });

  test('hides the tool label when last event is stop', () => {
    root = renderPanel(container, [makeAgent({
      events: [
        { type: 'tool_use', sessionId: 's1', toolName: 'Read', toolInput: { file_path: '/tmp/src/auth.ts' } },
        { type: 'stop', sessionId: 's1', lastMessage: 'All done!' },
      ],
    })]);

    expect(container.querySelector('.healthy-row-tool')).toBeNull();
    expect(container.querySelector('.healthy-row-dur')?.textContent).toBe('done');
    expect(container.querySelector('.healthy-row-cost')?.textContent).toMatch(/\$0\.42/);
  });
});

// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FindingsPanel } from '../FindingsPanel.js';
import { createKookrStore, useKookrStore } from '../../store/useStore.js';
import type { AgentState, TokenUsage } from '../../../shared/protocol.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 4,
    ...overrides,
  };
}

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: 'agent-1',
    taskId: 'task-1',
    taskName: 'Task 1',
    description: 'Working',
    events: [],
    anomaly: {
      agentId: 'agent-1',
      type: 'permission_blocked',
      severity: 'warning',
      explanation: 'Blocked on a Bash permission prompt',
      detectedAt: new Date('2026-06-11T08:00:00Z'),
    },
    taskStatus: 'inProgress',
    cwd: '/tmp/project',
    ...overrides,
  } as AgentState;
}

function renderPanel(container: HTMLElement, findings: AgentState[]): Root {
  const root = createRoot(container);
  act(() => {
    root.render(
      <FindingsPanel
        findings={findings}
        healthy={[]}
        pending={[]}
        snoozed={[]}
        completed={[]}
        selectedAgentId={null}
        send={vi.fn()}
        clearCompletedFinishedCount={0}
        clearCompletedTerminatedCount={0}
      />,
    );
  });
  return root;
}

describe('FindingCard cost-rate line', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ checks: {}, fires: {}, falsePositives: {} }),
        text: async () => '{}',
      })),
    );
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

  test('shows $X.XX/h next to cost when the session is older than two minutes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T11:00:00.000Z'));
    root = renderPanel(container, [
      makeAgent({
        tokenUsage: usage(),
        startedAt: '2026-06-11T10:00:00.000Z',
      }),
    ]);
    expect(container.querySelector('.finding-cost')?.textContent).toContain('$4.00/h');
  });

  test('omits the rate for a session younger than two minutes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T10:01:00.000Z'));
    root = renderPanel(container, [
      makeAgent({
        tokenUsage: usage(),
        startedAt: '2026-06-11T10:00:00.000Z',
      }),
    ]);
    expect(container.querySelector('.finding-cost')?.textContent).not.toMatch(/\/h/);
  });
});

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

// This is the exact 2026-07-24 incident row: a task on the "Healthy" section
// (no active `anomaly`, so it renders as a plain running row) whose
// `stuckReason` says it actually isn't doing work.
describe('FindingsPanel stuckReason badge (issue #1526 Phase B / FM9)', () => {
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

  test('a healthy row with stuckReason awaiting_completion_ack shows the badge', () => {
    root = renderPanel(container, {
      healthy: [makeAgent({ agentId: 'h-ack', stuckReason: 'awaiting_completion_ack' })],
    });

    const badge = container.querySelector('.healthy-row .stuck-reason-badge');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('Awaiting ack');
    expect(badge?.classList.contains('stuck-reason-badge--awaiting_completion_ack')).toBe(true);
    expect(badge?.getAttribute('title')).toBe('Agent signaled completion — awaiting your review');
  });

  test('a genuinely healthy row (no stuckReason) renders no badge at all', () => {
    root = renderPanel(container, {
      healthy: [makeAgent({ agentId: 'h-plain' })],
    });

    expect(container.querySelector('.healthy-row .stuck-reason-badge')).toBeNull();
  });

  test('each stuckReason value maps to a distinct badge label and modifier class', () => {
    root = renderPanel(container, {
      healthy: [
        makeAgent({ agentId: 'h-ack', stuckReason: 'awaiting_completion_ack' }),
        makeAgent({ agentId: 'h-hung', stuckReason: 'hung_suspect' }),
        makeAgent({ agentId: 'h-input', stuckReason: 'waiting_on_input' }),
        makeAgent({ agentId: 'h-perm', stuckReason: 'permission_blocked' }),
      ],
    });

    const badges = Array.from(container.querySelectorAll('.healthy-row .stuck-reason-badge'));
    expect(badges.map((b) => b.textContent)).toEqual(['Awaiting ack', 'Hung?', 'Needs input', 'Permission']);
    expect(badges.map((b) => b.className)).toEqual([
      'stuck-reason-badge stuck-reason-badge--awaiting_completion_ack',
      'stuck-reason-badge stuck-reason-badge--hung_suspect',
      'stuck-reason-badge stuck-reason-badge--waiting_on_input',
      'stuck-reason-badge stuck-reason-badge--permission_blocked',
    ]);
  });
});

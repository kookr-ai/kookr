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

function renderPanel(container: HTMLElement, findings: AgentState[]): Root {
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(FindingsPanel, {
      findings,
      healthy: [],
      pending: [],
      snoozed: [],
      completed: [],
      selectedAgentId: null,
      send: vi.fn(),
      globalFinishedCount: 0,
      globalTerminatedCount: 0,
    }));
  });
  return root;
}

describe('FindingsPanel root-cause grouping', () => {
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

  test('renders related findings in a collapsible group without duplicate cards', () => {
    root = renderPanel(container, [
      makeAgent({
        agentId: 'root-agent',
        taskId: 'root-task',
        taskName: 'Root task',
        anomaly: {
          agentId: 'root-agent',
          type: 'needs_input',
          severity: 'warning',
          explanation: 'Parent is waiting',
          detectedAt: new Date('2026-05-24T10:00:00Z'),
          likelyRootCause: true,
          relatedFindingIds: ['child-agent-a', 'child-agent-b'],
          causalityReason: 'Linked by task ancestry',
        },
      }),
      makeAgent({
        agentId: 'child-agent-a',
        taskId: 'child-task-a',
        taskName: 'Child A',
        anomaly: {
          agentId: 'child-agent-a',
          type: 'needs_input',
          severity: 'warning',
          explanation: 'Child is waiting',
          detectedAt: new Date('2026-05-24T10:01:00Z'),
          rootCauseFindingId: 'root-agent',
        },
      }),
      makeAgent({
        agentId: 'child-agent-b',
        taskId: 'child-task-b',
        taskName: 'Child B',
        anomaly: {
          agentId: 'child-agent-b',
          type: 'permission_blocked',
          severity: 'warning',
          explanation: 'Child needs permission',
          detectedAt: new Date('2026-05-24T10:02:00Z'),
          rootCauseFindingId: 'root-agent',
        },
      }),
    ]);

    expect(container.querySelector('.root-cause-badge')?.textContent).toContain('Likely root cause - 2 related findings');
    expect(container.querySelectorAll('.finding-card')).toHaveLength(3);
    expect(container.querySelectorAll('.root-cause-related .finding-card')).toHaveLength(2);

    const toggle = container.querySelector('.root-cause-toggle') as HTMLElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    act(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelectorAll('.finding-card')).toHaveLength(1);
    expect(container.querySelectorAll('.root-cause-related .finding-card')).toHaveLength(0);
  });

  test('keeps root-cause groups in prioritized finding order', () => {
    root = renderPanel(container, [
      makeAgent({
        agentId: 'critical-agent',
        taskId: 'critical-task',
        taskName: 'Critical task',
        anomaly: {
          agentId: 'critical-agent',
          type: 'repeated_error',
          severity: 'critical',
          explanation: 'Critical unrelated issue',
          detectedAt: new Date('2026-05-24T10:00:00Z'),
        },
      }),
      makeAgent({
        agentId: 'root-agent',
        taskId: 'root-task',
        taskName: 'Root task',
        anomaly: {
          agentId: 'root-agent',
          type: 'needs_input',
          severity: 'warning',
          explanation: 'Parent is waiting',
          detectedAt: new Date('2026-05-24T10:01:00Z'),
          likelyRootCause: true,
          relatedFindingIds: ['child-agent'],
        },
      }),
      makeAgent({
        agentId: 'child-agent',
        taskId: 'child-task',
        taskName: 'Child task',
        anomaly: {
          agentId: 'child-agent',
          type: 'needs_input',
          severity: 'warning',
          explanation: 'Child is waiting',
          detectedAt: new Date('2026-05-24T10:02:00Z'),
          rootCauseFindingId: 'root-agent',
        },
      }),
    ]);

    const cards = Array.from(container.querySelectorAll('.finding-card'));
    expect(cards[0].textContent).toContain('Critical task');
    expect(cards[1].textContent).toContain('Root task');
    expect(cards[2].textContent).toContain('Child task');
  });
});

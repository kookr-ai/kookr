// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentState } from '../../shared/protocol.js';
import { __resetDndForTests, disableDnd, enableDnd } from '../hooks/useDnd.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { DndPill } from './DndPill.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function makeFinding(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: overrides.agentId ?? 'agent-1',
    taskId: overrides.taskId ?? 'task-1',
    taskName: overrides.taskName ?? 'Task 1',
    events: [],
    anomaly: {
      agentId: overrides.agentId ?? 'agent-1',
      type: 'needs_input',
      severity: 'warning',
      explanation: 'Waiting',
      detectedAt: new Date('2026-06-11T12:30:00Z'),
    },
    taskStatus: 'inProgress',
    ...overrides,
  };
}

describe('DndPill', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    syncGlobalStore();
    __resetDndForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T12:00:00Z'));
    enableDnd();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    disableDnd();
    __resetDndForTests();
    vi.useRealTimers();
    localStorage.clear();
    document.body.innerHTML = '';
  });

  function render() {
    act(() => {
      root.render(React.createElement(DndPill));
    });
  }

  test('does not count a re-stamped completion signal as new during DND', () => {
    useKookrStore.setState({
      agents: [
        makeFinding({
          turnState: 'completed_turn',
          pendingSignal: {
            kind: 'completion_ready',
            raisedAt: '2026-06-11T10:00:00Z',
          },
          anomaly: {
            agentId: 'agent-1',
            type: 'needs_input',
            severity: 'warning',
            explanation: 'Waiting for review',
            detectedAt: new Date('2026-06-11T12:30:00Z'),
          },
        }),
      ],
    });

    render();

    expect(container.querySelector('.dnd-pill-count')).toBeNull();
  });

  test('counts a fresh non-signal finding even when the task has older signal overlay state', () => {
    useKookrStore.setState({
      agents: [
        makeFinding({
          pendingSignal: {
            kind: 'completion_ready',
            raisedAt: '2026-06-11T10:00:00Z',
          },
          anomaly: {
            agentId: 'agent-1',
            type: 'permission_blocked',
            severity: 'warning',
            explanation: 'Permission required',
            detectedAt: new Date('2026-06-11T12:30:00Z'),
          },
        }),
      ],
    });

    render();

    expect(container.querySelector('.dnd-pill-count')?.textContent).toBe('1');
  });
});

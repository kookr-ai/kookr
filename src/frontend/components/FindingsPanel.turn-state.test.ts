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
      clearCompletedFinishedCount: 0,
      clearCompletedTerminatedCount: 0,
    }));
  });
  return root;
}

// A normal Stop emits a `needs_input`/`stop` anomaly; turnState carries the
// completed-turn distinction. See issue #358.
const STOP_ANOMALY = {
  type: 'needs_input' as const,
  subType: 'stop' as const,
  severity: 'info' as const,
  explanation: 'Agent is waiting for input. Last message: "Yes. In a clean headless..."',
  detectedAt: '2026-05-15T15:05:36.000Z',
};

describe('FindingsPanel turn-state badge (issue #358)', () => {
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

  test('a completed turn shows "Signaled complete – waiting for review", not a running/hung presentation', () => {
    root = renderPanel(container, [
      makeAgent({ agentId: 'f-codex', agentType: 'codex-cli', anomaly: STOP_ANOMALY, turnState: 'completed_turn' }),
    ]);

    const turnState = container.querySelector('[data-testid="finding-turn-state"]');
    expect(turnState?.textContent).toBe('Signaled complete — waiting for review');
    expect(turnState?.classList.contains('turn-state--complete')).toBe(true);

    // The headline severity says "Signaled Complete", not the ambiguous "Needs Input".
    const severity = container.querySelector('.finding-severity');
    expect(severity?.textContent).toBe('Signaled Complete');
    expect(severity?.classList.contains('turn-complete')).toBe(true);
  });

  test('an explicit AskUserQuestion still reads as "Needs Input"', () => {
    root = renderPanel(container, [
      makeAgent({
        agentId: 'f-ask',
        anomaly: { ...STOP_ANOMALY, subType: 'ask_user_question', severity: 'warning' },
        turnState: 'waiting_for_input',
      }),
    ]);

    expect(container.querySelector('.finding-severity')?.textContent).toBe('Needs Input');
    expect(container.querySelector('[data-testid="finding-turn-state"]')?.textContent)
      .toBe('Waiting for your input');
  });

  test('an active finding (turnState running) is presented as actively running', () => {
    root = renderPanel(container, [
      makeAgent({
        agentId: 'f-err',
        anomaly: {
          type: 'repeated_error',
          severity: 'warning',
          explanation: 'Same error repeated 3 times',
          detectedAt: '2026-05-15T15:05:36.000Z',
        },
        turnState: 'running',
      }),
    ]);

    const turnState = container.querySelector('[data-testid="finding-turn-state"]');
    expect(turnState?.textContent).toBe('Running');
    expect(turnState?.classList.contains('turn-state--running')).toBe(true);
  });

  test('no turn-state line renders when turnState is absent', () => {
    root = renderPanel(container, [makeAgent({ agentId: 'f-none', anomaly: STOP_ANOMALY })]);
    expect(container.querySelector('[data-testid="finding-turn-state"]')).toBeNull();
  });

  test('renders transcript last assistant message context when present', () => {
    root = renderPanel(container, [
      makeAgent({
        agentId: 'f-transcript',
        anomaly: {
          ...STOP_ANOMALY,
          transcriptContext: {
            lastAssistantMessage: {
              excerpt: 'Should I merge this once CI passes?',
              truncated: false,
              readAtOffset: 42,
            },
          },
        },
      }),
    ]);

    const context = container.querySelector('[data-testid="finding-transcript-context"]');
    expect(context?.textContent).toContain('Last agent message');
    expect(context?.textContent).toContain('Should I merge this once CI passes?');
  });
});

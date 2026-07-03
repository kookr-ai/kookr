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
    taskName: overrides.taskName ?? 'Task 1',
    description: 'Working',
    events: [],
    anomaly: {
      agentId: overrides.agentId ?? 'agent-1',
      type: 'needs_input',
      severity: 'warning',
      explanation: 'Waiting for input',
      detectedAt: new Date('2026-06-11T08:00:00Z'),
    },
    taskStatus: 'inProgress',
    cwd: '/tmp/project',
    ...overrides,
  } as AgentState;
}

function renderPanel(
  container: HTMLElement,
  findings: AgentState[],
  selectedAgentId: string | null = null,
  send = vi.fn(),
): Root {
  const root = createRoot(container);
  act(() => {
    root.render((
      <FindingsPanel
        findings={findings}
        healthy={[]}
        pending={[]}
        snoozed={[]}
        completed={[]}
        selectedAgentId={selectedAgentId}
        send={send}
        clearCompletedFinishedCount={0}
        clearCompletedTerminatedCount={0}
      />
    ));
  });
  return root;
}

describe('FindingsPanel flood rendering bounds', () => {
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
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  test('caps default root-cause related finding cards while preserving the selected finding', () => {
    const related = Array.from({ length: 60 }, (_, index) => makeAgent({
      agentId: `child-${index}`,
      taskId: `child-task-${index}`,
      taskName: `Child task ${index}`,
      anomaly: {
        agentId: `child-${index}`,
        type: 'needs_input',
        severity: 'warning',
        explanation: `Child ${index} is waiting`,
        detectedAt: new Date('2026-06-11T08:01:00Z'),
        rootCauseFindingId: 'root-agent',
      },
    }));
    const findings = [
      makeAgent({
        agentId: 'root-agent',
        taskId: 'root-task',
        taskName: 'Root task',
        anomaly: {
          agentId: 'root-agent',
          type: 'needs_input',
          severity: 'warning',
          explanation: 'Root is waiting',
          detectedAt: new Date('2026-06-11T08:00:00Z'),
          likelyRootCause: true,
          relatedFindingIds: related.map((agent) => agent.agentId),
        },
      }),
      ...related,
    ];

    root = renderPanel(container, findings, 'child-55');

    expect(container.querySelectorAll('.root-cause-related .finding-card')).toHaveLength(26);
    expect(container.querySelectorAll('.finding-card')).toHaveLength(27);
    expect(container.textContent).toContain('Child task 55');
    expect(container.querySelector('.finding-card.selected')?.textContent).toContain('Child task 55');
    expect(container.querySelector('.finding-group-show-all')?.textContent).toContain('Showing 26 of 60');
  });

  test('renders all group members only after the show-all control is activated', () => {
    const findings = Array.from({ length: 60 }, (_, index) => makeAgent({
      agentId: `agent-${index}`,
      taskId: `task-${index}`,
      taskName: `Grouped task ${index}`,
      anomaly: {
        agentId: `agent-${index}`,
        type: 'permission_blocked',
        severity: 'warning',
        explanation: `Permission blocked ${index}`,
        detectedAt: new Date('2026-06-11T08:02:00Z'),
      },
    }));

    root = renderPanel(container, findings);

    const header = container.querySelector<HTMLElement>('.finding-group-header');
    expect(header).not.toBeNull();
    act(() => header!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(container.querySelectorAll('.finding-group .finding-card')).toHaveLength(25);
    const showAll = container.querySelector<HTMLButtonElement>('.finding-group-show-all');
    expect(showAll?.getAttribute('aria-label')).toBe('Show all 60 findings in this group');

    act(() => showAll!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(container.querySelectorAll('.finding-group .finding-card')).toHaveLength(60);
    expect(container.querySelector('.finding-group-show-all')).toBeNull();
  });

  test('keeps a selected duplicate-group finding visible outside the default cap', () => {
    const findings = Array.from({ length: 60 }, (_, index) => makeAgent({
      agentId: `agent-${index}`,
      taskId: `task-${index}`,
      taskName: `Grouped task ${index}`,
      anomaly: {
        agentId: `agent-${index}`,
        type: 'permission_blocked',
        severity: 'warning',
        explanation: `Permission blocked ${index}`,
        detectedAt: new Date('2026-06-11T08:03:00Z'),
      },
    }));

    root = renderPanel(container, findings, 'agent-55');

    expect(container.querySelector('.finding-group-header')).not.toBeNull();
    expect(container.querySelectorAll('.finding-group .finding-card')).toHaveLength(26);
    expect(container.querySelector('.finding-card.selected')?.textContent).toContain('Grouped task 55');
    expect(container.querySelector('.finding-group-show-all')?.textContent).toContain('Showing 26 of 60');
  });

  test('offers a batch reply only for agents with an identical pending prompt', () => {
    const sent: unknown[] = [];
    const findings = [
      makeAgent({
        agentId: 'agent-1',
        taskId: 'task-1',
        taskName: 'Open PR A',
        turnState: 'waiting_for_input',
        events: [{
          type: 'tool_use',
          sessionId: 'agent-1',
          toolName: 'AskUserQuestion',
          toolInput: { question: 'Open the PR when checks are green?', choices: ['Yes', 'No'] },
        }],
      }),
      makeAgent({
        agentId: 'agent-2',
        taskId: 'task-2',
        taskName: 'Open PR B',
        turnState: 'waiting_for_input',
        events: [{
          type: 'tool_use',
          sessionId: 'agent-2',
          toolName: 'AskUserQuestion',
          toolInput: { question: 'Open the PR when checks are green?', choices: ['Yes', 'No'] },
        }],
      }),
      makeAgent({
        agentId: 'agent-3',
        taskId: 'task-3',
        taskName: 'Merge PR A',
        turnState: 'waiting_for_input',
        events: [{
          type: 'tool_use',
          sessionId: 'agent-3',
          toolName: 'AskUserQuestion',
          toolInput: { question: 'Merge the PR now?', choices: ['Yes', 'No'] },
        }],
      }),
      makeAgent({
        agentId: 'agent-4',
        taskId: 'task-4',
        taskName: 'Merge PR B',
        turnState: 'waiting_for_input',
        events: [{
          type: 'tool_use',
          sessionId: 'agent-4',
          toolName: 'AskUserQuestion',
          toolInput: { question: 'Merge the PR now?', choices: ['Yes', 'No'] },
        }],
      }),
    ];
    useKookrStore.setState({ agents: findings });

    root = renderPanel(container, findings, null, (msg) => { sent.push(msg); });

    const matchingButton = Array.from(container.querySelectorAll<HTMLButtonElement>('.finding-identical-prompt-action'))
      .find((button) => button.textContent === 'Approve matching (2)');
    expect(matchingButton).toBeDefined();

    act(() => matchingButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(sent).toEqual([{ type: 'respondAll', agentIds: ['agent-1', 'agent-2'], input: 'yes' }]);
    expect(useKookrStore.getState().respondAllAgentIds).toBeNull();

    const manualButton = Array.from(container.querySelectorAll<HTMLButtonElement>('.finding-identical-prompt-action'))
      .find((button) => button.textContent === 'Reply to matching (2)');
    expect(manualButton).toBeDefined();

    act(() => manualButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(sent).toEqual([{ type: 'respondAll', agentIds: ['agent-1', 'agent-2'], input: 'yes' }]);
    expect(useKookrStore.getState().respondAllAgentIds).toEqual(['agent-3', 'agent-4']);
    expect(useKookrStore.getState().selectedAgentId).toBe('agent-3');
  });

  test('offers a batch reply for exactly two identical pending prompts', () => {
    const findings = [
      makeAgent({
        agentId: 'agent-1',
        taskId: 'task-1',
        taskName: 'Open PR A',
        turnState: 'waiting_for_input',
        events: [{
          type: 'tool_use',
          sessionId: 'agent-1',
          toolName: 'AskUserQuestion',
          toolInput: { question: 'Open PR on green?', choices: ['Yes', 'No'] },
        }],
      }),
      makeAgent({
        agentId: 'agent-2',
        taskId: 'task-2',
        taskName: 'Open PR B',
        turnState: 'waiting_for_input',
        events: [{
          type: 'tool_use',
          sessionId: 'agent-2',
          toolName: 'AskUserQuestion',
          toolInput: { question: 'Open PR on green?', choices: ['Yes', 'No'] },
        }],
      }),
    ];
    useKookrStore.setState({ agents: findings });

    root = renderPanel(container, findings);

    expect(container.querySelector('.finding-group-label')?.textContent).toBe('2 agents waiting for input');
    const matchingButton = container.querySelector<HTMLButtonElement>('.finding-identical-prompt-action');
    expect(matchingButton?.textContent).toBe('Approve matching (2)');
  });

  test('renders re-stamped signaled findings with the original pending-signal wait age', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T18:57:00Z'));
    const findings = [
      makeAgent({
        agentId: 'agent-1',
        taskId: 'task-1',
        taskName: 'Old completion signal',
        turnState: 'completed_turn',
        pendingSignal: {
          kind: 'completion_ready',
          raisedAt: '2026-06-07T22:47:00Z',
        },
        anomaly: {
          agentId: 'agent-1',
          type: 'needs_input',
          severity: 'warning',
          explanation: 'Waiting for review',
          detectedAt: new Date('2026-06-11T18:49:00Z'),
        },
      }),
    ];

    root = renderPanel(container, findings);

    expect(container.querySelector('.age-badge')?.textContent).toBe('waiting 3d');
    expect(container.querySelector('.finding-severity')?.getAttribute('aria-label')).toBe('Signaled Complete, waiting 3d');
  });
});

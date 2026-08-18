// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FindingsPanel } from '../FindingsPanel.js';
import { createKookrStore, useKookrStore } from '../../store/useStore.js';
import type { AgentState } from '../../../shared/protocol.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: 'agent-1',
    taskId: 'task-1',
    taskName: 'Child follow-up',
    description: 'Waiting on input',
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

function makeParent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: 'parent-agent',
    taskId: 'parent-task',
    taskName: 'Playbook batch',
    description: 'Parent playbook run',
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
    root.render(
      <FindingsPanel
        findings={findings}
        healthy={[]}
        pending={[]}
        snoozed={[]}
        completed={[]}
        selectedAgentId={null}
        selectedTaskId={null}
        send={vi.fn()}
        clearCompletedFinishedCount={0}
        clearCompletedTerminatedCount={0}
      />,
    );
  });
  return root;
}

describe('FindingCard parent-task name chip', () => {
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

  test('shows the parent display name when parentTaskId resolves in the snapshot', () => {
    const parent = makeParent();
    const child = makeAgent({ parentTaskId: parent.taskId });
    useKookrStore.setState({ agents: [parent, child] });
    root = renderPanel(container, [child]);

    const chip = container.querySelector('[data-testid="finding-parent-chip"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe('parent: Playbook batch');
  });

  test('hides the chip when parentTaskId is unset', () => {
    const child = makeAgent();
    useKookrStore.setState({ agents: [child] });
    root = renderPanel(container, [child]);

    expect(container.querySelector('[data-testid="finding-parent-chip"]')).toBeNull();
  });

  test('hides the chip when parentTaskId is not in the snapshot', () => {
    const child = makeAgent({ parentTaskId: 'missing-parent' });
    useKookrStore.setState({ agents: [child] });
    root = renderPanel(container, [child]);

    expect(container.querySelector('[data-testid="finding-parent-chip"]')).toBeNull();
  });

  test('clicking the chip selects the parent without opening a new panel', () => {
    vi.useFakeTimers();
    const parent = makeParent();
    const child = makeAgent({ parentTaskId: parent.taskId });
    useKookrStore.setState({
      agents: [parent, child],
      detailPaneMode: 'right',
      leftPane: 'activity',
    });
    root = renderPanel(container, [child]);

    const chip = container.querySelector<HTMLButtonElement>('[data-testid="finding-parent-chip"]');
    expect(chip).not.toBeNull();
    act(() => {
      chip!.click();
    });
    act(() => {
      vi.advanceTimersByTime(250);
    });

    const state = useKookrStore.getState();
    expect(state.selectedAgentId).toBe('parent-agent');
    expect(state.selectedTaskId).toBe('parent-task');
    expect(state.leftPane).toBe('activity');
    expect(state.narrowTab).toBe('activity');
    expect(state.detailPaneMode).toBe('right');
    vi.useRealTimers();
  });

  test('does not show the git branch on the card', () => {
    const parent = makeParent({ gitBranch: 'feat/parent-batch' });
    const child = makeAgent({
      parentTaskId: parent.taskId,
      gitBranch: 'feat/child-follow-up',
    });
    useKookrStore.setState({ agents: [parent, child] });
    root = renderPanel(container, [child]);

    expect(container.querySelector('.branch-label')).toBeNull();
    expect(container.textContent).not.toContain('feat/parent-batch');
    expect(container.textContent).not.toContain('feat/child-follow-up');
    expect(container.querySelector('[data-testid="finding-parent-chip"]')?.textContent).toBe(
      'parent: Playbook batch',
    );
  });
});

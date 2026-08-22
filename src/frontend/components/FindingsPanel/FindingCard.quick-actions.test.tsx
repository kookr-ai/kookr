// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FindingsPanel } from '../FindingsPanel.js';
import { createKookrStore, useKookrStore } from '../../store/useStore.js';
import type {
  AgentState,
  ClientMessage,
  PermissionRequestBinding,
  QuickAction,
} from '../../../shared/protocol.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  const agentId = overrides.agentId ?? 'agent-1';
  return {
    agentId,
    taskId: overrides.taskId ?? 'task-1',
    taskName: overrides.taskName ?? 'Task 1',
    description: 'Working',
    events: [],
    anomaly: {
      agentId,
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

const permissionRequest: PermissionRequestBinding = {
  requestId: 'request-1',
  toolName: 'Bash',
  toolInputHash: 'hash-1',
  detectedAt: '2026-05-15T19:00:00.000Z',
  ttlMs: 300000,
};

function renderPanel(
  container: HTMLElement,
  findings: AgentState[],
  send: (msg: ClientMessage) => boolean | void,
  selectedAgentId: string | null = null,
  selectedTaskId: string | null = null,
): Root {
  const root = createRoot(container);
  act(() => {
    root.render(
      <FindingsPanel
        findings={findings}
        healthy={[]}
        pending={[]}
        snoozed={[]}
        completed={[]}
        selectedAgentId={selectedAgentId}
        selectedTaskId={selectedTaskId}
        send={send}
        clearCompletedFinishedCount={0}
        clearCompletedTerminatedCount={0}
      />,
    );
  });
  return root;
}

function chipButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="finding-quick-action"]'));
}

function queryActionButton(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.trim() === text,
  );
}

describe('FindingCard live quick-action chips (issue #2747)', () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let send: ReturnType<typeof vi.fn<(msg: ClientMessage) => boolean | void>>;

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
    send = vi.fn();
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  test('permission_blocked card shows Allow/Deny and sends permissionChoice with the live binding', () => {
    const agent = makeAgent();
    const nextAgent = makeAgent({
      agentId: 'agent-2',
      taskId: 'task-2',
      taskName: 'Task 2',
      anomaly: {
        agentId: 'agent-2',
        type: 'needs_input',
        severity: 'info',
        explanation: 'Waiting for a reply',
        detectedAt: new Date('2026-06-11T08:01:00Z'),
      },
    });
    useKookrStore.setState({
      agents: [agent, nextAgent],
      selectedAgentId: agent.agentId,
      selectedTaskId: agent.taskId,
    });
    useKookrStore.getState().handleSuggestion(agent.agentId, [], [
      {
        label: 'Allow: Bash: `git status`',
        value: 'Yes',
        keystroke: '1',
        permissionRequest,
      },
      {
        label: 'Deny',
        value: 'No',
        keystroke: '2',
        permissionRequest,
      },
    ]);

    root = renderPanel(container, [agent, nextAgent], send, agent.agentId, agent.taskId);

    const chips = chipButtons(container);
    expect(chips.map((chip) => chip.textContent?.trim())).toEqual([
      'Allow: Bash: `git status`',
      'Deny',
    ]);
    expect(queryActionButton(container, 'Skip')).toBeInstanceOf(HTMLButtonElement);
    expect(queryActionButton(container, 'Snooze')).toBeInstanceOf(HTMLButtonElement);
    expect(queryActionButton(container, 'Not a real issue')).toBeInstanceOf(HTMLButtonElement);

    act(() => chips[0]!.click());

    expect(send).toHaveBeenCalledWith({
      type: 'permissionChoice',
      agentId: 'agent-1',
      keystroke: '1',
      permissionRequest,
    });
    expect(useKookrStore.getState().selectedAgentId).toBe('agent-2');
    expect(useKookrStore.getState().suggestions[agent.agentId]).toBeUndefined();

    const followUpRequest: PermissionRequestBinding = {
      ...permissionRequest,
      requestId: 'request-2',
      toolInputHash: 'hash-2',
    };
    act(() => {
      useKookrStore.getState().handleSuggestion(agent.agentId, [], [
        {
          label: 'Allow: Bash: `git diff`',
          value: 'Yes',
          keystroke: '1',
          permissionRequest: followUpRequest,
        },
      ]);
    });
    const followUpChips = chipButtons(container);
    expect(followUpChips[0]?.disabled).toBe(false);
    act(() => followUpChips[0]!.click());
    expect(send).toHaveBeenLastCalledWith({
      type: 'permissionChoice',
      agentId: 'agent-1',
      keystroke: '1',
      permissionRequest: followUpRequest,
    });
  });

  test('needs_input card shows Yes/No chips and sends respond with the chip value', () => {
    const agent = makeAgent({
      anomaly: {
        agentId: 'agent-1',
        type: 'needs_input',
        severity: 'info',
        explanation: 'Should I continue?',
        detectedAt: new Date('2026-06-11T08:00:00Z'),
      },
    });
    const nextAgent = makeAgent({
      agentId: 'agent-2',
      taskId: 'task-2',
      taskName: 'Task 2',
      anomaly: {
        agentId: 'agent-2',
        type: 'needs_input',
        severity: 'info',
        explanation: 'Waiting for a reply',
        detectedAt: new Date('2026-06-11T08:01:00Z'),
      },
    });
    useKookrStore.setState({
      agents: [agent, nextAgent],
      selectedAgentId: agent.agentId,
      selectedTaskId: agent.taskId,
    });
    useKookrStore.getState().handleSuggestion(agent.agentId, [], [
      { label: 'Yes', value: 'yes', shortcut: 'y' },
      { label: 'No', value: 'no', shortcut: 'n' },
    ]);

    root = renderPanel(container, [agent, nextAgent], send, agent.agentId, agent.taskId);

    const chips = chipButtons(container);
    expect(chips.map((chip) => chip.textContent?.trim())).toEqual(['Yes', 'No']);

    act(() => chips[0]!.click());

    expect(send).toHaveBeenCalledWith({
      type: 'respond',
      agentId: 'agent-1',
      input: 'yes',
    });
    expect(useKookrStore.getState().selectedAgentId).toBe('agent-2');
    expect(useKookrStore.getState().suggestions[agent.agentId]).toBeUndefined();
  });

  test('cards with no suggestion chips look unchanged', () => {
    const agent = makeAgent();
    root = renderPanel(container, [agent], send);

    expect(chipButtons(container)).toHaveLength(0);
    expect(container.querySelector('.finding-quick-actions')).toBeNull();
    expect(queryActionButton(container, 'Skip')).toBeInstanceOf(HTMLButtonElement);
    expect(queryActionButton(container, 'Snooze')).toBeInstanceOf(HTMLButtonElement);
    expect(queryActionButton(container, 'Not a real issue')).toBeInstanceOf(HTMLButtonElement);
  });

  test('keeps chips and selection when send reports failure', () => {
    const agent = makeAgent();
    send.mockReturnValue(false);
    useKookrStore.setState({
      agents: [agent],
      selectedAgentId: agent.agentId,
      selectedTaskId: agent.taskId,
    });
    useKookrStore.getState().handleSuggestion(agent.agentId, [], [
      {
        label: 'Allow: Bash: `git status`',
        value: 'Yes',
        keystroke: '1',
        permissionRequest,
      },
    ]);

    root = renderPanel(container, [agent], send, agent.agentId, agent.taskId);
    act(() => chipButtons(container)[0]!.click());

    expect(send).toHaveBeenCalledWith({
      type: 'permissionChoice',
      agentId: 'agent-1',
      keystroke: '1',
      permissionRequest,
    });
    expect(useKookrStore.getState().selectedAgentId).toBe('agent-1');
    expect(useKookrStore.getState().suggestions[agent.agentId]?.quickActions).toHaveLength(1);
    expect(chipButtons(container)).toHaveLength(1);
    expect(chipButtons(container)[0]?.disabled).toBe(false);
  });

  test('does not render a permission chip that lacks permissionRequest', () => {
    const agent = makeAgent();
    const unbound: QuickAction = {
      label: 'Allow: Bash: `rm -rf /`',
      value: 'Yes',
      keystroke: '1',
    };
    useKookrStore.getState().handleSuggestion(agent.agentId, [], [unbound]);

    root = renderPanel(container, [agent], send);

    expect(chipButtons(container)).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  test('shows at most five chips', () => {
    const agent = makeAgent({
      anomaly: {
        agentId: 'agent-1',
        type: 'needs_input',
        severity: 'info',
        explanation: 'Pick an option',
        detectedAt: new Date('2026-06-11T08:00:00Z'),
      },
    });
    useKookrStore.getState().handleSuggestion(
      agent.agentId,
      [],
      Array.from({ length: 7 }, (_, i) => ({
        label: `Option ${i + 1}`,
        value: String(i + 1),
      })),
    );

    root = renderPanel(container, [agent], send);

    expect(chipButtons(container).map((chip) => chip.textContent?.trim())).toEqual([
      'Option 1',
      'Option 2',
      'Option 3',
      'Option 4',
      'Option 5',
    ]);
  });
});

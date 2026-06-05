// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FindingsPanel } from './FindingsPanel.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { AgentState, ClientMessage } from '../../shared/protocol.js';

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
}, send: (msg: ClientMessage) => void): Root {
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(FindingsPanel, {
      findings: lists.findings ?? [],
      healthy: lists.healthy ?? [],
      pending: [],
      snoozed: [],
      completed: [],
      selectedAgentId: null,
      send,
      clearCompletedFinishedCount: 0,
      clearCompletedTerminatedCount: 0,
    }));
  });
  return root;
}

function setValue(el: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('FindingsPanel — supervisor-feedback button wiring', () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ checks: {}, fires: {}, falsePositives: {}, falseNegatives: {} }),
      text: async () => '{}',
    })));
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

  test('clicking Flag FP opens the modal and submitting emits findingFeedback with userReason', async () => {
    const findingAgent = makeAgent({
      agentId: 'kookr-fp-1',
      anomaly: {
        agentId: 'kookr-fp-1',
        type: 'needs_input',
        severity: 'info',
        explanation: 'Agent is waiting for input. Last message: "### Finding 1"',
        detectedAt: new Date(),
      },
    });
    root = renderPanel(container, { findings: [findingAgent] }, send);

    const flagFpButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button.btn-fp'))[0];
    expect(flagFpButton).toBeDefined();

    await act(async () => {
      flagFpButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const dialog = document.querySelector('.supervisor-feedback-dialog');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain('Specific supervisor text'.replace('Specific supervisor text', 'Agent is waiting for input'));

    const textarea = document.querySelector<HTMLTextAreaElement>('.supervisor-feedback-dialog textarea')!;
    await act(async () => setValue(textarea, 'agent emitted a long review report'));

    const submit = Array.from(document.querySelectorAll<HTMLButtonElement>('.supervisor-feedback-dialog button'))
      .find((b) => b.textContent === 'Flag FP')!;
    await act(async () => {
      submit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const findingFeedbackCalls = send.mock.calls
      .map((args) => args[0] as ClientMessage)
      .filter((m): m is Extract<ClientMessage, { type: 'findingFeedback' }> => m.type === 'findingFeedback');
    expect(findingFeedbackCalls).toHaveLength(1);
    expect(findingFeedbackCalls[0]).toMatchObject({
      type: 'findingFeedback',
      agentId: 'kookr-fp-1',
      anomalyType: 'needs_input',
      verdict: 'false_positive',
      userReason: 'agent emitted a long review report',
    });
  });

  test('clicking Flag missed on a healthy agent emits missedFinding with reason + suspectedType', async () => {
    const healthyAgent = makeAgent({ agentId: 'kookr-fn-1', taskName: 'A healthy task' });
    root = renderPanel(container, { healthy: [healthyAgent] }, send);

    const flagMissedButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button.btn-fn'))[0];
    expect(flagMissedButton).toBeDefined();

    await act(async () => {
      flagMissedButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const textarea = document.querySelector<HTMLTextAreaElement>('.supervisor-feedback-dialog textarea')!;
    const select = document.querySelector<HTMLSelectElement>('.supervisor-feedback-dialog select')!;
    await act(async () => setValue(textarea, 'visibly stuck for 10m, no finding'));
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, 'stale_agent');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const submit = Array.from(document.querySelectorAll<HTMLButtonElement>('.supervisor-feedback-dialog button'))
      .find((b) => b.textContent === 'Flag missed')!;
    await act(async () => {
      submit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const missedFindingCalls = send.mock.calls
      .map((args) => args[0] as ClientMessage)
      .filter((m): m is Extract<ClientMessage, { type: 'missedFinding' }> => m.type === 'missedFinding');
    expect(missedFindingCalls).toHaveLength(1);
    expect(missedFindingCalls[0]).toMatchObject({
      type: 'missedFinding',
      agentId: 'kookr-fn-1',
      userReason: 'visibly stuck for 10m, no finding',
      suspectedType: 'stale_agent',
    });
  });

  test('Flag FP modal can be cancelled without sending anything', async () => {
    const findingAgent = makeAgent({
      agentId: 'kookr-fp-2',
      anomaly: {
        agentId: 'kookr-fp-2',
        type: 'needs_input',
        severity: 'info',
        explanation: 'waiting',
        detectedAt: new Date(),
      },
    });
    root = renderPanel(container, { findings: [findingAgent] }, send);

    const flagFpButton = container.querySelector<HTMLButtonElement>('button.btn-fp')!;
    await act(async () => {
      flagFpButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const cancel = Array.from(document.querySelectorAll<HTMLButtonElement>('.supervisor-feedback-dialog button'))
      .find((b) => b.textContent === 'Cancel')!;
    await act(async () => {
      cancel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.querySelector('.supervisor-feedback-dialog')).toBeNull();
    expect(send.mock.calls.filter((c) => (c[0] as ClientMessage).type === 'findingFeedback')).toHaveLength(0);
  });
});

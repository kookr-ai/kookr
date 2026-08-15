// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FindingsPanel } from './FindingsPanel.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { FINDING_TYPE_FILTER_KEY } from '../finding-type-filter.js';
import type { AgentState, ClientMessage } from '../../shared/protocol.js';
import type { AnomalyType } from '../../shared/contracts/anomalies.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function makeFinding(
  agentId: string,
  type: AnomalyType = 'permission_blocked',
  overrides: Partial<AgentState> = {},
): AgentState {
  return {
    agentId,
    taskId: `task-${agentId}`,
    taskName: `${agentId} task`,
    description: 'Working',
    events: [],
    anomaly: {
      agentId,
      type,
      severity: 'warning',
      explanation: `Finding of type ${type}`,
      detectedAt: new Date('2026-06-11T08:00:00Z'),
    },
    taskStatus: 'inProgress',
    cwd: '/tmp/project',
    ...overrides,
  } as AgentState;
}

function renderPanel(
  container: HTMLElement,
  props: { findings: AgentState[]; healthy?: AgentState[]; send: (msg: ClientMessage) => void },
): Root {
  const root = createRoot(container);
  act(() => {
    root.render(
      <FindingsPanel
        findings={props.findings}
        healthy={props.healthy ?? []}
        pending={[]}
        snoozed={[]}
        completed={[]}
        selectedAgentId={null}
        send={props.send}
        clearCompletedFinishedCount={0}
        clearCompletedTerminatedCount={0}
      />,
    );
  });
  return root;
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function pressEscape() {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }));
  });
}

describe('FindingsPanel "Snooze all" bulk control (issue #2421)', () => {
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
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  test('is not rendered when the findings bucket is empty', () => {
    // Healthy rows present but no findings — the control must stay hidden so the
    // label never promises a no-op.
    root = renderPanel(container, {
      findings: [],
      healthy: [makeFinding('healthy-1', 'permission_blocked', { anomaly: undefined })],
      send: vi.fn(),
    });
    expect(container.querySelector('.btn-snooze-all')).toBeNull();
  });

  test('confirming a bulk snooze sends one snooze action per finding', () => {
    const send = vi.fn();
    root = renderPanel(container, {
      findings: [makeFinding('a'), makeFinding('b'), makeFinding('c')],
      send,
    });

    const button = container.querySelector('.btn-snooze-all');
    expect(button).not.toBeNull();
    click(button!);

    // The duration picker (the required confirm step) is now open, and its
    // heading names how many findings are in scope.
    expect(document.querySelector('.snooze-dialog-title')?.textContent).toContain('3 findings');
    const presets = Array.from(document.querySelectorAll('.snooze-dialog-btn')) as HTMLElement[];
    const oneHour = presets.find((b) => b.textContent?.includes('1h'));
    expect(oneHour).toBeDefined();
    click(oneHour!);

    const snoozes = send.mock.calls.map((c) => c[0]).filter((m: ClientMessage) => m.type === 'snooze');
    expect(snoozes).toHaveLength(3);
    for (const msg of snoozes) {
      expect(msg.durationMs).toBe(60 * 60 * 1000);
    }
    expect(snoozes.map((m: { agentId: string }) => m.agentId).sort()).toEqual(['a', 'b', 'c']);
    // Every snooze carries the finding's taskId so the server targets the right task.
    expect(snoozes.map((m: { taskId?: string }) => m.taskId).sort()).toEqual(['task-a', 'task-b', 'task-c']);
    // The dialog closes after confirming.
    expect(document.querySelector('.snooze-dialog')).toBeNull();
  });

  test('cancelling the dialog is a no-op — no snooze is sent', () => {
    const send = vi.fn();
    root = renderPanel(container, {
      findings: [makeFinding('a'), makeFinding('b')],
      send,
    });

    click(container.querySelector('.btn-snooze-all')!);
    expect(document.querySelector('.snooze-dialog')).not.toBeNull();

    pressEscape();

    expect(document.querySelector('.snooze-dialog')).toBeNull();
    expect(send.mock.calls.some((c) => (c[0] as ClientMessage).type === 'snooze')).toBe(false);
  });

  test('scope is the visible findings only — an active type filter narrows the fan-out', () => {
    // Two findings of different types; the operator has filtered the rail to
    // permission_blocked, so only the "a" card is visible.
    localStorage.setItem(FINDING_TYPE_FILTER_KEY, JSON.stringify(['permission_blocked']));
    const send = vi.fn();
    root = renderPanel(container, {
      findings: [makeFinding('a', 'permission_blocked'), makeFinding('b', 'needs_input')],
      send,
    });

    // Count reflects the visible subset, not the raw bucket.
    click(container.querySelector('.btn-snooze-all')!);
    expect(document.querySelector('.snooze-dialog-title')?.textContent).toContain('1 finding');

    const oneHour = (Array.from(document.querySelectorAll('.snooze-dialog-btn')) as HTMLElement[])
      .find((b) => b.textContent?.includes('1h'));
    click(oneHour!);

    const snoozes = send.mock.calls.map((c) => c[0]).filter((m: ClientMessage) => m.type === 'snooze');
    expect(snoozes).toHaveLength(1);
    expect((snoozes[0] as { agentId: string }).agentId).toBe('a');
    // The filtered-out finding must NOT be snoozed.
    expect(snoozes.some((m: { agentId: string }) => m.agentId === 'b')).toBe(false);
  });
});

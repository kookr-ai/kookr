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

function makeSnoozed(agentId: string, overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId,
    taskId: `task-${agentId}`,
    taskName: `${agentId} task`,
    description: 'Snoozed',
    events: [],
    taskStatus: 'inProgress',
    cwd: '/tmp/project',
    snoozedUntil: Date.now() + 60 * 60 * 1000,
    ...overrides,
  } as AgentState;
}

function renderPanel(
  container: HTMLElement,
  props: { snoozed: AgentState[]; send: (msg: ClientMessage) => void },
): Root {
  const root = createRoot(container);
  act(() => {
    root.render(
      <FindingsPanel
        findings={[]}
        healthy={[]}
        pending={[]}
        snoozed={props.snoozed}
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

describe('FindingsPanel "Resume all" bulk control (issue #2550)', () => {
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

  test('is not rendered when there are no snoozed findings', () => {
    root = renderPanel(container, { snoozed: [], send: vi.fn() });
    expect(container.querySelector('.btn-resume-all')).toBeNull();
  });

  test('is not rendered when every snoozed finding is suppressed', () => {
    // Suppressed (Paused) rows are out of scope — no per-row "Resume now" either.
    root = renderPanel(container, {
      snoozed: [makeSnoozed('a', { suppressed: true }), makeSnoozed('b', { suppressed: true })],
      send: vi.fn(),
    });
    expect(container.querySelector('.btn-resume-all')).toBeNull();
  });

  test('clicking it sends one cancelSnooze per snoozed finding', () => {
    const send = vi.fn();
    root = renderPanel(container, {
      snoozed: [makeSnoozed('a'), makeSnoozed('b'), makeSnoozed('c')],
      send,
    });

    const button = container.querySelector('.btn-resume-all');
    expect(button).not.toBeNull();
    click(button!);

    const resumes = send.mock.calls
      .map((c) => c[0] as ClientMessage)
      .filter((m) => m.type === 'cancelSnooze');
    expect(resumes).toHaveLength(3);
    expect(resumes.map((m) => (m as { agentId: string }).agentId).sort()).toEqual(['a', 'b', 'c']);
    // Every cancelSnooze carries the finding's taskId so the server targets the right task.
    expect(resumes.map((m) => (m as { taskId?: string }).taskId).sort()).toEqual([
      'task-a',
      'task-b',
      'task-c',
    ]);
  });

  test('suppressed findings are excluded from the bulk resume', () => {
    const send = vi.fn();
    root = renderPanel(container, {
      snoozed: [makeSnoozed('a'), makeSnoozed('suppressed-1', { suppressed: true })],
      send,
    });

    click(container.querySelector('.btn-resume-all')!);

    const resumes = send.mock.calls
      .map((c) => c[0] as ClientMessage)
      .filter((m) => m.type === 'cancelSnooze');
    expect(resumes).toHaveLength(1);
    expect((resumes[0] as { agentId: string }).agentId).toBe('a');
    expect(resumes.some((m) => (m as { agentId: string }).agentId === 'suppressed-1')).toBe(false);
  });
});

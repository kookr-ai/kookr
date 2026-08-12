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

const EXPLANATION = 'Blocked on a Bash permission prompt';

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: 'agent-1',
    taskId: 'task-1',
    taskName: 'Task 1',
    description: 'Working',
    events: [],
    anomaly: {
      agentId: 'agent-1',
      type: 'permission_blocked',
      severity: 'warning',
      explanation: EXPLANATION,
      detectedAt: new Date('2026-06-11T08:00:00Z'),
    },
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
        send={vi.fn()}
        clearCompletedFinishedCount={0}
        clearCompletedTerminatedCount={0}
      />,
    );
  });
  return root;
}

describe('FindingCard copy-explanation button', () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let writeText: ReturnType<typeof vi.fn>;

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
    writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
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

  test('renders a copy control next to the explanation', () => {
    root = renderPanel(container, [makeAgent()]);
    const btn = container.querySelector('.copy-explanation');
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute('aria-label')).toBe('Copy explanation');
    // Sits alongside the explanation text within the same row.
    const row = container.querySelector('.finding-explanation-row');
    expect(row?.querySelector('.finding-explanation')).not.toBeNull();
    expect(row?.querySelector('.copy-explanation')).not.toBeNull();
  });

  test('writes the explanation text to the clipboard when activated', async () => {
    root = renderPanel(container, [makeAgent()]);
    const btn = container.querySelector('.copy-explanation') as HTMLButtonElement;
    expect(btn).not.toBeNull();

    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(EXPLANATION);
  });

  test('stays un-copied when the clipboard write is rejected', async () => {
    writeText.mockImplementationOnce(async () => {
      throw new Error('clipboard denied');
    });
    root = renderPanel(container, [makeAgent()]);
    const btn = container.querySelector('.copy-explanation') as HTMLButtonElement;

    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    // The rejection is swallowed (no throw escapes act) and no "Copied" state sticks.
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(btn.className).not.toContain('copied');
  });

  test('omits the copy control when the finding has no anomaly', () => {
    root = renderPanel(container, [makeAgent({ anomaly: undefined })]);
    expect(container.querySelector('.copy-explanation')).toBeNull();
  });
});

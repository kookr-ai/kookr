// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FindingsPanel } from '../FindingsPanel.js';
import { createKookrStore, useKookrStore } from '../../store/useStore.js';
import type { AgentState } from '../../../shared/protocol.js';
import { RECOMMENDED_RESPONSES } from './recommendedResponses.js';

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
    taskName: 'Task 1',
    description: 'Working',
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

describe('FindingCard recommended-response line', () => {
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

  test('renders the catalog recommendation under the explanation', () => {
    root = renderPanel(container, [makeAgent()]);
    const rec = container.querySelector('.finding-recommended');
    expect(rec).not.toBeNull();
    expect(rec?.textContent).toContain('Recommended:');
    expect(rec?.textContent).toContain(RECOMMENDED_RESPONSES.permission_blocked);
  });

  test('omits the recommendation line when the finding has no anomaly', () => {
    root = renderPanel(container, [makeAgent({ anomaly: undefined })]);
    expect(container.querySelector('.finding-recommended')).toBeNull();
  });

  test('renders the recommendation after the explanation node', () => {
    root = renderPanel(container, [makeAgent()]);
    const explanation = container.querySelector('.finding-explanation');
    const rec = container.querySelector('.finding-recommended');
    expect(explanation).not.toBeNull();
    expect(rec).not.toBeNull();
    // DOCUMENT_POSITION_FOLLOWING (4) => rec comes after explanation in the DOM.
    expect(
      explanation!.compareDocumentPosition(rec!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

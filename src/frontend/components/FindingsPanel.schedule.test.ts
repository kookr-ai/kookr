// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FindingsPanel } from './FindingsPanel.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { AgentState, ClientMessage } from '../../shared/protocol.js';
import type { SchedulePrefill } from './SchedulesDialog.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function agent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: overrides.agentId ?? 'agent-1',
    taskId: overrides.taskId ?? 'task-1',
    taskName: overrides.taskName ?? 'Nightly triage',
    description: 'Working',
    events: [],
    anomaly: null,
    taskStatus: 'inProgress',
    cwd: '/tmp/project',
    ...overrides,
  } as AgentState;
}

function renderPanel(
  container: HTMLElement,
  lists: Partial<Pick<React.ComponentProps<typeof FindingsPanel>, 'healthy' | 'completed'>>,
  onSchedulePlaybook?: (p: SchedulePrefill) => void,
  selection: { selectedAgentId: string | null; selectedTaskId: string | null } = {
    selectedAgentId: null,
    selectedTaskId: null,
  },
): Root {
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(FindingsPanel, {
      findings: [],
      healthy: lists.healthy ?? [],
      pending: [],
      completed: lists.completed ?? [],
      snoozed: [],
      selectedAgentId: selection.selectedAgentId,
      selectedTaskId: selection.selectedTaskId,
      send: vi.fn() as (msg: ClientMessage) => void,
      clearCompletedFinishedCount: 0,
      clearCompletedTerminatedCount: 0,
      onSchedulePlaybook,
    }));
  });
  return root;
}

function scheduleButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button.schedule-playbook-btn'));
}

describe('FindingsPanel schedule button', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
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

  test('shows the button only for playbook-backed tasks', () => {
    root = renderPanel(container, {
      healthy: [
        agent({ agentId: 'a', taskId: 't-a', playbookId: 'triage.md' }),
        agent({ agentId: 'b', taskId: 't-b' }), // no playbookId
      ],
    }, vi.fn());
    expect(scheduleButtons(container)).toHaveLength(1);
  });

  test('appears for a single-run completed playbook task', () => {
    root = renderPanel(container, {
      completed: [agent({ agentId: 'c', taskId: 't-c', taskStatus: 'completed', playbookId: 'triage.md' })],
    }, vi.fn());
    // The Completed section is collapsed by default — expand it first.
    act(() => {
      container.querySelector<HTMLElement>('.completed-section .findings-section-toggle')?.click();
    });
    expect(scheduleButtons(container)).toHaveLength(1);
  });

  test('is hidden when no scheduler callback is wired', () => {
    root = renderPanel(container, {
      healthy: [agent({ playbookId: 'triage.md' })],
    }, undefined);
    expect(scheduleButtons(container)).toHaveLength(0);
  });

  test('fires onSchedulePlaybook with the playbook prefill and does not select the row', () => {
    const onSchedule = vi.fn();
    const selectSpy = vi.spyOn(useKookrStore.getState(), 'selectAgent');
    root = renderPanel(container, {
      healthy: [agent({
        agentId: 'a',
        taskId: 't-a',
        taskName: 'Nightly triage',
        cwd: '/repo',
        playbookId: 'triage.md',
        playbookSource: {
          id: 'triage.md',
          scope: 'user',
          sourceCwd: '/user/playbooks',
          sourceDigest: 'sha256:original',
        },
        playbookParameterValues: { repo: 'owner/repo', label: 'priority' },
      })],
    }, onSchedule);

    act(() => { scheduleButtons(container)[0].click(); });

    expect(onSchedule).toHaveBeenCalledWith({
      cwd: '/repo',
      playbookSource: {
        id: 'triage.md',
        scope: 'user',
        sourceCwd: '/user/playbooks',
        sourceDigest: 'sha256:original',
      },
      playbookParameterValues: { repo: 'owner/repo', label: 'priority' },
      name: 'Nightly triage',
    });
    // stopPropagation: clicking the button must not select the underlying row.
    expect(selectSpy).not.toHaveBeenCalled();
    // Positive control: clicking the row itself DOES select — proves selection is
    // reachable in this harness, so the negative assertion above isn't vacuous.
    act(() => { container.querySelector<HTMLElement>('.healthy-row')?.click(); });
    expect(selectSpy).toHaveBeenCalledWith('a', 't-a');
  });

  test('renders one button per grouped playbook even when expanded (header only)', () => {
    // Two runs of the same playbook collapse into a group; the header carries
    // the single schedule button, and the per-iteration rows do not repeat it —
    // even after expanding the group.
    root = renderPanel(container, {
      healthy: [
        agent({ agentId: 'r1', taskId: 't1', playbookId: 'triage.md', startedAt: '2026-06-20T01:00:00Z' }),
        agent({ agentId: 'r2', taskId: 't2', playbookId: 'triage.md', startedAt: '2026-06-20T02:00:00Z' }),
      ],
    }, vi.fn());
    expect(scheduleButtons(container)).toHaveLength(1);
    // Expand the group so all iteration rows render; the count must stay 1.
    act(() => { container.querySelector<HTMLElement>('.playbook-group-header')?.click(); });
    expect(container.querySelectorAll('.healthy-row').length).toBeGreaterThan(1);
    expect(scheduleButtons(container)).toHaveLength(1);
  });

  test('selects the clicked task when healthy rows share one session id', () => {
    const selectSpy = vi.spyOn(useKookrStore.getState(), 'selectAgent');
    root = renderPanel(container, {
      healthy: [
        agent({ agentId: 'shared-session', taskId: 'coordinator-task', taskName: 'Coordinator' }),
        agent({ agentId: 'shared-session', taskId: 'completed-task', taskName: 'Completed' }),
      ],
    }, undefined, { selectedAgentId: 'shared-session', selectedTaskId: 'completed-task' });

    const rows = Array.from(container.querySelectorAll<HTMLElement>('.healthy-row'));
    expect(rows).toHaveLength(2);

    act(() => { rows[0].click(); });

    expect(selectSpy).toHaveBeenCalledWith('shared-session', 'coordinator-task');
  });
});

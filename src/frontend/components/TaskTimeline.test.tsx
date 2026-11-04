// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentState } from '../../shared/contracts/agent-state.js';
import { TaskTimeline } from './TaskTimeline.js';

describe('TaskTimeline', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test('separates task creation, terminal transition, and archive time', () => {
    const agent: AgentState = {
      agentId: 'done-t1', taskId: 't1', taskStatus: 'completed', events: [], anomaly: null,
      taskCreatedAt: '2026-11-04T10:00:00.000Z',
      sessionCreatedAt: '2026-11-04T10:01:00.000Z',
      terminalAt: '2026-11-04T11:00:00.000Z', terminalAtSource: 'terminal_receipt',
      archivedAt: '2026-11-04T11:05:00.000Z',
    };
    act(() => root.render(<TaskTimeline agent={agent} />));
    expect(container.textContent).toContain('Task created');
    expect(container.textContent).toContain('Kookr session recorded');
    expect(container.textContent).toContain('Task became terminal');
    expect(container.textContent).toContain('Archived');
    expect(container.textContent).toContain('No separate close time recorded');
    expect(container.querySelectorAll('time')).toHaveLength(4);
  });

  test('does not invent terminal duration or a missing timestamp', () => {
    const agent: AgentState = {
      agentId: 'done-t2', taskId: 't2', taskStatus: 'cancelled', events: [], anomaly: null,
      taskCreatedAt: '2026-11-04T10:00:00.000Z', terminalAtSource: 'task_updated_at',
    };
    act(() => root.render(<TaskTimeline agent={agent} />));
    expect(container.textContent).toContain('Task age at last recorded evidence');
    expect(container.textContent).toContain('Execution runtime');
    expect(container.textContent).toContain('Unavailable — no session end time recorded');
    expect(container.querySelectorAll('time')).toHaveLength(1);
  });

  test.each([
    ['last_session_activity', 'Last observed hook activity'],
    ['task_updated_at', 'Task record updated'],
  ] as const)('labels %s as evidence, not a known status transition', (source, label) => {
    const agent: AgentState = {
      agentId: 'done-t3', taskId: 't3', taskStatus: 'terminated', events: [], anomaly: null,
      taskCreatedAt: '2026-11-04T10:00:00.000Z',
      terminalAt: '2026-11-04T10:30:00.000Z', terminalAtSource: source,
    };
    act(() => root.render(<TaskTimeline agent={agent} />));
    expect(container.textContent).toContain(label);
    expect(container.textContent).toContain('Task age at last recorded evidence');
    expect(container.textContent).toContain('Unavailable — no session end time recorded');
  });

  test('updates the running task and session ages as the clock advances', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T10:02:00.000Z'));
    const agent: AgentState = {
      agentId: 'live-t4', taskId: 't4', taskStatus: 'running', events: [], anomaly: null,
      taskCreatedAt: '2026-11-04T10:00:00.000Z', sessionCreatedAt: '2026-11-04T10:01:00.000Z',
    };
    try {
      act(() => root.render(<TaskTimeline agent={agent} />));
      expect(container.textContent).toContain('2m');
      act(() => { vi.advanceTimersByTime(60_000); });
      expect(container.textContent).toContain('3m');
      expect(container.textContent).toContain('Session age');
    } finally {
      vi.useRealTimers();
    }
  });
});

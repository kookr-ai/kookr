// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
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
});

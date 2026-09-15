// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { HealthyRow } from './HealthyRow.js';
import { createKookrStore, useKookrStore } from '../../store/useStore.js';
import type { AgentState, TokenUsage } from '../../../shared/protocol.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 4,
    ...overrides,
  };
}

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: 'agent-1',
    taskId: 'task-1',
    taskName: 'Healthy task',
    description: 'Working',
    events: [],
    anomaly: null,
    taskStatus: 'inProgress',
    cwd: '/tmp/project',
    startedAt: '2026-06-11T10:00:00.000Z',
    ...overrides,
  } as AgentState;
}

function renderRow(container: HTMLElement, agent: AgentState): Root {
  const root = createRoot(container);
  act(() => {
    root.render(
      <HealthyRow
        agent={agent}
        selected={false}
        send={vi.fn()}
      />,
    );
  });
  return root;
}

describe('HealthyRow cost-rate', () => {
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
        json: async () => ({}),
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

  test('appends compact $/h after the lump-sum cost once the session is older than two minutes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T11:00:00.000Z'));
    root = renderRow(container, makeAgent({ tokenUsage: usage() }));
    expect(container.querySelector('.healthy-row-cost')?.textContent).toBe(
      '$4.00 / 1.2k tok · $4.00/h',
    );
  });

  test('omits the rate when the session is younger than two minutes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T10:01:00.000Z'));
    root = renderRow(container, makeAgent({ tokenUsage: usage() }));
    const cost = container.querySelector('.healthy-row-cost')?.textContent ?? '';
    expect(cost).toBe('$4.00 / 1.2k tok');
    expect(cost).not.toMatch(/\/h/);
    expect(cost).not.toMatch(/\$0\.00\/h/);
  });

  test('omits the rate when cost is zero', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T11:00:00.000Z'));
    root = renderRow(container, makeAgent({ tokenUsage: usage({ costUsd: 0 }) }));
    const cost = container.querySelector('.healthy-row-cost')?.textContent ?? '';
    expect(cost).toBe('1.2k tok');
    expect(cost).not.toMatch(/\/h/);
    expect(cost).not.toMatch(/\$0\.00\/h/);
  });

  test('omits the rate and the cost span when usage is unknown', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T11:00:00.000Z'));
    root = renderRow(container, makeAgent());
    expect(container.querySelector('.healthy-row-cost')).toBeNull();
    expect(container.textContent).not.toMatch(/\$0\.00\/h/);
  });
});

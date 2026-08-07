// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ReapWarningBanners } from './ReapWarningBanner.js';
import type { AgentState } from '../../shared/protocol.js';

function agentWithWarning(over: Partial<AgentState> & { reapWarning?: AgentState['reapWarning'] }): AgentState {
  return {
    agentId: 'sess-1',
    taskId: 'task-1',
    taskName: 'Fix the flaky test',
    events: [],
    ...over,
  } as AgentState;
}

describe('ReapWarningBanners', () => {
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
    vi.restoreAllMocks();
  });

  test('renders nothing when no agent has a warning', () => {
    act(() => root.render(<ReapWarningBanners agents={[agentWithWarning({})]} send={vi.fn()} />));
    expect(container.querySelector('.reap-warning-banner')).toBeNull();
  });

  test('renders a countdown banner and a keep-alive button for a warned task', () => {
    const agent = agentWithWarning({
      reapWarning: { remainingMs: 90_000, silentForMs: 3 * 3_600_000, keptAliveCount: 0, vetoCapReached: false, heldByPresence: false },
    });
    act(() => root.render(<ReapWarningBanners agents={[agent]} send={vi.fn()} />));
    const banner = container.querySelector('.reap-warning-banner');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain('Fix the flaky test');
    expect(banner!.textContent).toContain('1:30');
    const button = container.querySelector('.reap-warning-keepalive') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  test('clicking keep-alive sends keepTaskAlive for the task', () => {
    const send = vi.fn();
    const agent = agentWithWarning({
      reapWarning: { remainingMs: 60_000, silentForMs: 3 * 3_600_000, keptAliveCount: 1, vetoCapReached: false, heldByPresence: false },
    });
    act(() => root.render(<ReapWarningBanners agents={[agent]} send={send} />));
    const button = container.querySelector('.reap-warning-keepalive') as HTMLButtonElement;
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(send).toHaveBeenCalledWith({ type: 'keepTaskAlive', taskId: 'task-1' });
  });

  test('disables the button and points to messaging when the veto cap is reached', () => {
    const send = vi.fn();
    const agent = agentWithWarning({
      reapWarning: { remainingMs: 30_000, silentForMs: 3 * 3_600_000, keptAliveCount: 3, vetoCapReached: true, heldByPresence: false },
    });
    act(() => root.render(<ReapWarningBanners agents={[agent]} send={send} />));
    const button = container.querySelector('.reap-warning-keepalive') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(container.querySelector('.reap-warning-banner')!.textContent).toContain('type a message and send it');
  });

  test('shows the presence-held state when heldByPresence', () => {
    const agent = agentWithWarning({
      reapWarning: { remainingMs: 120_000, silentForMs: 3 * 3_600_000, keptAliveCount: 0, vetoCapReached: false, heldByPresence: true },
    });
    act(() => root.render(<ReapWarningBanners agents={[agent]} send={vi.fn()} />));
    expect(container.querySelector('.reap-warning-banner')!.textContent).toContain('paused while you have this task open');
  });
});

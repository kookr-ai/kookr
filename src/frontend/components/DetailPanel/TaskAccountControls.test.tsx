// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TaskAccountBadge, TaskAccountBanner } from './TaskAccountControls.js';
import { resetClaudeAccountsStore } from '../../store/claude-accounts.js';
import {
  fakeSwitchSocket,
  installFakeAccountsServer,
  type FakeAccountsServer,
  type FakeSwitchSocket,
} from '../../store/claude-accounts-fixtures.js';
import type { AgentState } from '../../../shared/contracts/agent-state.js';

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

function agent(extra: Record<string, unknown> = {}): AgentState {
  return { agentId: 'a1', taskId: 't1', agentType: 'claude-code', ...extra } as unknown as AgentState;
}

describe('task account controls', () => {
  let container: HTMLDivElement;
  let root: Root;
  let server: FakeAccountsServer;
  let socket: FakeSwitchSocket;
  const q = <T extends Element>(sel: string) => container.querySelector<T>(sel);
  const buttonByText = (text: string) =>
    Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim().startsWith(text));
  const click = async (el: Element | null | undefined) => {
    await act(async () => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    await flush();
  };
  async function mount(node: React.ReactElement) {
    act(() => { root.render(node); });
    await flush();
  }

  beforeEach(() => {
    resetClaudeAccountsStore();
    socket = fakeSwitchSocket();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  test('badge shows the account and the menu sends the switch over the socket, marking the current account', async () => {
    server = installFakeAccountsServer(['pro']);
    await mount(<TaskAccountBadge agent={agent({ claudeAccount: 'host' })} send={socket.send} />);
    expect(q('[data-testid="task-account-badge"]')!.textContent).toContain('Account host');
    await click(q('[data-testid="task-account-badge"]'));
    expect(q('[data-testid="task-account-menu"]')!.textContent).toContain('Move this task to');
    expect(q('[data-testid="task-account-menu"]')!.textContent).toContain('Restarts the agent in place and continues its conversation');
    const items = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
    expect(items.find((i) => i.textContent?.includes('host'))!.disabled).toBe(true);
    await click(items.find((i) => i.textContent === 'pro'));
    expect(socket.switches).toEqual([{ taskId: 't1', account: 'pro' }]);
    // The supervisor-gated HTTP route is not used: it would answer 401 when KOOKR_SUPERVISOR_TOKEN is set.
    expect(server.calls.some((c) => c.url.startsWith('/api/tasks/'))).toBe(false);
    expect(q('[data-testid="task-account-result"]')!.textContent).toBe('Moved to pro.');
  });

  test('shows the server refusal text inline', async () => {
    server = installFakeAccountsServer(['pro']);
    socket.refuse = { error: 'No conversation recorded yet', code: 'no_session' };
    await mount(<TaskAccountBadge agent={agent()} send={socket.send} />);
    await click(q('[data-testid="task-account-badge"]'));
    await click(Array.from(container.querySelectorAll('[role="menuitemradio"]')).find((i) => i.textContent === 'pro'));
    expect(q('[data-testid="task-account-result"]')!.textContent).toBe('No conversation recorded yet');
  });

  test('says so when the dashboard is not connected', async () => {
    server = installFakeAccountsServer(['pro']);
    socket.connected = false;
    await mount(<TaskAccountBadge agent={agent()} send={socket.send} />);
    await click(q('[data-testid="task-account-badge"]'));
    await click(Array.from(container.querySelectorAll('[role="menuitemradio"]')).find((i) => i.textContent === 'pro'));
    expect(q('[data-testid="task-account-result"]')!.textContent).toContain('Not connected to Kookr');
    expect(socket.switches).toEqual([]);
  });

  test('a queued task with no account yet shows the default, and every account can be pinned', async () => {
    server = installFakeAccountsServer(['pro'], 'pro');
    await mount(<TaskAccountBadge agent={agent({ agentId: 'pending-t1', taskStatus: 'pending' })} send={socket.send} />);
    expect(q('[data-testid="task-account-badge"]')!.textContent).toContain('Account Default (pro)');
    await click(q('[data-testid="task-account-badge"]'));
    const items = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
    expect(items.map((i) => [i.textContent, i.disabled, i.getAttribute('aria-checked')])).toEqual([
      ['host', false, 'false'],
      ['prodefault', false, 'false'],
    ]);
    await click(items.find((i) => i.textContent === 'host'));
    expect(socket.switches).toEqual([{ taskId: 't1', account: 'host' }]);
  });

  test('a queued task already pinned, or one that is running unpinned, keeps showing its account', async () => {
    server = installFakeAccountsServer(['pro'], 'pro');
    await mount(<TaskAccountBadge agent={agent({ taskStatus: 'pending', claudeAccount: 'host' })} send={socket.send} />);
    expect(q('[data-testid="task-account-badge"]')!.textContent).toContain('Account host');
    await mount(<TaskAccountBadge agent={agent({ taskStatus: 'inProgress' })} send={socket.send} />);
    expect(q('[data-testid="task-account-badge"]')!.textContent).toContain('Account host');
  });

  test('renders nothing for other agents or when only host exists', async () => {
    server = installFakeAccountsServer([]);
    await mount(<><TaskAccountBadge agent={agent()} send={socket.send} /><TaskAccountBanner agent={agent({ stuckReason: 'provider_paused' })} send={socket.send} /></>);
    expect(q('[data-testid="task-account-badge"]')).toBeNull();
    server = installFakeAccountsServer(['pro']);
    resetClaudeAccountsStore();
    await mount(<><TaskAccountBadge agent={agent({ agentType: 'codex-cli' })} send={socket.send} /><TaskAccountBanner agent={agent({ agentType: 'codex-cli', stuckReason: 'provider_paused' })} send={socket.send} /></>);
    expect(container.innerHTML).toBe('');
  });

  test('provider-paused banner offers Continue on the first account not known to be limited', async () => {
    server = installFakeAccountsServer(['pro', 'work']);
    server.testOutcomes = { pro: 'usage_limited' };
    await mount(<TaskAccountBanner agent={agent({ stuckReason: 'provider_paused' })} send={socket.send} />);
    expect(q('[data-testid="task-account-banner"]')!.textContent).toContain("This task stopped on host's usage limit.");
    expect(buttonByText('Continue on')!.textContent).toBe('Continue on pro');
    // Learning that pro is out of quota moves the suggestion to work.
    const { testAccount } = await import('../../store/claude-accounts.js');
    await act(async () => { await testAccount('pro'); });
    await flush();
    expect(buttonByText('Continue on')!.textContent).toBe('Continue on work');
    await click(buttonByText('Continue on'));
    expect(socket.switches).toEqual([{ taskId: 't1', account: 'work' }]);
    expect(q('[data-testid="task-account-result"]')!.textContent).toBe('Moved to work.');
    expect(buttonByText('Test host')).toBeDefined();
  });

  test('no banner on a claude-code task that is not provider-paused', async () => {
    server = installFakeAccountsServer(['pro']);
    await mount(<><TaskAccountBanner agent={agent()} send={socket.send} /><TaskAccountBanner agent={agent({ stuckReason: 'hung_suspect' })} send={socket.send} /></>);
    expect(q('[data-testid="task-account-banner"]')).toBeNull();
    // The badge still renders, so the account list did load.
    await mount(<TaskAccountBadge agent={agent()} send={socket.send} />);
    expect(buttonByText('Account')).toBeDefined();
  });

  test('banner offers Add an account when only host exists', async () => {
    server = installFakeAccountsServer([]);
    const onOpen = vi.fn();
    await mount(<TaskAccountBanner agent={agent({ stuckReason: 'provider_paused' })} send={socket.send} onOpenAccountSettings={onOpen} />);
    await click(buttonByText('Add an account'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(buttonByText('Continue on')).toBeUndefined();
  });
});

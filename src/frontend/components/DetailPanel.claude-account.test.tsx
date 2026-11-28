// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentState } from '../../shared/protocol.js';
import type { ClientMessage } from '../../shared/contracts/messages.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { resetClaudeAccountsStore } from '../store/claude-accounts.js';
import { installFakeAccountsServer } from '../store/claude-accounts-fixtures.js';
import { DetailPanel } from './DetailPanel.js';

vi.mock('../telemetry.js', () => ({ track: vi.fn(), trackClick: vi.fn() }));
vi.mock('./ActivityPanel.js', () => ({ ActivityPanel: () => React.createElement('div', { 'data-testid': 'activity-panel' }) }));
vi.mock('./GitHubPanel.js', () => ({ GitHubPanel: () => React.createElement('div', { 'data-testid': 'github-panel' }) }));
vi.mock('./TerminalPanel.js', () => ({ TerminalPanel: () => React.createElement('div', { 'data-testid': 'terminal-panel' }) }));
vi.mock('./DiffPane.js', () => ({ DiffPane: () => React.createElement('div', { 'data-testid': 'diff-pane' }) }));
vi.mock('./SnoozeDialog.js', () => ({ SnoozeDialog: () => null }));
vi.mock('./EffectiveHookSettingsModal.js', () => ({ EffectiveHookSettingsModal: () => null }));

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  useKookrStore.setState(Object.fromEntries(Object.entries(freshState).filter(([, value]) => typeof value !== 'function')));
}

/**
 * The badge and the banner have their own tests; this one proves DetailPanel
 * renders them for a Claude Code task and gives them its socket `send`.
 */
describe('DetailPanel: Claude account controls', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    resetClaudeAccountsStore();
    installFakeAccountsServer(['pro']);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    resetClaudeAccountsStore();
    container.remove();
    vi.unstubAllGlobals();
  });

  test('shows the account badge and the usage-limit banner, and moves the task through the panel\'s socket', async () => {
    const send = vi.fn((_msg: ClientMessage) => true);
    const agent: AgentState = {
      agentId: 'kookr-a1',
      taskId: 'task-1',
      taskName: 'Paused on quota',
      events: [],
      anomaly: null,
      taskStatus: 'inProgress',
      agentType: 'claude-code',
      cwd: '/repo',
      startedAt: '2026-06-11T12:00:00.000Z',
      stuckReason: 'provider_paused',
    } as AgentState;
    await act(async () => {
      root.render(React.createElement(DetailPanel, { agent, send, onLaunch: vi.fn(), onRequestComplete: vi.fn() }));
    });
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

    expect(container.querySelector('[data-testid="task-account-badge"]')?.textContent).toContain('Account host');
    const banner = container.querySelector('[data-testid="task-account-banner"]');
    expect(banner?.textContent).toContain("This task stopped on host's usage limit.");

    const continueOn = Array.from(banner!.querySelectorAll('button')).find((b) => b.textContent === 'Continue on pro');
    await act(async () => { continueOn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'switchClaudeAccount', taskId: 'task-1', account: 'pro' }));
  });
});

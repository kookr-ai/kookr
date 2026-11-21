// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LaunchTaskDialog } from './LaunchTaskDialog.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { resetClaudeAccountsStore } from '../store/claude-accounts.js';
import { installFakeAccountsServer } from '../store/claude-accounts-fixtures.js';
import type { ClientMessage } from '../../shared/protocol.js';

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

describe('LaunchTaskDialog Claude account picker', () => {
  let container: HTMLDivElement;
  let root: Root;
  let sent: ClientMessage[];

  async function mount() {
    sent = [];
    act(() => {
      root.render(React.createElement(LaunchTaskDialog, {
        send: (msg: ClientMessage) => { sent.push(msg); return true; },
        onClose: () => {},
        defaultAgentType: 'claude-code',
      }));
    });
    await flush();
  }
  const accountSelect = () => container.querySelector<HTMLSelectElement>('select[aria-label="Claude account"]');

  async function submit() {
    await act(async () => { setValue(container.querySelector('textarea')!, 'do the thing'); });
    await act(async () => { setValue(container.querySelector<HTMLInputElement>('.combo-input input[type="text"]')!, '/tmp/work'); });
    await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await flush();
  }

  beforeEach(() => {
    localStorage.clear();
    resetClaudeAccountsStore();
    const fresh = createKookrStore().getState();
    useKookrStore.setState({
      ...Object.fromEntries(Object.entries(fresh).filter(([, v]) => typeof v !== 'function')),
      serverCwd: '/tmp/work',
      sttUrl: '',
      availableAgentTypes: [{ type: 'claude-code', label: 'Claude Code' }],
    } as never);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  test('is hidden while only host is registered and the launch carries no claudeAccount', async () => {
    installFakeAccountsServer([]);
    await mount();
    expect(accountSelect()).toBeNull();
    await submit();
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty('claudeAccount');
  });

  test('offers Default (<name>), host and the registered names, and sends the chosen one', async () => {
    installFakeAccountsServer(['pro', 'work'], 'pro');
    await mount();
    const select = accountSelect()!;
    expect(select).not.toBeNull();
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Default (pro)', 'host', 'pro', 'work']);
    await act(async () => { setValue(select, 'work'); });
    await submit();
    expect(sent[0]).toMatchObject({ type: 'launch', agentType: 'claude-code', claudeAccount: 'work' });
  });

  test('leaving it on Default sends no claudeAccount so the server default applies', async () => {
    installFakeAccountsServer(['pro'], 'pro');
    await mount();
    await submit();
    expect(sent[0]).not.toHaveProperty('claudeAccount');
  });
});

// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ClaudeAccountsSection } from './ClaudeAccountsSection.js';
import { resetClaudeAccountsStore } from '../store/claude-accounts.js';
import { installFakeAccountsServer, type FakeAccountsServer } from '../store/claude-accounts-fixtures.js';

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('ClaudeAccountsSection', () => {
  let container: HTMLDivElement;
  let root: Root;
  let server: FakeAccountsServer;

  const q = <T extends Element>(sel: string) => container.querySelector<T>(sel);
  const buttonByText = (scope: ParentNode, text: string) =>
    Array.from(scope.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
  const click = async (el: Element | null | undefined) => {
    await act(async () => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    await flush();
  };

  async function mount() {
    act(() => { root.render(React.createElement(ClaudeAccountsSection)); });
    await flush();
  }

  beforeEach(() => {
    resetClaudeAccountsStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  test('lists host first then registered accounts, with the default radio checked', async () => {
    server = installFakeAccountsServer(['pro', 'work'], 'pro');
    await mount();
    const rows = Array.from(container.querySelectorAll('.claude-account-row')).map((r) => r.getAttribute('data-testid'));
    expect(rows).toEqual(['claude-account-row-host', 'claude-account-row-pro', 'claude-account-row-work']);
    expect(q<HTMLInputElement>('[aria-label="Use pro for new tasks"]')!.checked).toBe(true);
    expect(q<HTMLInputElement>('[aria-label="Use host for new tasks"]')!.checked).toBe(false);
    expect(q('[data-testid="claude-account-row-pro"]')!.textContent).toContain('token ending wxyz');
    expect(q('[data-testid="claude-account-status-work"]')!.textContent).toBe('Not tested');
  });

  test('choosing a radio PUTs the default and the list refreshes from the response', async () => {
    server = installFakeAccountsServer(['pro']);
    await mount();
    await click(q('[aria-label="Use pro for new tasks"]'));
    expect(server.calls).toContainEqual({ method: 'PUT', url: '/api/claude-accounts/default', body: { name: 'pro' } });
    expect(q<HTMLInputElement>('[aria-label="Use pro for new tasks"]')!.checked).toBe(true);
  });

  test('every account has a Test button; an out-of-quota one reads "Test now" and re-tests', async () => {
    server = installFakeAccountsServer(['pro']);
    server.testOutcomes = { pro: 'usage_limited' };
    await mount();
    const host = q('[data-testid="claude-account-row-host"]')!;
    expect(buttonByText(host, 'Test')).toBeDefined();
    await click(buttonByText(q('[data-testid="claude-account-row-pro"]')!, 'Test'));
    expect(q('[data-testid="claude-account-status-pro"]')!.textContent).toBe('Out of quota');
    const again = buttonByText(q('[data-testid="claude-account-row-pro"]')!, 'Test now');
    expect(again).toBeDefined();
    server.testOutcomes = { pro: 'ok' };
    await click(again);
    expect(q('[data-testid="claude-account-status-pro"]')!.textContent).toBe('Working');
    expect(server.calls.filter((c) => c.url === '/api/claude-accounts/pro/test')).toHaveLength(2);
  });

  test('remove asks inline first and only DELETEs after confirming; host has no Remove', async () => {
    server = installFakeAccountsServer(['pro']);
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmSpy);
    await mount();
    expect(buttonByText(q('[data-testid="claude-account-row-host"]')!, 'Remove')).toBeUndefined();
    const row = () => q('[data-testid="claude-account-row-pro"]')!;
    await click(buttonByText(row(), 'Remove'));
    expect(row().textContent).toContain('Remove pro?');
    expect(server.calls.some((c) => c.method === 'DELETE')).toBe(false);
    await click(buttonByText(row(), 'Cancel'));
    expect(server.calls.some((c) => c.method === 'DELETE')).toBe(false);
    await click(buttonByText(row(), 'Remove'));
    await click(buttonByText(row(), 'Remove'));
    expect(server.calls).toContainEqual({ method: 'DELETE', url: '/api/claude-accounts/pro', body: undefined });
    expect(q('[data-testid="claude-account-row-pro"]')).toBeNull();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  test('add form titled "Add your second account" posts, tests, and clears the token', async () => {
    server = installFakeAccountsServer([]);
    await mount();
    expect(q('[data-testid="claude-account-add"]')!.textContent).toContain('Add your second account');
    const token = q<HTMLInputElement>('#claude-account-token')!;
    expect(token.type).toBe('password');
    setValue(q<HTMLInputElement>('#claude-account-name')!, 'work');
    setValue(q<HTMLInputElement>('#claude-account-label')!, 'me@example.com');
    setValue(token, 'sk-ant-oat01-secret');
    await click(buttonByText(container, 'Add and test'));
    expect(server.calls).toContainEqual({
      method: 'POST',
      url: '/api/claude-accounts',
      body: { name: 'work', token: 'sk-ant-oat01-secret', label: 'me@example.com' },
    });
    expect(server.calls.some((c) => c.url === '/api/claude-accounts/work/test')).toBe(true);
    expect(q<HTMLInputElement>('#claude-account-token')!.value).toBe('');
    expect(q('[data-testid="claude-account-row-work"]')).not.toBeNull();
    expect(q('[data-testid="claude-account-add"]')!.textContent).toContain('Add account');
    expect(container.innerHTML).not.toContain('secret');
  });

  test('shows the server error next to the matching field and still clears the token', async () => {
    server = installFakeAccountsServer([]);
    server.addError = { error: 'Name must be lowercase letters', code: 'invalid_name' };
    await mount();
    setValue(q<HTMLInputElement>('#claude-account-name')!, 'Bad Name');
    setValue(q<HTMLInputElement>('#claude-account-token')!, 'tok');
    await click(buttonByText(container, 'Add and test'));
    const field = q<HTMLInputElement>('#claude-account-name')!.parentElement!;
    expect(field.textContent).toContain('Name must be lowercase letters');
    expect(q<HTMLInputElement>('#claude-account-token')!.value).toBe('');
    expect(server.calls.some((c) => c.url.endsWith('/test'))).toBe(false);
  });
});

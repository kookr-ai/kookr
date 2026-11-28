// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { UsageSummary } from './UsageSummary.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { resetClaudeAccountsStore } from '../store/claude-accounts.js';
import { installFakeAccountsServer, type FakeAccountsServer } from '../store/claude-accounts-fixtures.js';

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

describe('footer account switcher', () => {
  let container: HTMLDivElement;
  let root: Root;
  let server: FakeAccountsServer;
  const q = <T extends Element>(sel: string) => container.querySelector<T>(sel);
  const click = async (el: Element | null | undefined) => {
    await act(async () => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    await flush();
  };

  async function mount(onOpenAccountSettings?: () => void, { withQuota = true }: { withQuota?: boolean } = {}) {
    const fresh = createKookrStore().getState();
    useKookrStore.setState({
      ...Object.fromEntries(Object.entries(fresh).filter(([, v]) => typeof v !== 'function')),
      ...(withQuota
        ? { quotaStatus: { fiveHour: { utilization: 40, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }, updatedAt: Date.now() } }
        : {}),
    } as never);
    act(() => {
      root.render(React.createElement(UsageSummary, { placement: 'nav', onOpenAccountSettings }));
    });
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

  test('is hidden when only host exists', async () => {
    server = installFakeAccountsServer([]);
    await mount();
    expect(server.calls.length).toBeGreaterThan(0);
    expect(q('[data-testid="account-chip"]')).toBeNull();
    expect(q('[data-testid="usage-quota-host-caption"]')).toBeNull();
  });

  test('still shows the chip when there is no quota or spend to show', async () => {
    server = installFakeAccountsServer(['pro', 'work'], 'pro');
    await mount(undefined, { withQuota: false });
    expect(useKookrStore.getState().quotaStatus).toBeFalsy();
    expect(q('[data-testid="account-chip"]')!.textContent).toContain('New tasks: pro');
  });

  test('names the default account and captions the quota as the host login when it is not host', async () => {
    server = installFakeAccountsServer(['pro'], 'pro');
    await mount();
    expect(q('[data-testid="account-chip"]')!.textContent).toContain('New tasks: pro');
    expect(q('[data-testid="usage-quota-host-caption"]')!.textContent).toBe('Quota: host login');
  });

  test('popover: radio sets the default, out-of-quota account keeps a Test now button, Manage opens settings', async () => {
    server = installFakeAccountsServer(['pro']);
    server.testOutcomes = { pro: 'usage_limited' };
    const onOpen = vi.fn();
    await mount(onOpen);
    expect(q('[data-testid="usage-quota-host-caption"]')).toBeNull();
    await click(q('[data-testid="account-chip"]'));
    const row = q('[data-testid="account-popover-row-pro"]')!;
    const testBtn = () => Array.from(q('[data-testid="account-popover-row-pro"]')!.querySelectorAll('button'))[0];
    await click(testBtn());
    expect(row.textContent).toContain('Out of quota');
    expect(testBtn().textContent).toBe('Test now');
    await click(row.querySelector('input[type="radio"]'));
    expect(server.calls).toContainEqual({ method: 'PUT', url: '/api/claude-accounts/default', body: { name: 'pro' } });
    expect(q('[data-testid="account-chip"]')!.textContent).toContain('New tasks: pro');
    const manage = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.startsWith('Manage accounts in Settings'));
    await click(manage);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="account-popover"]')).toBeNull();
  });

  test('popover: a tested account shows its own bars and the near-limit status', async () => {
    server = installFakeAccountsServer(['pro']);
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    server.testQuotas = {
      pro: {
        fiveHour: { utilization: 56, resetsAt, status: 'allowed_warning' },
        sevenDay: { utilization: 22, resetsAt, status: 'allowed' },
      },
    };
    await mount();
    await click(q('[data-testid="account-chip"]'));
    const row = () => q('[data-testid="account-popover-row-pro"]')!;
    expect(row().querySelector('[data-testid="usage-quota-5h"]')).toBeNull();
    await click(Array.from(row().querySelectorAll('button'))[0]);
    expect(row().querySelector('[data-testid="usage-quota-5h"]')!.textContent).toContain('56%');
    expect(row().querySelector('[data-testid="usage-quota-7d"]')!.textContent).toContain('22%');
    expect(q('[data-testid="account-popover-status-pro"]')!.textContent).toBe('Near limit');
    expect(row().textContent).toContain('5-hour quota is close to its limit.');
    expect(row().textContent).toMatch(/Measured by the test at/);
    expect(q('[data-testid="account-popover"]')!.textContent).toContain('An account\'s own bars appear after you test it.');
  });

  test('Escape closes the popover and returns focus to the chip', async () => {
    server = installFakeAccountsServer(['pro']);
    await mount();
    const chip = q<HTMLButtonElement>('[data-testid="account-chip"]')!;
    await click(chip);
    expect(q('[data-testid="account-popover"]')).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(q('[data-testid="account-popover"]')).toBeNull();
    expect(document.activeElement).toBe(chip);
  });
});

// @vitest-environment happy-dom

import { createElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  SWITCH_REPLY_TIMEOUT_MS,
  accountStatus,
  addAccount,
  failPendingClaudeAccountSwitches,
  handleClaudeAccountSwitchResult,
  nearLimitWindows,
  pickContinueAccount,
  refreshClaudeAccounts,
  refreshLoadedClaudeAccounts,
  requestTaskAccountSwitch,
  resetClaudeAccountsStore,
  testQuotaStatus,
  useClaudeAccounts,
  useClaudeAccountsStore,
} from './claude-accounts.js';
import { installFakeAccountsServer, makeAccount } from './claude-accounts-fixtures.js';
import type { ClientMessage } from '../../shared/contracts/messages.js';
import type { ClaudeAccountTestResponse } from '../../shared/contracts/claude-accounts.js';

const test_ = (name: string, outcome: ClaudeAccountTestResponse['outcome']): ClaudeAccountTestResponse => ({
  name, outcome, message: '', testedAt: '2026-01-01T00:00:00.000Z',
});

describe('accountStatus', () => {
  test('maps each outcome to its chip label', () => {
    expect(accountStatus(undefined).label).toBe('Not tested');
    expect(accountStatus(test_('a', 'ok')).label).toBe('Working');
    expect(accountStatus(test_('a', 'usage_limited')).label).toBe('Out of quota');
    expect(accountStatus(test_('a', 'auth_failed')).label).toBe('Sign-in failed');
  });
});

describe('tested-account quota', () => {
  const resetsAt = '2026-12-01T00:00:00.000Z';
  const withQuota = (quota: ClaudeAccountTestResponse['quota']): ClaudeAccountTestResponse => ({ ...test_('a', 'ok'), quota });

  test('a near-limit window turns Working into Near limit; the outcome stays ok', () => {
    const near = withQuota({ sevenDay: { utilization: 99, resetsAt, status: 'allowed_warning' } });
    expect(accountStatus(near)).toEqual({ outcome: 'ok', label: 'Near limit', tone: 'warn' });
    expect(accountStatus(withQuota({ sevenDay: { utilization: 40, resetsAt, status: 'allowed' } })).label).toBe('Working');
    expect(nearLimitWindows(near.quota)).toEqual(['7-day']);
  });

  test('testQuotaStatus shapes the measured windows like the host quota, dated by the test', () => {
    expect(testQuotaStatus(test_('a', 'ok'))).toBeNull();
    expect(testQuotaStatus(withQuota({}))).toBeNull();
    expect(testQuotaStatus(withQuota({ fiveHour: { utilization: 56, resetsAt } }))).toEqual({
      fiveHour: { utilization: 56, resetsAt },
      sevenDay: null,
      updatedAt: Date.parse('2026-01-01T00:00:00.000Z'),
    });
  });
});

describe('pickContinueAccount', () => {
  const accounts = [makeAccount('host'), makeAccount('pro'), makeAccount('work')];

  test('skips the current account and accounts whose last test was out of quota or refused', () => {
    const tests = { pro: test_('pro', 'usage_limited') };
    expect(pickContinueAccount(accounts, 'host', tests)?.name).toBe('work');
    expect(pickContinueAccount(accounts, 'host', { ...tests, work: test_('work', 'auth_failed') })).toBeUndefined();
  });

  test('prefers the first untested or working account, in list order', () => {
    expect(pickContinueAccount(accounts, 'work', {})?.name).toBe('host');
    expect(pickContinueAccount(accounts, 'host', { pro: test_('pro', 'ok') })?.name).toBe('pro');
  });
});

const names = () => useClaudeAccountsStore.getState().accounts.map((a) => a.name);
const gets = (server: ReturnType<typeof installFakeAccountsServer>) =>
  server.calls.filter((c) => c.method === 'GET' && c.url === '/api/claude-accounts').length;

describe('reloading the account list', () => {
  beforeEach(() => resetClaudeAccountsStore());
  afterEach(() => vi.unstubAllGlobals());

  test('refreshLoadedClaudeAccounts does nothing until a surface loaded the list, then picks up a new account', async () => {
    const server = installFakeAccountsServer(['pro']);
    await refreshLoadedClaudeAccounts();
    expect(gets(server)).toBe(0);
    await refreshClaudeAccounts();
    expect(names()).toEqual(['host', 'pro']);
    // `kookr account add work` on the command line, outside the dashboard.
    server.accounts = [...server.accounts, makeAccount('work')];
    await refreshLoadedClaudeAccounts();
    expect(names()).toEqual(['host', 'pro', 'work']);
  });

  test('recovers from a load that failed while the server was down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await refreshClaudeAccounts();
    expect(useClaudeAccountsStore.getState()).toMatchObject({ loaded: true, loadError: 'Failed to fetch', accounts: [] });
    installFakeAccountsServer(['pro']);
    await refreshLoadedClaudeAccounts();
    expect(useClaudeAccountsStore.getState().loadError).toBeNull();
    expect(names()).toEqual(['host', 'pro']);
  });

  test('a load that started before a mutation answered does not overwrite its newer list', async () => {
    const server = installFakeAccountsServer([]);
    await refreshClaudeAccounts();
    const realFetch = globalThis.fetch;
    let releaseGet: () => void = () => {};
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        const stale = await realFetch(input, init);
        await new Promise<void>((resolve) => { releaseGet = resolve; });
        return stale;
      }
      return realFetch(input, init);
    }));
    const load = refreshClaudeAccounts();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await addAccount({ name: 'pro', token: 'sk-ant-oat01-x' })).toEqual({ ok: true });
    expect(names()).toEqual(['host', 'pro']);
    releaseGet();
    await load;
    expect(names()).toEqual(['host', 'pro']);
    expect(server.accounts.map((a) => a.name)).toEqual(['host', 'pro']);
  });

  test('a mounted surface reloads the list when the window regains focus, with one listener for all surfaces', async () => {
    const server = installFakeAccountsServer(['pro']);
    const container = document.createElement('div');
    const root = createRoot(container);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const Probe = () => { useClaudeAccounts(); return null; };
    await act(async () => { root.render(createElement('div', null, createElement(Probe), createElement(Probe))); });
    await act(async () => { await Promise.resolve(); });
    const afterMount = gets(server);
    server.accounts = [...server.accounts, makeAccount('work')];
    await act(async () => { window.dispatchEvent(new Event('focus')); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(gets(server)).toBe(afterMount + 1);
    expect(names()).toEqual(['host', 'pro', 'work']);
    act(() => root.unmount());
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    expect(gets(server)).toBe(afterMount + 1);
  });
});

describe('requestTaskAccountSwitch', () => {
  let sent: ClientMessage[];
  const send = (msg: ClientMessage) => { sent.push(msg); return true; };
  const lastRequestId = () => (sent.at(-1) as Extract<ClientMessage, { type: 'switchClaudeAccount' }>).requestId;

  beforeEach(() => { resetClaudeAccountsStore(); sent = []; });
  afterEach(() => vi.useRealTimers());

  test('sends one switchClaudeAccount and resolves with the reply that carries its request id', async () => {
    const first = requestTaskAccountSwitch(send, 't1', 'pro');
    const firstId = lastRequestId();
    const second = requestTaskAccountSwitch(send, 't2', 'work');
    expect(sent).toEqual([
      { type: 'switchClaudeAccount', requestId: firstId, taskId: 't1', account: 'pro' },
      { type: 'switchClaudeAccount', requestId: lastRequestId(), taskId: 't2', account: 'work' },
    ]);
    expect(lastRequestId()).not.toBe(firstId);
    handleClaudeAccountSwitchResult({ type: 'claudeAccountSwitchResult', requestId: lastRequestId(), taskId: 't2', ok: false, error: 'Task t2 is an active Ralph loop', code: 'ralph_loop_active' });
    handleClaudeAccountSwitchResult({ type: 'claudeAccountSwitchResult', requestId: firstId, taskId: 't1', ok: true, outcome: 'queued', from: 'host', to: 'pro' });
    expect(await first).toEqual({ kind: 'ok', text: 'Moved to pro. It restarts when a slot frees.' });
    expect(await second).toEqual({ kind: 'error', text: 'Task t2 is an active Ralph loop' });
  });

  test('words each outcome', async () => {
    const outcomes = { relaunched: 'Moved to pro.', unchanged: 'Moved to pro.', pinned: 'Moved to pro. It uses it from its next launch.' } as const;
    for (const [outcome, text] of Object.entries(outcomes)) {
      const pending = requestTaskAccountSwitch(send, 't1', 'pro');
      handleClaudeAccountSwitchResult({ type: 'claudeAccountSwitchResult', requestId: lastRequestId(), taskId: 't1', ok: true, outcome: outcome as 'pinned', from: 'host', to: 'pro' });
      expect(await pending).toEqual({ kind: 'ok', text });
    }
  });

  test('a closed socket, a lost connection and a missing reply each end with an error', async () => {
    expect(await requestTaskAccountSwitch(() => false, 't1', 'pro')).toEqual({ kind: 'error', text: expect.stringContaining('Not connected') });

    const lost = requestTaskAccountSwitch(send, 't1', 'pro');
    failPendingClaudeAccountSwitches();
    expect(await lost).toEqual({ kind: 'error', text: expect.stringContaining('Lost the connection') });

    vi.useFakeTimers();
    const silent = requestTaskAccountSwitch(send, 't1', 'pro');
    vi.advanceTimersByTime(SWITCH_REPLY_TIMEOUT_MS);
    expect(await silent).toEqual({ kind: 'error', text: expect.stringContaining('No answer from Kookr') });
    // A reply after the timeout is ignored.
    handleClaudeAccountSwitchResult({ type: 'claudeAccountSwitchResult', requestId: lastRequestId(), taskId: 't1', ok: true, to: 'pro' });
  });
});

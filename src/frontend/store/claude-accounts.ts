import { useEffect } from 'react';
import { create } from 'zustand';
import {
  addClaudeAccount,
  getClaudeAccounts,
  removeClaudeAccount,
  setDefaultClaudeAccount,
  testClaudeAccount,
  type ClaudeAccountsApiError,
} from '../api/claude-accounts.js';
import type {
  AddClaudeAccountRequest,
  ClaudeAccountsResponse,
  ClaudeAccountTestOutcome,
  ClaudeAccountTestResponse,
  ClaudeAccountView,
} from '../../shared/contracts/claude-accounts.js';

/*
 * One shared list of named Claude accounts for Settings, the sidebar footer,
 * the task detail panel and the Launch dialog. Every mutation replaces the list
 * from the server's response, so all four surfaces agree without refetching.
 * Test results live only in memory: they say what the last Test click saw.
 */

export interface ClaudeAccountsState {
  accounts: ClaudeAccountView[];
  defaultName: string;
  loaded: boolean;
  /** Last failure to load the list; `null` when fine. */
  loadError: string | null;
  /** Last test result per account name (memory only, cleared on reload). */
  tests: Record<string, ClaudeAccountTestResponse>;
  /** Account names with a test in flight. */
  testing: Record<string, boolean>;
}

export type AccountActionResult = { ok: true } | { ok: false; error: string; code?: string };

const initialState = (): ClaudeAccountsState => ({
  accounts: [],
  defaultName: 'host',
  loaded: false,
  loadError: null,
  tests: {},
  testing: {},
});

export const useClaudeAccountsStore = create<ClaudeAccountsState>(() => initialState());

/** Test helper: back to an empty, not-yet-loaded store. */
export function resetClaudeAccountsStore(): void {
  inflight = null;
  useClaudeAccountsStore.setState(initialState(), true);
}

let inflight: Promise<void> | null = null;

function isList(body: unknown): body is ClaudeAccountsResponse {
  return typeof body === 'object' && body !== null && Array.isArray((body as ClaudeAccountsResponse).accounts);
}

function errorCode(body: unknown): string | undefined {
  const code = (body as ClaudeAccountsApiError | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function errorText(body: unknown, status: number): string {
  const error = (body as ClaudeAccountsApiError | null)?.error;
  return typeof error === 'string' && error ? error : `Request failed (HTTP ${status})`;
}

function applyList(list: ClaudeAccountsResponse): void {
  const names = new Set(list.accounts.map((a) => a.name));
  useClaudeAccountsStore.setState((s) => ({
    accounts: list.accounts,
    defaultName: list.default,
    loaded: true,
    loadError: null,
    tests: Object.fromEntries(Object.entries(s.tests).filter(([name]) => names.has(name))),
  }));
}

/** Fetch the list. Concurrent callers share one request; failures never throw. */
export function refreshClaudeAccounts(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await getClaudeAccounts();
      if (res.ok && isList(res.body)) applyList(res.body);
      else useClaudeAccountsStore.setState({ loaded: true, loadError: errorText(res.body, res.status) });
    } catch (err) {
      useClaudeAccountsStore.setState({
        loaded: true,
        loadError: err instanceof Error ? err.message : 'Failed to load accounts',
      });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

async function mutate(
  call: () => Promise<{ ok: boolean; status: number; body: ClaudeAccountsResponse | ClaudeAccountsApiError | null }>,
): Promise<AccountActionResult> {
  try {
    const res = await call();
    if (res.ok && isList(res.body)) {
      applyList(res.body);
      return { ok: true };
    }
    return { ok: false, error: errorText(res.body, res.status), code: errorCode(res.body) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Request failed' };
  }
}

export function addAccount(request: AddClaudeAccountRequest): Promise<AccountActionResult> {
  return mutate(() => addClaudeAccount(request));
}

export function removeAccount(name: string): Promise<AccountActionResult> {
  return mutate(() => removeClaudeAccount(name));
}

export function setDefaultAccount(name: string): Promise<AccountActionResult> {
  return mutate(() => setDefaultClaudeAccount(name));
}

/** Run a test and remember its outcome so every surface can show the status. */
export async function testAccount(name: string): Promise<AccountActionResult> {
  useClaudeAccountsStore.setState((s) => ({ testing: { ...s.testing, [name]: true } }));
  try {
    const res = await testClaudeAccount(name);
    const body = res.body as ClaudeAccountTestResponse | null;
    if (res.ok && body && typeof body.outcome === 'string') {
      useClaudeAccountsStore.setState((s) => ({ tests: { ...s.tests, [name]: body } }));
      return { ok: true };
    }
    return { ok: false, error: errorText(res.body, res.status) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Test failed' };
  } finally {
    useClaudeAccountsStore.setState((s) => ({ testing: { ...s.testing, [name]: false } }));
  }
}

/**
 * The shared list. The first mounted consumer triggers the load; later ones
 * reuse it. `registered` counts accounts besides `host`.
 */
export function useClaudeAccounts() {
  const state = useClaudeAccountsStore();
  const needsLoad = !state.loaded;
  useLoadOnce(needsLoad);
  const registered = state.accounts.filter((a) => a.name !== 'host');
  return { ...state, registered, hasRegistered: registered.length > 0 };
}

function useLoadOnce(needsLoad: boolean): void {
  useEffect(() => {
    if (needsLoad) void refreshClaudeAccounts();
  }, [needsLoad]);
}

export type AccountStatusTone = 'ok' | 'warn' | 'bad' | 'idle';

export interface AccountStatus {
  outcome: ClaudeAccountTestOutcome | 'untested';
  label: string;
  tone: AccountStatusTone;
}

/** Status chip content from the last test of an account. */
export function accountStatus(test: ClaudeAccountTestResponse | undefined): AccountStatus {
  switch (test?.outcome) {
    case 'ok': return { outcome: 'ok', label: 'Working', tone: 'ok' };
    case 'usage_limited': return { outcome: 'usage_limited', label: 'Out of quota', tone: 'warn' };
    case 'auth_failed': return { outcome: 'auth_failed', label: 'Sign-in failed', tone: 'bad' };
    case 'error': return { outcome: 'error', label: 'Test failed', tone: 'bad' };
    default: return { outcome: 'untested', label: 'Not tested', tone: 'idle' };
  }
}

/** The display name of an account: `host` reads as the host's own login. */
export function accountTitle(account: ClaudeAccountView): string {
  return account.label ? `${account.name} (${account.label})` : account.name;
}

/**
 * First account other than `current` whose last test did not say it is out of
 * quota or refused; untested accounts qualify (their state is unknown).
 */
export function pickContinueAccount(
  accounts: readonly ClaudeAccountView[],
  current: string,
  tests: Record<string, ClaudeAccountTestResponse>,
): ClaudeAccountView | undefined {
  return accounts.find((a) => {
    if (a.name === current) return false;
    const outcome = tests[a.name]?.outcome;
    return outcome !== 'usage_limited' && outcome !== 'auth_failed';
  });
}

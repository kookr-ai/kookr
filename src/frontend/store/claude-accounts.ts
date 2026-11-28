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
import type { QuotaStatus } from '../../shared/contracts/quota.js';
import type { ClientMessage, ServerMessage } from '../../shared/contracts/messages.js';
import type {
  AddClaudeAccountRequest,
  ClaudeAccountQuota,
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
  listGeneration = 0;
  for (const pending of pendingSwitches.values()) clearTimeout(pending.timer);
  pendingSwitches.clear();
  useClaudeAccountsStore.setState(initialState(), true);
}

let inflight: Promise<void> | null = null;
/**
 * Bumped by every list applied to the store. A load that started before a
 * mutation answered drops its (older) result instead of overwriting the
 * mutation's list.
 */
let listGeneration = 0;

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
  listGeneration += 1;
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
  const generation = listGeneration;
  inflight = (async () => {
    try {
      const res = await getClaudeAccounts();
      if (generation !== listGeneration) return;
      if (res.ok && isList(res.body)) applyList(res.body);
      else useClaudeAccountsStore.setState({ loaded: true, loadError: errorText(res.body, res.status) });
    } catch (err) {
      if (generation !== listGeneration) return;
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

/**
 * Reload the list if a surface already asked for it (it is `loaded`, maybe
 * with an error), so it catches up with accounts added by `kookr account add`
 * and recovers from a load that failed while the server was down. Run when
 * the dashboard socket reconnects and when the window regains focus.
 */
export function refreshLoadedClaudeAccounts(): Promise<void> {
  return useClaudeAccountsStore.getState().loaded ? refreshClaudeAccounts() : Promise.resolve();
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
 * reuse it. While any consumer is mounted, the list reloads when the window
 * regains focus. `registered` counts accounts besides `host`.
 */
export function useClaudeAccounts() {
  const state = useClaudeAccountsStore();
  const needsLoad = !state.loaded;
  useLoadOnce(needsLoad);
  useRefreshOnFocus();
  const registered = state.accounts.filter((a) => a.name !== 'host');
  return { ...state, registered, hasRegistered: registered.length > 0 };
}

function useLoadOnce(needsLoad: boolean): void {
  useEffect(() => {
    if (needsLoad) void refreshClaudeAccounts();
  }, [needsLoad]);
}

// One window listener however many surfaces show the list.
let focusConsumers = 0;
const onWindowFocus = () => { void refreshLoadedClaudeAccounts(); };

function useRefreshOnFocus(): void {
  useEffect(() => {
    if (focusConsumers++ === 0) window.addEventListener('focus', onWindowFocus);
    return () => {
      if (--focusConsumers === 0) window.removeEventListener('focus', onWindowFocus);
    };
  }, []);
}

/** What a "move this task" click ended with, as one line to show inline. */
export type TaskAccountSwitchResult = { kind: 'ok' | 'error'; text: string };

type SwitchReply = Extract<ServerMessage, { type: 'claudeAccountSwitchResult' }>;

/**
 * How long to wait for the server's reply. A switch of a running task stops
 * its sessions and relaunches it before answering, which can take a while.
 */
export const SWITCH_REPLY_TIMEOUT_MS = 120_000;

const pendingSwitches = new Map<string, {
  resolve: (result: TaskAccountSwitchResult) => void;
  timer: ReturnType<typeof setTimeout>;
}>();
let switchSeq = 0;

function settleSwitch(requestId: string, result: TaskAccountSwitchResult): void {
  const pending = pendingSwitches.get(requestId);
  if (!pending) return;
  pendingSwitches.delete(requestId);
  clearTimeout(pending.timer);
  pending.resolve(result);
}

/**
 * Move a task to another account over the dashboard socket
 * (`switchClaudeAccount`). Unlike the HTTP route, this works when
 * `KOOKR_SUPERVISOR_TOKEN` is set: the owner's connection is the credential.
 * Resolves with the server's answer, or with an error when the socket is down
 * or no answer comes. Never rejects.
 */
export function requestTaskAccountSwitch(
  send: (msg: ClientMessage) => boolean,
  taskId: string,
  account: string,
): Promise<TaskAccountSwitchResult> {
  switchSeq += 1;
  const requestId = `${Date.now().toString(36)}-${switchSeq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => settleSwitch(requestId, {
      kind: 'error',
      text: 'No answer from Kookr. The switch may still be running: check the task in a moment.',
    }), SWITCH_REPLY_TIMEOUT_MS);
    pendingSwitches.set(requestId, { resolve, timer });
    if (!send({ type: 'switchClaudeAccount', requestId, taskId, account })) {
      settleSwitch(requestId, { kind: 'error', text: 'Not connected to Kookr. Try again in a moment.' });
    }
  });
}

/** Apply a `claudeAccountSwitchResult` message: the reply to a switch this tab sent. */
export function handleClaudeAccountSwitchResult(msg: SwitchReply): void {
  if (!msg.ok) {
    settleSwitch(msg.requestId, { kind: 'error', text: msg.error || 'Could not switch account' });
    return;
  }
  const to = msg.to ?? 'the new account';
  const text = msg.outcome === 'queued'
    ? `Moved to ${to}. It restarts when a slot frees.`
    : msg.outcome === 'pinned'
      ? `Moved to ${to}. It uses it from its next launch.`
      : `Moved to ${to}.`;
  settleSwitch(msg.requestId, { kind: 'ok', text });
}

/**
 * The socket dropped: a reply to a switch sent on it can no longer arrive.
 * The switch itself may still have happened, so say so instead of "failed".
 */
export function failPendingClaudeAccountSwitches(): void {
  for (const requestId of [...pendingSwitches.keys()]) {
    settleSwitch(requestId, {
      kind: 'error',
      text: 'Lost the connection to Kookr before it answered. Check the task once it reconnects.',
    });
  }
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
    case 'ok':
      return nearLimitWindows(test.quota).length > 0
        ? { outcome: 'ok', label: 'Near limit', tone: 'warn' }
        : { outcome: 'ok', label: 'Working', tone: 'ok' };
    case 'usage_limited': return { outcome: 'usage_limited', label: 'Out of quota', tone: 'warn' };
    case 'auth_failed': return { outcome: 'auth_failed', label: 'Sign-in failed', tone: 'bad' };
    case 'error': return { outcome: 'error', label: 'Test failed', tone: 'bad' };
    default: return { outcome: 'untested', label: 'Not tested', tone: 'idle' };
  }
}

/**
 * The usage a test measured, shaped like the host's live quota so the same
 * bars render it; `updatedAt` is the test time, so old readings show as stale.
 * `null` when the test reported no window.
 */
export function testQuotaStatus(test: ClaudeAccountTestResponse | undefined): QuotaStatus | null {
  const quota = test?.quota;
  if (!quota || (!quota.fiveHour && !quota.sevenDay)) return null;
  const updatedAt = Date.parse(test.testedAt);
  return {
    fiveHour: quota.fiveHour ?? null,
    sevenDay: quota.sevenDay ?? null,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  };
}

/** Windows Claude Code flagged `allowed_warning` (close to the limit), as `5-hour` / `7-day`. */
export function nearLimitWindows(quota: ClaudeAccountQuota | undefined): string[] {
  const names: string[] = [];
  if (quota?.fiveHour?.status === 'allowed_warning') names.push('5-hour');
  if (quota?.sevenDay?.status === 'allowed_warning') names.push('7-day');
  return names;
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

import { fetchResult, type ApiResult } from './client.js';
import type {
  AddClaudeAccountRequest,
  ClaudeAccountsErrorResponse,
  ClaudeAccountsResponse,
  ClaudeAccountTestResponse,
} from '../../shared/contracts/claude-accounts.js';

/** Refusal body shared by the account routes (`{error, code}`). */
export type ClaudeAccountsApiError = ClaudeAccountsErrorResponse | { error: string; code?: string };

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function accountPath(name: string, suffix = ''): string {
  return `/api/claude-accounts/${encodeURIComponent(name)}${suffix}`;
}

/** GET the registry (host first) and the default account name. */
export function getClaudeAccounts(): Promise<ApiResult<ClaudeAccountsResponse | ClaudeAccountsApiError | null>> {
  return fetchResult<ClaudeAccountsResponse | ClaudeAccountsApiError>('/api/claude-accounts');
}

/** POST a new account (or replace a token/label). The token is write-only. */
export function addClaudeAccount(
  request: AddClaudeAccountRequest,
): Promise<ApiResult<ClaudeAccountsResponse | ClaudeAccountsApiError | null>> {
  return fetchResult<ClaudeAccountsResponse | ClaudeAccountsApiError>('/api/claude-accounts', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(request),
  });
}

/** DELETE a registered account. */
export function removeClaudeAccount(name: string): Promise<ApiResult<ClaudeAccountsResponse | ClaudeAccountsApiError | null>> {
  return fetchResult<ClaudeAccountsResponse | ClaudeAccountsApiError>(accountPath(name), { method: 'DELETE' });
}

/** PUT the account new tasks launch on when they name none. */
export function setDefaultClaudeAccount(name: string): Promise<ApiResult<ClaudeAccountsResponse | ClaudeAccountsApiError | null>> {
  return fetchResult<ClaudeAccountsResponse | ClaudeAccountsApiError>('/api/claude-accounts/default', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
  });
}

/** POST a tiny real request on the account to see whether it still works. */
export function testClaudeAccount(name: string): Promise<ApiResult<ClaudeAccountTestResponse | ClaudeAccountsApiError | null>> {
  return fetchResult<ClaudeAccountTestResponse | ClaudeAccountsApiError>(accountPath(name, '/test'), { method: 'POST' });
}

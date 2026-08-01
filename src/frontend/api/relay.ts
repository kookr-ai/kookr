import { apiFetch, fetchJson, type ApiResult } from './client.js';
import { SHARE_CSRF_HEADER } from './sharing.js';
import type { RelayConnectionStatusResponse } from '../../shared/contracts/relay-connection.js';
import type {
  SessionSharingRecoveryAction,
  SessionSharingRecoveryActionResponse,
} from '../../shared/contracts/session-sharing-recovery.js';

/** GET the relay-connection status. Throws `relay-status-<status>` on a non-2xx. */
export async function getRelayConnection(): Promise<RelayConnectionStatusResponse> {
  const res = await apiFetch('/api/relay-connection');
  if (!res.ok) throw new Error(`relay-status-${res.status}`);
  return (await res.json()) as RelayConnectionStatusResponse;
}

/**
 * POST a relay-connection mutation (connect/pair/rotate/disconnect/…). Adds the
 * JSON content-type and CSRF header, letting the caller's `init.headers` win on
 * conflict, and returns status + parsed body (status union | error).
 */
export function mutateRelayConnection(
  path: string,
  csrfToken: string,
  init: RequestInit,
): Promise<ApiResult<RelayConnectionStatusResponse | { error?: string }>> {
  return fetchJson<RelayConnectionStatusResponse | { error?: string }>(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      [SHARE_CSRF_HEADER]: csrfToken,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

/** POST a session-sharing recovery action. Returns status + parsed body (result union | error). */
export function runSessionSharingRecovery(
  action: SessionSharingRecoveryAction,
  csrfToken: string,
  body: Record<string, unknown>,
): Promise<ApiResult<SessionSharingRecoveryActionResponse | { error?: string }>> {
  return fetchJson<SessionSharingRecoveryActionResponse | { error?: string }>(
    `/api/session-sharing/recovery/${action}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SHARE_CSRF_HEADER]: csrfToken,
      },
      body: JSON.stringify(body),
    },
  );
}

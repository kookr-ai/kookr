import { apiFetch, fetchResult, type ApiResult } from './client.js';
import type {
  CreateTaskShareApiResponse,
  ListTaskSharesApiResponse,
  ResolveTaskShareGrantRequestApiResponse,
  RevokeTaskShareApiResponse,
} from '../../shared/contracts/remote-share.js';
import type {
  ListContactShareContactsApiResponse,
  ListContactShareInboxApiResponse,
  ListSharedTasksApiResponse,
} from '../../shared/contracts/contact-share.js';

/** Header carrying the share CSRF token on mutating share/contact-share calls. */
export const SHARE_CSRF_HEADER = 'x-kookr-csrf';

export interface ShareCsrfTokenResponse {
  csrfToken?: unknown;
  shareMaxTtlMs?: unknown;
}

function csrfHeaders(csrfToken: string, extra?: Record<string, string>): Record<string, string> {
  return { [SHARE_CSRF_HEADER]: csrfToken, ...extra };
}

/** GET the share CSRF token (also carries `shareMaxTtlMs`). 409 → sharing disabled. */
export function getShareCsrfToken(): Promise<ApiResult<ShareCsrfTokenResponse | null>> {
  return fetchResult<ShareCsrfTokenResponse>('/api/share/csrf-token');
}

/** GET the task-share list. 409 → sharing disabled; other non-2xx → caller throws. */
export function getTaskShares(): Promise<ApiResult<ListTaskSharesApiResponse | null>> {
  return fetchResult<ListTaskSharesApiResponse>('/api/share/task');
}

export function getContactShareContacts(): Promise<ApiResult<Partial<ListContactShareContactsApiResponse> | null>> {
  return fetchResult<Partial<ListContactShareContactsApiResponse>>('/api/contact-share/contacts');
}

export function getContactShareInbox(): Promise<ApiResult<Partial<ListContactShareInboxApiResponse> | null>> {
  return fetchResult<Partial<ListContactShareInboxApiResponse>>('/api/contact-share/inbox');
}

export function getContactShareSharedTasks(): Promise<ApiResult<Partial<ListSharedTasksApiResponse> | null>> {
  return fetchResult<Partial<ListSharedTasksApiResponse>>('/api/contact-share/shared-tasks');
}

export interface CreateTaskShareRequest {
  taskId: string;
  ttlMs: number;
  displayLabel?: string;
}

/**
 * POST a new guest share link. Parses the body defensively (default `{}`) so
 * the caller can read `error` on failure or the share payload on success.
 */
export async function createTaskShare(
  csrfToken: string,
  body: CreateTaskShareRequest,
): Promise<ApiResult<CreateTaskShareApiResponse | { error?: string }>> {
  const res = await apiFetch('/api/share/task', {
    method: 'POST',
    headers: csrfHeaders(csrfToken, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => ({}))) as CreateTaskShareApiResponse | { error?: string };
  return { ok: res.ok, status: res.status, body: parsed };
}

export interface SendContactShareRequest {
  taskId: string;
  contactId: string;
  recipientDeviceId: string;
}

/** POST a Contact Share invitation. Caller only inspects `ok`/`status`. */
export function sendContactShare(
  csrfToken: string,
  body: SendContactShareRequest,
): Promise<ApiResult<unknown>> {
  return fetchResult('/api/contact-share/shares', {
    method: 'POST',
    headers: csrfHeaders(csrfToken, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

/** POST accept/refuse on an inbound Contact Share invitation. */
export function decideContactShareInbox(
  csrfToken: string,
  shareId: string,
  decision: 'accept' | 'refuse',
): Promise<ApiResult<unknown>> {
  return fetchResult(
    `/api/contact-share/inbox/${encodeURIComponent(shareId)}/${decision}`,
    {
      method: 'POST',
      headers: csrfHeaders(csrfToken, { 'content-type': 'application/json' }),
      body: JSON.stringify({ recipientDeviceId: 'local-device' }),
    },
  );
}

/** POST to revoke a guest share. Returns the updated share on success. */
export function revokeTaskShare(
  csrfToken: string,
  invitationId: string,
): Promise<ApiResult<RevokeTaskShareApiResponse | null>> {
  return fetchResult<RevokeTaskShareApiResponse>(
    `/api/share/task/${encodeURIComponent(invitationId)}/revoke`,
    { method: 'POST', headers: csrfHeaders(csrfToken) },
  );
}

/** POST to approve/deny a terminal-view grant request on a guest share. */
export function resolveTaskShareGrantRequest(
  csrfToken: string,
  invitationId: string,
  requestId: string,
  decision: 'approve' | 'deny',
): Promise<ApiResult<ResolveTaskShareGrantRequestApiResponse | null>> {
  return fetchResult<ResolveTaskShareGrantRequestApiResponse>(
    `/api/share/task/${encodeURIComponent(invitationId)}/grant-requests/${encodeURIComponent(requestId)}/${decision}`,
    { method: 'POST', headers: csrfHeaders(csrfToken) },
  );
}

/**
 * Easy Connection Sharing — Phase A0 dashboard-backend routes.
 *
 * These routes let the local dashboard create and revoke view-only shares
 * for the current task. They are always mounted; in local-only mode
 * (`deps.remoteShare` absent) they answer `409 relay-not-configured` so the
 * dashboard can render a disabled Share affordance without the backend
 * loading any remote runtime code.
 *
 * RFC: `docs/rfc/rfc-easy-connection-sharing.md` — Phase A0.
 */

import type { Hono } from 'hono';
import type { RouteDeps } from './shared.js';
import type {
  CreateTaskShareApiResponse,
  ListTaskSharesApiResponse,
  ResolveTaskShareGrantRequestApiResponse,
  RevokeTaskShareApiResponse,
} from '../../shared/contracts/remote-share.js';
import {
  RelayShareError,
  TASK_SHARE_DEFAULT_TTL_MS,
  TASK_SHARE_MAX_TTL_MS,
  TASK_SHARE_MIN_TTL_MS,
} from '../relay-share-client.js';

/** Request header carrying the local UI CSRF nonce. */
export const SHARE_CSRF_HEADER = 'x-kookr-csrf';

export interface ShareMutationGuardInput {
  /** Fully-qualified request URL (`c.req.url`). */
  requestUrl: string;
  /** Value of the `Origin` request header, if any. */
  origin: string | undefined;
  /** Value of the {@link SHARE_CSRF_HEADER} request header, if any. */
  csrfHeader: string | undefined;
  /** The server's per-process CSRF nonce. */
  expectedCsrfToken: string;
}

export type ShareGuardResult =
  | { ok: true }
  | { ok: false; status: 400 | 403; error: string };

/**
 * Decide whether a share-mutation request is a same-origin call from the
 * local dashboard. Pure so the security logic is unit-tested directly.
 *
 * Two independent checks must both pass:
 *  - the `Origin` header must be present and host-match the server, so a
 *    cross-origin browser request is refused; and
 *  - the CSRF nonce must match. A cross-origin page cannot read
 *    `GET /api/share/csrf-token` (the browser blocks the response body),
 *    so it cannot forge this header even if it could spoof `Origin`.
 */
export function evaluateShareMutationGuard(input: ShareMutationGuardInput): ShareGuardResult {
  let expectedHost: string;
  try {
    expectedHost = new URL(input.requestUrl).host;
  } catch {
    return { ok: false, status: 400, error: 'bad-request-url' };
  }
  if (!expectedHost) return { ok: false, status: 400, error: 'missing-host' };

  if (!input.origin) return { ok: false, status: 403, error: 'origin-required' };
  let originHost: string;
  try {
    originHost = new URL(input.origin).host;
  } catch {
    return { ok: false, status: 403, error: 'bad-origin' };
  }
  if (originHost !== expectedHost) {
    return { ok: false, status: 403, error: 'cross-origin-forbidden' };
  }

  if (!input.csrfHeader || input.csrfHeader !== input.expectedCsrfToken) {
    return { ok: false, status: 403, error: 'invalid-csrf-token' };
  }
  return { ok: true };
}

export function registerShareRoutes(app: Hono, deps: RouteDeps): void {
  const shareMaxTtlMs = (): number => {
    const relayMax = deps.remoteShare?.getShareMaxTtlMs?.();
    return typeof relayMax === 'number' && Number.isFinite(relayMax) ? relayMax : TASK_SHARE_MAX_TTL_MS;
  };

  // The dashboard fetches this nonce once, then echoes it back in the
  // SHARE_CSRF_HEADER on every share mutation.
  app.get('/api/share/csrf-token', (c) => {
    const remoteShare = deps.remoteShare;
    if (!remoteShare) return c.json({ error: 'relay-not-configured' }, 409);
    return c.json({ csrfToken: remoteShare.csrfToken, shareMaxTtlMs: shareMaxTtlMs() });
  });

  app.get('/api/share/task', async (c) => {
    const remoteShare = deps.remoteShare;
    if (!remoteShare?.client) return c.json({ error: 'relay-not-configured' }, 409);
    try {
      const shares = remoteShare.service
        ? await remoteShare.service.listTaskShares()
        : await remoteShare.client.listTaskShares();
      const response: ListTaskSharesApiResponse = { shares, shareMaxTtlMs: shareMaxTtlMs() };
      return c.json(response);
    } catch (err) {
      if (err instanceof RelayShareError) return c.json({ error: err.code }, err.status);
      return c.json({ error: 'share-list-failed' }, 502);
    }
  });

  app.post('/api/share/task', async (c) => {
    const remoteShare = deps.remoteShare;
    if (!remoteShare?.client) return c.json({ error: 'relay-not-configured' }, 409);

    const guard = evaluateShareMutationGuard({
      requestUrl: c.req.url,
      origin: c.req.header('Origin'),
      csrfHeader: c.req.header(SHARE_CSRF_HEADER),
      expectedCsrfToken: remoteShare.csrfToken,
    });
    if (!guard.ok) return c.json({ error: guard.error }, guard.status);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid-json-body' }, 400);
    }
    const taskId = (body as { taskId?: unknown }).taskId;
    if (typeof taskId !== 'string' || taskId.length === 0) {
      return c.json({ error: 'taskId is required' }, 400);
    }
    // Only mint a share for a task that exists on this node — minting an
    // invitation for an unknown taskId would yield a working token whose
    // projection subject never resolves.
    if (!deps.taskStore.getTask(taskId)) {
      return c.json({ error: 'task-not-found' }, 404);
    }
    const ttlRaw = (body as { ttlMs?: unknown }).ttlMs;
    let ttlMs = TASK_SHARE_DEFAULT_TTL_MS;
    const maxTtlMs = shareMaxTtlMs();
    if (ttlRaw !== undefined) {
      if (
        typeof ttlRaw !== 'number'
        || !Number.isFinite(ttlRaw)
        || ttlRaw < TASK_SHARE_MIN_TTL_MS
        || ttlRaw > maxTtlMs
      ) {
        return c.json(
          { error: `ttlMs must be a number between ${TASK_SHARE_MIN_TTL_MS} and ${maxTtlMs}` },
          400,
        );
      }
      ttlMs = ttlRaw;
    }
    const displayLabelRaw = (body as { displayLabel?: unknown }).displayLabel;
    if (displayLabelRaw !== undefined && typeof displayLabelRaw !== 'string') {
      return c.json({ error: 'displayLabel must be a string' }, 400);
    }
    const displayLabel = typeof displayLabelRaw === 'string'
      ? displayLabelRaw.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 80)
      : '';

    try {
      const result = await (remoteShare.service ?? remoteShare.client).createTaskShare({
        taskId,
        ttlMs,
        ...(displayLabel ? { displayLabel } : {}),
      });
      const response: CreateTaskShareApiResponse = { ...result, shareMaxTtlMs: maxTtlMs };
      return c.json(response, 201);
    } catch (err) {
      if (err instanceof RelayShareError) return c.json({ error: err.code }, err.status);
      return c.json({ error: 'share-create-failed' }, 502);
    }
  });

  app.post('/api/share/task/:invitationId/revoke', async (c) => {
    const remoteShare = deps.remoteShare;
    if (!remoteShare?.client) return c.json({ error: 'relay-not-configured' }, 409);

    const guard = evaluateShareMutationGuard({
      requestUrl: c.req.url,
      origin: c.req.header('Origin'),
      csrfHeader: c.req.header(SHARE_CSRF_HEADER),
      expectedCsrfToken: remoteShare.csrfToken,
    });
    if (!guard.ok) return c.json({ error: guard.error }, guard.status);

    const invitationId = c.req.param('invitationId');
    if (!invitationId) return c.json({ error: 'invitationId is required' }, 400);

    try {
      const result = await (remoteShare.service ?? remoteShare.client).revokeTaskShare(invitationId);
      const response: RevokeTaskShareApiResponse = result;
      return c.json(response);
    } catch (err) {
      if (err instanceof RelayShareError) return c.json({ error: err.code }, err.status);
      return c.json({ error: 'share-revoke-failed' }, 502);
    }
  });

  app.post('/api/share/task/:invitationId/grant-requests/:requestId/:decision', async (c) => {
    const remoteShare = deps.remoteShare;
    if (!remoteShare?.client) return c.json({ error: 'relay-not-configured' }, 409);

    const guard = evaluateShareMutationGuard({
      requestUrl: c.req.url,
      origin: c.req.header('Origin'),
      csrfHeader: c.req.header(SHARE_CSRF_HEADER),
      expectedCsrfToken: remoteShare.csrfToken,
    });
    if (!guard.ok) return c.json({ error: guard.error }, guard.status);

    const invitationId = c.req.param('invitationId');
    const requestId = c.req.param('requestId');
    const decision = c.req.param('decision');
    if (!invitationId || !requestId) return c.json({ error: 'invitationId and requestId are required' }, 400);
    if (decision !== 'approve' && decision !== 'deny') return c.json({ error: 'decision must be approve or deny' }, 400);

    try {
      const target = remoteShare.service ?? remoteShare.client;
      const result = decision === 'approve'
        ? await target.approveGrantRequest(invitationId, requestId)
        : await target.denyGrantRequest(invitationId, requestId);
      const response: ResolveTaskShareGrantRequestApiResponse = result;
      return c.json(response);
    } catch (err) {
      if (err instanceof RelayShareError) return c.json({ error: err.code }, err.status);
      return c.json({ error: 'grant-request-resolution-failed' }, 502);
    }
  });
}

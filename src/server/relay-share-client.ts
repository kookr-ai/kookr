/**
 * Dashboard-backend client for the relay's node-scoped Phase A0 share
 * endpoints (`/relay/node/invitations`).
 *
 * This module talks to the relay over plain HTTP with the node token. It
 * deliberately does **not** import anything from `src/remote/*` at runtime
 * (only `import type`), so mounting the share routes never pulls remote
 * runtime code into local-only mode. See
 * `scripts/check-remote-import-boundaries.ts`.
 *
 * RFC: `docs/rfc/rfc-easy-connection-sharing.md` — Phase A0-E.
 */

import type {
  CreateNodeTaskShareRequest,
  CreateNodeTaskShareResponse,
  ListNodeTaskSharesResponse,
  RelayNodeInvitationView,
  RevokeNodeTaskShareResponse,
  ResolveTaskShareGrantRequestApiResponse,
  TaskShareTicket,
  TaskShareSummary,
} from '../shared/contracts/remote-share.js';
import type { ContactShareEnvelope } from '../shared/contracts/contact-share.js';

// Share TTL bounds. The relay re-validates with its own `NODE_SHARE_*`
// constants (`relay/server.ts`) — the remote import boundary forbids sharing
// the value across `src/server` ↔ `relay`, so keep the two pairs in sync.
/** Lower bound on a share TTL — long enough for a collaborator to join. */
export const TASK_SHARE_MIN_TTL_MS = 60_000;
/** Upper bound — matches the relay `InvitationStore` default; no permanent shares. */
export const TASK_SHARE_MAX_TTL_MS = 24 * 60 * 60 * 1000;
/** Default A0 share lifetime when the caller does not specify one. */
export const TASK_SHARE_DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * Default per-request abort timeout for relay share HTTP calls.
 * Long enough for slow-but-healthy networks; short enough that a hung relay
 * cannot wedge share mint/revoke UI and pile up event-loop waiters (#1861).
 * Override via `RelayShareClientOptions.requestTimeoutMs` (tests / rare slow links).
 * Keep ≥10s in production to avoid false failures.
 */
export const DEFAULT_RELAY_SHARE_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Default ceiling on a relay response body, in decoded bytes.
 * Relay share responses are small JSON documents (invitation views); 1 MiB is
 * far above any legitimate payload while still bounding memory so a hostile or
 * misbehaving relay cannot force unbounded buffering. The cap is enforced both
 * against a declared `Content-Length` (rejected before the body is read) and
 * against the decoded byte count of a chunked stream (cancelled at the ceiling).
 * Override via `RelayShareClientOptions.maxResponseBytes`.
 */
export const DEFAULT_RELAY_SHARE_MAX_RESPONSE_BYTES = 1024 * 1024;

/** HTTP status the dashboard backend surfaces for a failed relay call. */
export type RelayShareErrorStatus = 400 | 404 | 409 | 429 | 502 | 503;

/** A relay call failed; `status` is the HTTP status to surface to the dashboard. */
export class RelayShareError extends Error {
  readonly status: RelayShareErrorStatus;
  readonly code: string;

  constructor(code: string, status: RelayShareErrorStatus, message?: string) {
    super(message ?? code);
    this.name = 'RelayShareError';
    this.code = code;
    this.status = status;
  }
}

export interface RelayShareClient {
  /** Create a view-only invitation for `taskId` on the configured node. */
  createTaskShare(input: { taskId: string; ttlMs: number; displayLabel?: string }): Promise<{
    share: TaskShareSummary;
    joinUrl: string;
    shareTicket?: TaskShareTicket;
  }>;
  /** Revoke a previously created invitation owned by the configured node. */
  revokeTaskShare(invitationId: string): Promise<{ share: TaskShareSummary; alreadyRevoked: boolean }>;
  /** List Phase A0 task shares owned by the configured node. */
  listTaskShares(): Promise<TaskShareSummary[]>;
  /** Approve a pending collaborator request for mutating grants. */
  approveGrantRequest(invitationId: string, requestId: string): Promise<ResolveTaskShareGrantRequestApiResponse>;
  /** Deny a pending collaborator request for mutating grants. */
  denyGrantRequest(invitationId: string, requestId: string): Promise<ResolveTaskShareGrantRequestApiResponse>;
  /** Store an encrypted Contact Share mailbox envelope through the node-authenticated relay path. */
  sendContactShareEnvelope(envelope: ContactShareEnvelope): Promise<ContactShareEnvelope>;
}

export interface RelayShareClientOptions {
  /** Base relay URL, e.g. the operator's `KOOKR_RELAY_URL`. */
  relayUrl: string;
  /** Node token, e.g. the operator's `KOOKR_RELAY_TOKEN`. */
  relayToken: string;
  /** Test seam; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Per-request AbortController timeout for outbound relay HTTP.
   * Defaults to {@link DEFAULT_RELAY_SHARE_REQUEST_TIMEOUT_MS} (10s).
   * Injectable so tests can assert the timeout path with a delayed `fetchImpl`.
   */
  requestTimeoutMs?: number;
  /**
   * Ceiling on the relay response body in decoded bytes. Defaults to
   * {@link DEFAULT_RELAY_SHARE_MAX_RESPONSE_BYTES} (1 MiB). Injectable so tests
   * can drive the oversized-body path with a small cap.
   */
  maxResponseBytes?: number;
}

function toSummary(view: RelayNodeInvitationView): TaskShareSummary {
  const connectedViewerCount = view.connectedViewerCount ?? 0;
  const state = view.revokedAt
    ? 'revoked'
    : Date.parse(view.expiresAt) <= Date.now()
      ? 'expired'
      : connectedViewerCount > 0
        ? 'viewerConnected'
        : 'waiting';
  return {
    invitationId: view.invitationId,
    taskId: view.taskId,
    createdAt: view.createdAt,
    expiresAt: view.expiresAt,
    state,
    connectedViewerCount,
    ...(view.revokedAt ? { revokedAt: view.revokedAt } : {}),
    ...(view.acceptedAt ? { acceptedAt: view.acceptedAt } : {}),
    ...(view.memberId ? { memberId: view.memberId } : {}),
    ...(view.memberDeviceId ? { memberDeviceId: view.memberDeviceId } : {}),
    ...(view.memberSessions ? {
      memberSessions: view.memberSessions.map((session) => ({
        memberId: session.memberId,
        deviceId: session.deviceId,
        createdAt: session.createdAt,
        ...(session.acceptedBy ? { acceptedBy: session.acceptedBy } : {}),
      })),
    } : {}),
    ...(view.shareId ? { shareId: view.shareId } : {}),
    ...(typeof view.failedAcceptCount === 'number' ? { failedAcceptCount: view.failedAcceptCount } : {}),
    ...(view.lockedUntil ? { lockedUntil: view.lockedUntil } : {}),
    ...(view.redactedShareLabel ? { redactedShareLabel: view.redactedShareLabel } : {}),
    ...(view.policyVersion !== undefined ? { policyVersion: view.policyVersion } : {}),
    grants: [...view.grants],
    grantRequests: (view.grantRequests ?? []).map((request) => ({
      ...request,
      requestedGrants: [...request.requestedGrants],
    })),
  };
}

/**
 * Build the collaborator join URL with the invite token in the URL
 * *fragment*. A fragment is never sent to the server in the navigation
 * request and never appears in a `Referer` header or proxy access log.
 */
function buildJoinUrl(relayUrl: string, token: string): string {
  const url = new URL('/relay/join', relayUrl);
  // Assigning via the search/query API would leak the token to relay access
  // logs; the fragment is client-only. base64url tokens need no extra encoding.
  url.hash = `inviteToken=${token}`;
  return url.toString();
}

function buildShareTicketJoinUrl(relayUrl: string, shareId: string, password: string): string {
  const url = new URL(`/relay/join/${encodeURIComponent(shareId)}`, relayUrl);
  // Keep the password in the fragment for the same reason as invite tokens:
  // the browser does not send fragments in HTTP requests or Referer headers.
  const fragment = new URLSearchParams();
  fragment.set('password', password);
  url.hash = fragment.toString();
  return url.toString();
}

/**
 * Read a relay response body under the caller's still-armed abort timeout,
 * bounded to `maxBytes` of decoded content.
 *
 * - A declared `Content-Length` over the cap is rejected before any body byte
 *   is read (`relay-response-too-large`), and the stream is cancelled so no
 *   payload is retained.
 * - A chunked body with no usable `Content-Length` is read incrementally; once
 *   the decoded byte count exceeds the cap the reader is cancelled and the same
 *   error is thrown, so an unbounded chunked stream cannot force buffering.
 * - The caller's `AbortController` errors an in-flight `reader.read()` when the
 *   deadline fires, so a headers-then-stalled body fails within the deadline;
 *   that (and any other read failure) surfaces as `relay-unreachable`.
 */
async function readBodyBounded(res: Response, maxBytes: number): Promise<string> {
  // Reject an oversized declared body before reading a single byte.
  const declared = res.headers.get('content-length');
  if (declared !== null) {
    const declaredBytes = Number(declared);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      // Cancel so the connection/stream is released without buffering the payload.
      await res.body?.cancel().catch(() => {});
      throw new RelayShareError(
        'relay-response-too-large',
        502,
        `relay declared ${declaredBytes} bytes, over the ${maxBytes}-byte cap`,
      );
    }
  }

  const stream = res.body;
  // A null body means the response carries no content (a spec-compliant fetch
  // returns `body === null` only for a genuinely empty body, e.g. 204/304), so
  // `res.text()` resolves to a tiny/empty string — there is nothing to bound.
  // The abort timer still covers this await.
  if (!stream) {
    return res.text();
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RelayShareError(
          'relay-response-too-large',
          502,
          `relay body exceeded the ${maxBytes}-byte cap`,
        );
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof RelayShareError) throw err;
    // A timeout abort or transport error during the body read is, like a failed
    // header round-trip, an unreachable relay from the dashboard's point of view.
    await reader.cancel().catch(() => {});
    throw new RelayShareError(
      'relay-unreachable',
      502,
      `relay request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buffer);
}

export function createRelayShareClient(opts: RelayShareClientOptions): RelayShareClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.relayUrl;
  const authHeader = `Bearer ${opts.relayToken}`;
  // Floor at 1ms so a misconfigured 0/negative does not disable the abort path.
  const requestTimeoutMs = Math.max(1, opts.requestTimeoutMs ?? DEFAULT_RELAY_SHARE_REQUEST_TIMEOUT_MS);
  // Floor at 1 byte so a misconfigured 0/negative does not disable the cap.
  const maxResponseBytes = Math.max(1, opts.maxResponseBytes ?? DEFAULT_RELAY_SHARE_MAX_RESPONSE_BYTES);

  async function call(path: string, body: unknown, method = 'POST'): Promise<unknown> {
    let res: Response;
    const controller = new AbortController();
    // A single timer arms the abort for BOTH the header round-trip and the body
    // read: a relay that returns headers then stalls the body is aborted at the
    // same deadline, and the timer is cleared only after the body is consumed.
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    let text: string;
    try {
      try {
        res = await fetchImpl(new URL(path, base), {
          method,
          headers: { 'content-type': 'application/json', authorization: authHeader },
          signal: controller.signal,
          ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
        });
      } catch (err) {
        // Timeouts and network failures share `relay-unreachable` so the dashboard
        // can surface a single operator-actionable 502 without hanging waiters.
        throw new RelayShareError(
          'relay-unreachable',
          502,
          `relay request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      text = await readBodyBounded(res, maxResponseBytes);
    } finally {
      clearTimeout(timer);
    }
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new RelayShareError('relay-bad-response', 502, 'relay returned a non-JSON response');
    }
    if (!res.ok) {
      const relayError = (parsed as { error?: unknown }).error;
      const code = res.status === 401
        ? 'relay-rejected-token'
        : typeof relayError === 'string' ? relayError : 'relay-error';
      // Relay 4xx/503 product-policy responses are actionable in the local
      // dashboard. A 401 means the node token is misconfigured, so surface it
      // as an operator-side 502 without leaking the token.
      const status: RelayShareErrorStatus = (
        res.status === 400
        || res.status === 404
        || res.status === 409
        || res.status === 429
        || res.status === 503
      )
        ? res.status
        : 502;
      throw new RelayShareError(code, status);
    }
    return parsed;
  }

  return {
    async createTaskShare(input): Promise<{ share: TaskShareSummary; joinUrl: string; shareTicket?: TaskShareTicket }> {
      const requestBody: CreateNodeTaskShareRequest = {
        subject: { kind: 'task', taskId: input.taskId },
        grants: ['view'],
        ttlMs: input.ttlMs,
        ...(input.displayLabel ? { displayLabel: input.displayLabel } : {}),
      };
      const parsed = await call('/relay/node/invitations', requestBody) as Partial<CreateNodeTaskShareResponse>;
      if (!parsed.invitation || typeof parsed.token !== 'string') {
        throw new RelayShareError('relay-bad-response', 502, 'relay create response missing fields');
      }
      return {
        share: toSummary(parsed.invitation),
        joinUrl: buildJoinUrl(base, parsed.token),
        ...(parsed.shareTicket ? {
          shareTicket: {
            shareId: parsed.shareTicket.shareId,
            password: parsed.shareTicket.password,
            redactedShareLabel: parsed.shareTicket.redactedShareLabel,
            joinUrl: buildShareTicketJoinUrl(base, parsed.shareTicket.shareId, parsed.shareTicket.password),
          },
        } : {}),
      };
    },

    async revokeTaskShare(invitationId): Promise<{ share: TaskShareSummary; alreadyRevoked: boolean }> {
      const parsed = await call(
        `/relay/node/invitations/${encodeURIComponent(invitationId)}/revoke`,
        {},
      ) as Partial<RevokeNodeTaskShareResponse>;
      if (!parsed.invitation) {
        throw new RelayShareError('relay-bad-response', 502, 'relay revoke response missing fields');
      }
      return { share: toSummary(parsed.invitation), alreadyRevoked: parsed.alreadyRevoked ?? false };
    },

    async listTaskShares(): Promise<TaskShareSummary[]> {
      const parsed = await call('/relay/node/invitations', undefined, 'GET') as Partial<ListNodeTaskSharesResponse>;
      if (!Array.isArray(parsed.invitations)) {
        throw new RelayShareError('relay-bad-response', 502, 'relay list response missing invitations');
      }
      return parsed.invitations.map(toSummary);
    },

    async approveGrantRequest(invitationId, requestId): Promise<ResolveTaskShareGrantRequestApiResponse> {
      const parsed = await call(
        `/relay/node/invitations/${encodeURIComponent(invitationId)}/grant-requests/${encodeURIComponent(requestId)}/approve`,
        {},
      ) as { invitation?: RelayNodeInvitationView; request?: ResolveTaskShareGrantRequestApiResponse['request'] };
      if (!parsed.invitation || !parsed.request) {
        throw new RelayShareError('relay-bad-response', 502, 'relay approve response missing fields');
      }
      return { share: toSummary(parsed.invitation), request: parsed.request };
    },

    async denyGrantRequest(invitationId, requestId): Promise<ResolveTaskShareGrantRequestApiResponse> {
      const parsed = await call(
        `/relay/node/invitations/${encodeURIComponent(invitationId)}/grant-requests/${encodeURIComponent(requestId)}/deny`,
        {},
      ) as { invitation?: RelayNodeInvitationView; request?: ResolveTaskShareGrantRequestApiResponse['request'] };
      if (!parsed.invitation || !parsed.request) {
        throw new RelayShareError('relay-bad-response', 502, 'relay deny response missing fields');
      }
      return { share: toSummary(parsed.invitation), request: parsed.request };
    },

    async sendContactShareEnvelope(envelope): Promise<ContactShareEnvelope> {
      const parsed = await call('/relay/node/contact-share/envelopes', envelope) as { envelope?: ContactShareEnvelope };
      if (!parsed.envelope) {
        throw new RelayShareError('relay-bad-response', 502, 'relay contact-share response missing envelope');
      }
      return parsed.envelope;
    },
  };
}

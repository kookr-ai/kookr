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
 * RFC: `docs/rfc/rfc-easy-connection-sharing.md` — Phase A0.
 */

import type {
  CreateNodeTaskShareRequest,
  CreateNodeTaskShareResponse,
  ListNodeTaskSharesResponse,
  RelayNodeInvitationView,
  RevokeNodeTaskShareResponse,
  TaskShareTicket,
  TaskShareSummary,
} from '../remote/share-contract.js';

// Share TTL bounds. The relay re-validates with its own `NODE_SHARE_*`
// constants (`relay/server.ts`) — the remote import boundary forbids sharing
// the value across `src/server` ↔ `relay`, so keep the two pairs in sync.
/** Lower bound on a share TTL — long enough for a collaborator to join. */
export const TASK_SHARE_MIN_TTL_MS = 60_000;
/** Upper bound — matches the relay `InvitationStore` default; no permanent shares. */
export const TASK_SHARE_MAX_TTL_MS = 24 * 60 * 60 * 1000;
/** Default A0 share lifetime when the caller does not specify one. */
export const TASK_SHARE_DEFAULT_TTL_MS = 10 * 60 * 1000;

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
  createTaskShare(input: { taskId: string; ttlMs: number }): Promise<{
    share: TaskShareSummary;
    joinUrl: string;
    shareTicket?: TaskShareTicket;
  }>;
  /** Revoke a previously created invitation owned by the configured node. */
  revokeTaskShare(invitationId: string): Promise<{ share: TaskShareSummary; alreadyRevoked: boolean }>;
  /** List Phase A0 task shares owned by the configured node. */
  listTaskShares(): Promise<TaskShareSummary[]>;
}

export interface RelayShareClientOptions {
  /** Base relay URL, e.g. the operator's `KOOKR_RELAY_URL`. */
  relayUrl: string;
  /** Node token, e.g. the operator's `KOOKR_RELAY_TOKEN`. */
  relayToken: string;
  /** Test seam; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
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
    ...(view.shareId ? { shareId: view.shareId } : {}),
    ...(typeof view.failedAcceptCount === 'number' ? { failedAcceptCount: view.failedAcceptCount } : {}),
    ...(view.lockedUntil ? { lockedUntil: view.lockedUntil } : {}),
    ...(view.redactedShareLabel ? { redactedShareLabel: view.redactedShareLabel } : {}),
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

export function createRelayShareClient(opts: RelayShareClientOptions): RelayShareClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.relayUrl;
  const authHeader = `Bearer ${opts.relayToken}`;

  async function call(path: string, body: unknown, method = 'POST'): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchImpl(new URL(path, base), {
        method,
        headers: { 'content-type': 'application/json', authorization: authHeader },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw new RelayShareError(
        'relay-unreachable',
        502,
        `relay request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const text = await res.text();
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
  };
}

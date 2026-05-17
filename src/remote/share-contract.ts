/**
 * Easy Connection Sharing — share contracts.
 *
 * Type-only module. It is imported with `import type` from `src/server`
 * (the dashboard backend) so that local-only mode never loads remote
 * runtime code: see `scripts/check-remote-import-boundaries.ts`. The relay
 * (`relay/`) is free to import these as values, but there are no values
 * here — only structural contracts shared across the node, the relay, and
 * the dashboard backend.
 *
 * RFC: `docs/rfc/rfc-easy-connection-sharing.md` — Phases A0-E.
 */

import type { NodeId } from './ids.js';

export type TaskShareGrant =
  | 'view'
  | 'terminalInput'
  | 'launch'
  | 'stop'
  | 'permissionApprove';

export type TaskShareCreateGrant = 'view';
export type TaskShareMutableGrant = Exclude<TaskShareGrant, 'view'>;

export type TaskShareGrantRequestStatus = 'pending' | 'approved' | 'denied';

export interface TaskShareGrantRequest {
  requestId: string;
  invitationId: string;
  requestedGrants: TaskShareMutableGrant[];
  status: TaskShareGrantRequestStatus;
  requestedAt: string;
  requestedBy?: string;
  comment?: string;
  resolvedAt?: string;
  resolution?: 'approved' | 'denied';
}

/** A0 shares one subject only: a single task on the current node. */
export interface TaskShareSubject {
  kind: 'task';
  taskId: string;
}

/**
 * Node → relay request to create the initial view-only invitation for a task
 * on the calling node. Mutating grants are added only through owner-approved
 * grant requests after a member joins.
 */
export interface CreateNodeTaskShareRequest {
  subject: TaskShareSubject;
  grants: [TaskShareCreateGrant];
  ttlMs?: number;
  displayLabel?: string;
}

/**
 * Safe projection of a relay invitation record returned to the node.
 *
 * Deliberately excludes `tokenHash`, `memberTokenHash`, `grantId`, and
 * `policyVersion`: the dashboard backend never needs relay-internal
 * secrets or hashes to render owner state.
 */
export interface RelayNodeInvitationView {
  invitationId: string;
  nodeId: NodeId;
  taskId: string;
  grants: TaskShareGrant[];
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  acceptedAt?: string;
  connectedViewerCount?: number;
  shareId?: string;
  failedAcceptCount?: number;
  lockedUntil?: string;
  redactedShareLabel?: string;
  grantRequests?: TaskShareGrantRequest[];
}

/** One-time Phase C ticket secret returned only on creation. */
export interface RelayShareTicketSecret {
  shareId: string;
  password: string;
  redactedShareLabel: string;
}

/** Owner-facing Phase C ticket. The password is never returned by list/read paths. */
export interface TaskShareTicket {
  shareId: string;
  password: string;
  joinUrl: string;
  redactedShareLabel: string;
}

/**
 * Relay → node create response. `token` is the single-use invitation
 * secret; it is delivered once over the authenticated node channel and is
 * never placed in a URL query string by the relay.
 */
export interface CreateNodeTaskShareResponse {
  invitation: RelayNodeInvitationView;
  token: string;
  shareTicket?: RelayShareTicketSecret;
}

/** Relay → node revoke response. */
export interface RevokeNodeTaskShareResponse {
  invitation: RelayNodeInvitationView;
  alreadyRevoked: boolean;
}

/** Relay → node list response for the node-scoped owner state read path. */
export interface ListNodeTaskSharesResponse {
  invitations: RelayNodeInvitationView[];
}

export type RemoteTaskProjectionStatus =
  | 'pending'
  | 'open'
  | 'inProgress'
  | 'needsInput'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * The only remote task view contract in Phase A0.
 *
 * The local node owns this projection. It intentionally contains no paths,
 * raw prompts, transcripts, diffs, terminal bytes, command output, or
 * environment data.
 */
export interface RemoteTaskProjectionV1 {
  schemaVersion: 'remote-task-projection.v1';
  nodeId: NodeId;
  taskId: string;
  /** Allowlisted characters only, max 80 chars. */
  taskLabel: string;
  status: RemoteTaskProjectionStatus;
  hasFinding: boolean;
  needsInput: boolean;
  updatedAt: string;
}

export interface RemoteTaskProjectionEnvelopeV1 {
  type: 'remote.taskProjection.v1';
  invitationId: string;
  projection: RemoteTaskProjectionV1;
}

export type TaskShareOwnerState =
  | 'waiting'
  | 'viewerConnected'
  | 'revoked'
  | 'expired'
  | 'revokePending';

/**
 * Owner-facing summary of a task share, returned by the dashboard backend.
 *
 * Carries no secret: the one-time invite token is surfaced only once, in
 * the `joinUrl` of {@link CreateTaskShareApiResponse}, and never again.
 */
export interface TaskShareSummary {
  invitationId: string;
  taskId: string;
  createdAt: string;
  expiresAt: string;
  state: TaskShareOwnerState;
  connectedViewerCount: number;
  revokedAt?: string;
  acceptedAt?: string;
  revokePendingAt?: string;
  shareId?: string;
  failedAcceptCount?: number;
  lockedUntil?: string;
  redactedShareLabel?: string;
  grants: TaskShareGrant[];
  grantRequests: TaskShareGrantRequest[];
}

/**
 * `POST /api/share/task` response.
 *
 * `joinUrl` carries the invite token in the URL *fragment*
 * (`#inviteToken=...`), never the query string, so the token is not sent
 * to the relay in the initial navigation request and is not captured by
 * referrer headers, proxy logs, or browser history sync.
 */
export interface CreateTaskShareApiResponse {
  share: TaskShareSummary;
  /** Legacy fragment-token join path, preserved for existing A0 links. */
  joinUrl: string;
  /** Phase C share ID/password ticket, returned only once at creation. */
  shareTicket?: TaskShareTicket;
  shareMaxTtlMs?: number;
}

/** `POST /api/share/task/:invitationId/revoke` response. */
export interface RevokeTaskShareApiResponse {
  share: TaskShareSummary;
  /** `true` when the share was already revoked before this request (no-op). */
  alreadyRevoked: boolean;
}

/** `GET /api/share/task` response. */
export interface ListTaskSharesApiResponse {
  shares: TaskShareSummary[];
  shareMaxTtlMs?: number;
}

export interface ResolveTaskShareGrantRequestApiResponse {
  share: TaskShareSummary;
  request: TaskShareGrantRequest;
}

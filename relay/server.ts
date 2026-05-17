import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';

import { WebSocket, WebSocketServer } from 'ws';

import {
  DEFAULT_HOSTED_RELAY_URL,
  createHostedRelayGateStatus,
  hostedRelayStatusMessage,
  parseHostedRelayFlag,
  parseHostedRelayMode,
  parseHostedRelayPositiveInt,
  type HostedRelayAlert,
  type HostedRelayGateStatus,
  type HostedRelayMetricSnapshot,
  type HostedRelayMetricsResponse,
  type HostedRelayMode,
  type HostedRelayNodeCredentialResponse,
  type HostedRelayStatus,
} from '../src/shared/contracts/hosted-relay.js';
import { isNodeHello, makeRelayHello, REMOTE_PROTOCOL_VERSION, type NodeHello } from '../src/remote/handshake.js';
import type { CommandOutcome, CommandResult, RemoteCommandAction } from '../src/remote/command-journal.js';
import { isRemoteControlEvent, type RemoteControlEvent } from '../src/remote/control-events.js';
import { asGrantId, asNodeId, asSeq, asSessionEpoch, asSessionId, type GrantId, type NodeEpoch, type NodeId, type Seq, type SessionEpoch, type SessionId } from '../src/remote/ids.js';
import type { KnownGrant, PolicyGrantRecord, PolicyRevokeMessage, ShareGrant, ShareSubject } from '../src/remote/policy-sync.js';
import { grantForRemoteCommandAction, isKnownGrant } from '../src/remote/grants.js';
import { isTerminalStreamEvent, type TerminalReplayGapEvent, type TerminalStreamEvent } from '../src/remote/stream-events.js';
import { isPushAlertDeltaPayload, makeRedactedPushPayload } from '../src/remote/push.js';
import type { RelayNodeCredentialStatusResponse } from '../src/shared/contracts/relay-connection.js';
import type {
  RemoteTaskProjectionEnvelopeV1,
  RemoteTaskProjectionV1,
  RelayNodeInvitationView,
  RelayShareTicketSecret,
  TaskShareGrant,
  TaskShareMutableGrant,
} from '../src/remote/share-contract.js';
import { InvitationStore, type InvitationRecord } from './src/invitations/store.js';
import { createPushFanout, type PushDeliveryOutcome, type PushFanout, type PushSender } from './src/push/fanout.js';
import { createPushSubscriptionStore, isPushSubscription, type PushSubscriptionStore, type StoredPushSubscription } from './src/push/subscriptions.js';
import { createVapidKeyStore, type VapidKeyStore } from './src/push/vapid.js';
import { RelaySqliteStateStore, type PersistedNodeRegistration } from './src/state/sqlite.js';

interface NodeRegistration extends PersistedNodeRegistration {}

interface RelayClientSubscription {
  ws: WebSocket;
  auth: RelayClientAuth;
  terminal?: {
    sessionId: SessionId;
    sessionEpoch: SessionEpoch;
  };
}

interface RelayClientAuth {
  kind: 'owner' | 'member';
  actorId: string;
  grants: ShareGrant[];
  grantId: GrantId;
  invitationId?: string;
  expiresAt?: string;
}

interface PresenceMember {
  clientId: string;
  actorId: string;
  nodeId: NodeId;
  grants: ShareGrant[];
  connectedAt: string;
  invitationId?: string;
}

export interface RelayMetadataAuditRow {
  type: 'relay.metadata-audit';
  commandId: string;
  nodeId: NodeId;
  action?: RemoteCommandAction;
  outcome: CommandOutcome | 'forwarded';
  timestamp: string;
  reason?: string;
}

interface PendingCommandRecipient {
  nodeId: NodeId;
  commandId: string;
  subscription: RelayClientSubscription;
}

export interface RelayNodeStatus {
  nodeId: NodeId;
  ownerId: string;
  displayName: string;
  connected: boolean;
  lastSeen?: string;
  protocolVersion?: number;
  policySyncVersion: number;
  policySyncStatus: 'synced' | 'syncing' | 'lagging';
  activeLeases: number;
  pendingPermissions: number;
}

export interface RelayServerOptions {
  adminToken?: string;
  accountToken?: string;
  accountId?: string;
  clientToken?: string;
  ownerId?: string;
  allowInsecureAdmin?: boolean;
  allowInsecureClients?: boolean;
  hostedRelay?: Partial<HostedRelayRuntimeOptions>;
  pushDisabled?: boolean;
  pushSender?: PushSender;
  pushSubject?: string;
  streamBackpressureBytes?: number;
  terminalReplayMaxEvents?: number;
  stateDbPath?: string | null;
  stateStore?: Pick<RelaySqliteStateStore, 'load' | 'saveRegistration' | 'saveInvitation' | 'probe' | 'close'>;
  stateProbe?: () => boolean;
  bindHost?: string;
  trustedProxy?: boolean;
  shareMaxTtlMs?: number;
}

interface HostedRelayRuntimeOptions {
  enabled: boolean;
  operationalGatesMet: boolean;
  mode: HostedRelayMode;
  relayUrl: string;
  deploymentOwner: string;
  environment: string;
  tlsExpiresAt: string | null;
  dataRetentionDays: number;
  shareCreateLimitPerMinute: number;
  accountPairLimitPerMinute: number;
  maxHeartbeatAgeMsAlert: number;
  maxHttp5xxAlert: number;
}

export interface RelayServerHandle {
  httpServer: Server;
  url(): string;
  registerNode(opts?: { displayName?: string; ownerId?: string }): { nodeId: NodeId; nodeToken: string };
  createInvitation(opts: { nodeId: NodeId; subject?: ShareSubject; grants: ShareGrant[]; ttlMs?: number; shareTicket?: boolean; displayLabel?: string }): { invitation: InvitationRecord; token: string; shareTicket?: RelayShareTicketSecret };
  acceptInvitation(token: string, acceptedBy?: string): ReturnType<InvitationStore['accept']>;
  revokeInvitation(invitationId: string): ReturnType<InvitationStore['revoke']>;
  invitations(): InvitationRecord[];
  nodeStatuses(): RelayNodeStatus[];
  pushSubscriptions(): StoredPushSubscription[];
  streamMetrics(): { clientDropped: { backpressure: number } };
  rotateVapidKeys(): { publicKey: string; version: number; invalidated: number };
  sendTestPush(deviceId: string): Promise<PushDeliveryOutcome>;
  metadataAuditRows(): RelayMetadataAuditRow[];
  close(): Promise<void>;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function safeEqualString(actual: string | null | undefined, expected: string | null | undefined): boolean {
  if (!actual || !expected) return false;
  const actualDigest = createHash('sha256').update(actual).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host === '[::1]';
}

function isLoopbackAddress(address: string): boolean {
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
    || address === 'localhost';
}

function defaultRedactedShareLabel(shareId: string | undefined): string {
  const digits = (shareId ?? '').replace(/\D/g, '');
  if (digits.length !== 6) return '';
  return `${digits.slice(0, 3)}-***`;
}

function clientAddress(req: IncomingMessage, opts: { trustedProxy: boolean }): string {
  const socketAddress = (req.socket.remoteAddress || 'unknown').slice(0, 160);
  if (!opts.trustedProxy || !isLoopbackAddress(socketAddress)) return socketAddress;
  const forwardedFor = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwardedFor) ? forwardedFor.at(-1) : forwardedFor;
  const forwarded = raw?.split(',').map((part) => part.trim()).filter(Boolean).at(-1);
  return (forwarded || socketAddress).slice(0, 160);
}

function remoteAddressKey(req: IncomingMessage, opts: { trustedProxy: boolean }): string {
  return clientAddress(req, opts);
}

function requestIsSecure(req: IncomingMessage, opts: { trustedProxy: boolean }): boolean {
  if (Boolean((req.socket as typeof req.socket & { encrypted?: boolean }).encrypted)) return true;
  if (!opts.trustedProxy || !isLoopbackAddress(req.socket.remoteAddress || 'unknown')) return false;
  const forwardedProto = req.headers['x-forwarded-proto'];
  const raw = Array.isArray(forwardedProto) ? forwardedProto.at(-1) : forwardedProto;
  return raw?.split(',').map((part) => part.trim().toLowerCase()).at(-1) === 'https';
}

class RelayStateWriteError extends Error {
  constructor(
    readonly operation: string,
    cause: unknown,
  ) {
    super(`relay state write failed during ${operation}`, { cause });
    this.name = 'RelayStateWriteError';
  }
}

function issueNodeToken(): string {
  return `kookr_tok_v1_${randomBytes(24).toString('base64url')}`;
}

function readJson(req: IncomingMessage): Promise<unknown> {
  const limitBytes = Number.parseInt(process.env.KOOKR_RELAY_REQUEST_BODY_LIMIT_BYTES ?? '1000000', 10);
  const maxBytes = Number.isInteger(limitBytes) && limitBytes > 0 ? limitBytes : 1_000_000;
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// Every relay response withholds the Referer header so an invite/member
// token that lands in a URL fragment can never leak to a third party via a
// cross-origin navigation or sub-resource request. RFC: Phase A0.
const RELAY_SECURITY_HEADERS = { 'referrer-policy': 'no-referrer' } as const;
const RELAY_MEMBER_COOKIE = 'kookr_relay_member_token';

function sendJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...RELAY_SECURITY_HEADERS, ...headers });
  res.end(JSON.stringify(payload));
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...RELAY_SECURITY_HEADERS });
  res.end(html);
}

function sendText(res: ServerResponse, status: number, contentType: string, text: string): void {
  res.writeHead(status, { 'content-type': contentType, ...RELAY_SECURITY_HEADERS });
  res.end(text);
}

function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim();
}

function cookieValue(req: IncomingMessage, name: string): string | null {
  const cookie = req.headers.cookie;
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (rawKey !== name) continue;
    const value = rawValue.join('=');
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

function memberCookie(token: string, req: IncomingMessage, opts: { trustedProxy: boolean }): string {
  const secure = requestIsSecure(req, opts);
  return [
    `${RELAY_MEMBER_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/relay',
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

function isAuthorizedAdmin(req: IncomingMessage, adminToken: string | undefined): boolean {
  if (!adminToken) return false;
  return safeEqualString(bearer(req), adminToken);
}

function ownerClientAuth(ownerId: string, nodeId: NodeId): RelayClientAuth {
  return {
    kind: 'owner',
    actorId: ownerId,
    grants: ['admin'],
    grantId: asGrantId(`owner-local:${nodeId}`),
  };
}

function authenticateClient(
  req: IncomingMessage,
  opts: RelayServerOptions,
  invitations: InvitationStore,
  ownerId: string,
  nodeId: NodeId,
  url?: URL,
): RelayClientAuth | null {
  if (opts.allowInsecureClients) return ownerClientAuth(ownerId, nodeId);
  if (opts.clientToken && url?.searchParams.get('clientToken') === opts.clientToken) return ownerClientAuth(ownerId, nodeId);
  if (isAuthorizedAdmin(req, opts.adminToken)) return ownerClientAuth(ownerId, nodeId);
  const memberToken = bearer(req) ?? cookieValue(req, RELAY_MEMBER_COOKIE);
  if (memberToken) {
    const invitation = invitations.authenticateMember(memberToken);
    if (invitation && invitation.nodeId === nodeId) {
      return {
        kind: 'member',
        actorId: invitation.acceptedBy ?? invitation.memberId ?? invitation.invitationId,
        grants: [...invitation.grants],
        grantId: invitation.grantId,
        invitationId: invitation.invitationId,
        expiresAt: invitation.expiresAt,
      };
    }
  }
  return null;
}

function isAuthorizedClient(req: IncomingMessage, opts: RelayServerOptions, url?: URL): boolean {
  if (opts.allowInsecureClients) return true;
  if (opts.clientToken && url?.searchParams.get('clientToken') === opts.clientToken) return true;
  return isAuthorizedAdmin(req, opts.adminToken);
}

function streamKey(nodeEpoch: NodeEpoch, sessionId: SessionId, sessionEpoch: SessionEpoch): string {
  return `${nodeEpoch}:${sessionId}:${sessionEpoch}`;
}

function parseSeq(value: string | null): Seq | null {
  if (value === null || value.trim() === '') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return asSeq(parsed);
}

function parseTerminalSubscription(url: URL): RelayClientSubscription['terminal'] | undefined {
  const sessionId = url.searchParams.get('terminalSessionId');
  const sessionEpoch = url.searchParams.get('terminalSessionEpoch');
  if (!sessionId || !sessionEpoch) return undefined;
  return {
    sessionId: asSessionId(sessionId),
    sessionEpoch: asSessionEpoch(sessionEpoch),
  };
}

function isShareSubject(value: unknown): value is ShareSubject {
  const subject = value as Partial<ShareSubject>;
  return typeof value === 'object'
    && value !== null
    && typeof subject.nodeId === 'string'
    && (
      subject.kind === 'node'
      || (subject.kind === 'project' && typeof (subject as { projectId?: unknown }).projectId === 'string')
      || (subject.kind === 'task' && typeof (subject as { taskId?: unknown }).taskId === 'string')
      || (subject.kind === 'session' && typeof (subject as { sessionId?: unknown }).sessionId === 'string')
    );
}

function parseGrantList(value: unknown): ShareGrant[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((grant) => typeof grant === 'string')) return null;
  return [...new Set(value as string[])] as ShareGrant[];
}

// Bounds for node-scoped Phase A0 task shares. The upper bound prevents a
// dashboard from minting an effectively permanent share; the lower bound
// keeps a freshly created share usable long enough to actually be joined.
// Keep in sync with `TASK_SHARE_{MIN,MAX}_TTL_MS` in
// `src/server/relay-share-client.ts` (the boundary forbids sharing the value).
const NODE_SHARE_MIN_TTL_MS = 60_000;
const NODE_SHARE_DEFAULT_MAX_TTL_MS = 24 * 60 * 60 * 1000;
export const RELAY_SHARE_TTL_HARD_CAP_MS = 31 * 24 * 60 * 60 * 1000;
const NODE_SHARE_DEFAULT_TTL_MS = 10 * 60 * 1000;
const SHARE_TICKET_SOURCE_MAX_FAILED_ATTEMPTS = 10;
const SHARE_TICKET_SOURCE_LOCKOUT_MS = 15 * 60 * 1000;

function resolveRelayShareMaxTtlMs(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return NODE_SHARE_DEFAULT_MAX_TTL_MS;
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return NODE_SHARE_DEFAULT_MAX_TTL_MS;
  return Math.min(Math.floor(parsed), RELAY_SHARE_TTL_HARD_CAP_MS);
}
function normalizeHostedRelayOptions(opts: RelayServerOptions): HostedRelayRuntimeOptions {
  const hosted = opts.hostedRelay ?? {};
  const relayUrl = hosted.relayUrl
    ?? process.env.KOOKR_HOSTED_RELAY_URL
    ?? process.env.KOOKR_RELAY_PUBLIC_ORIGIN
    ?? DEFAULT_HOSTED_RELAY_URL;
  const mode = hosted.mode ?? parseHostedRelayMode(process.env.KOOKR_RELAY_MODE ?? process.env.KOOKR_HOSTED_RELAY_MODE);
  return {
    enabled: hosted.enabled ?? parseHostedRelayFlag(process.env.KOOKR_HOSTED_RELAY_ENABLED),
    operationalGatesMet: hosted.operationalGatesMet ?? parseHostedRelayFlag(process.env.KOOKR_HOSTED_RELAY_OPS_GATES_MET),
    mode,
    relayUrl,
    deploymentOwner: hosted.deploymentOwner ?? process.env.KOOKR_HOSTED_RELAY_OWNER ?? '',
    environment: hosted.environment ?? process.env.KOOKR_HOSTED_RELAY_ENVIRONMENT ?? '',
    tlsExpiresAt: hosted.tlsExpiresAt ?? process.env.KOOKR_HOSTED_RELAY_TLS_EXPIRES_AT ?? null,
    dataRetentionDays: parseHostedRelayPositiveInt(
      hosted.dataRetentionDays ?? process.env.KOOKR_RELAY_METADATA_RETENTION_DAYS ?? process.env.KOOKR_HOSTED_RELAY_RETENTION_DAYS,
      30,
    ),
    shareCreateLimitPerMinute: parseHostedRelayPositiveInt(
      hosted.shareCreateLimitPerMinute ?? process.env.KOOKR_RELAY_SHARE_CREATE_LIMIT_PER_MINUTE,
      20,
    ),
    accountPairLimitPerMinute: parseHostedRelayPositiveInt(
      hosted.accountPairLimitPerMinute ?? process.env.KOOKR_RELAY_ACCOUNT_PAIR_LIMIT_PER_MINUTE,
      10,
    ),
    maxHeartbeatAgeMsAlert: parseHostedRelayPositiveInt(
      hosted.maxHeartbeatAgeMsAlert ?? process.env.KOOKR_RELAY_HEARTBEAT_ALERT_MS,
      60_000,
    ),
    maxHttp5xxAlert: parseHostedRelayPositiveInt(
      hosted.maxHttp5xxAlert ?? process.env.KOOKR_RELAY_5XX_ALERT_THRESHOLD,
      1,
    ),
  };
}

function hostedRelayStatus(
  hosted: HostedRelayRuntimeOptions,
  accountTokenConfigured: boolean,
): HostedRelayStatus {
  const gates: HostedRelayGateStatus = {
    ...createHostedRelayGateStatus(hosted.operationalGatesMet),
    accountDeviceAuth: hosted.operationalGatesMet && accountTokenConfigured,
    nodePairingAuth: hosted.operationalGatesMet && accountTokenConfigured,
  };
  const operationalGatesMet = Object.values(gates).every(Boolean);
  const mode = hosted.enabled && operationalGatesMet ? hosted.mode : 'notConfigured';
  return {
    configured: hosted.enabled && operationalGatesMet,
    relayUrl: hosted.relayUrl,
    defaultEnabled: hosted.enabled,
    operationalGatesMet,
    mode,
    message: hostedRelayStatusMessage({ defaultEnabled: hosted.enabled, operationalGatesMet, mode }),
    checkedAt: new Date().toISOString(),
    gates,
    ...(hosted.deploymentOwner ? { deploymentOwner: hosted.deploymentOwner } : {}),
    ...(hosted.environment ? { environment: hosted.environment } : {}),
    tlsExpiresAt: hosted.tlsExpiresAt,
    dataRetentionDays: hosted.dataRetentionDays,
  };
}

function createWindowLimiter(windowMs: number) {
  const windows = new Map<string, { startedAt: number; count: number }>();
  return (key: string, limit: number): boolean => {
    const now = Date.now();
    const current = windows.get(key);
    if (!current || now - current.startedAt >= windowMs) {
      windows.set(key, { startedAt: now, count: 1 });
      return true;
    }
    if (current.count >= limit) return false;
    current.count += 1;
    return true;
  };
}

function emptyMetrics(): HostedRelayMetricSnapshot {
  return {
    ticketsCreated: 0,
    ticketsAccepted: 0,
    ticketsRevoked: 0,
    ticketsExpired: 0,
    acceptFailuresByReason: {},
    rateLimitHits: 0,
    perShareLockCount: 0,
    securityEvents: 0,
    activeNodeSockets: 0,
    activeClientSockets: 0,
    maxNodeHeartbeatAgeMs: null,
    lastRevokePropagationLatencyMs: null,
    policySyncFailures: 0,
    http5xxCount: 0,
  };
}

function countReason(metrics: HostedRelayMetricSnapshot, reason: string): void {
  metrics.acceptFailuresByReason[reason] = (metrics.acceptFailuresByReason[reason] ?? 0) + 1;
}

/**
 * A node task share: a task-subject invitation whose initial grant is `view`.
 * Phase E may add the explicit mutating grants below after owner approval.
 * Admin-created non-task or unknown-grant invitations stay outside the
 * node-scoped dashboard surface.
 */
const TASK_SHARE_GRANTS: readonly TaskShareGrant[] = ['view', 'terminalInput', 'launch', 'stop', 'permissionApprove'];
const MUTABLE_TASK_SHARE_GRANTS: readonly TaskShareMutableGrant[] = ['terminalInput', 'launch', 'stop', 'permissionApprove'];

function isTaskShareGrant(value: ShareGrant): value is TaskShareGrant {
  return (TASK_SHARE_GRANTS as readonly string[]).includes(value);
}

function isMutableTaskShareGrant(value: ShareGrant): value is TaskShareMutableGrant {
  return (MUTABLE_TASK_SHARE_GRANTS as readonly string[]).includes(value);
}

function isNodeTaskShare(
  invitation: InvitationRecord,
): invitation is InvitationRecord & { subject: Extract<ShareSubject, { kind: 'task' }> } {
  return invitation.subject.kind === 'task'
    && invitation.grants.includes('view')
    && invitation.grants.every(isTaskShareGrant);
}

/**
 * Project a Phase A0 task-share invitation down to the safe view returned by
 * the node-scoped endpoints. Relay-internal secrets/hashes (`tokenHash`,
 * `memberTokenHash`, `grantId`, `policyVersion`) are intentionally dropped.
 * Callers pre-filter with {@link isNodeTaskShare}, so the non-task branch of
 * the `taskId` ternary is unreachable and only satisfies union narrowing.
 */
function toNodeInvitationView(invitation: InvitationRecord, connectedViewerCount = 0): RelayNodeInvitationView {
  return {
    invitationId: invitation.invitationId,
    nodeId: invitation.nodeId,
    taskId: invitation.subject.kind === 'task' ? invitation.subject.taskId : '',
    grants: invitation.grants.filter(isTaskShareGrant),
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    connectedViewerCount,
    ...(invitation.revokedAt ? { revokedAt: invitation.revokedAt } : {}),
    ...(invitation.acceptedAt ? { acceptedAt: invitation.acceptedAt } : {}),
    ...(invitation.shareId ? { shareId: invitation.shareId } : {}),
    ...(typeof invitation.failedAcceptCount === 'number' ? { failedAcceptCount: invitation.failedAcceptCount } : {}),
    ...(invitation.lockedUntil ? { lockedUntil: invitation.lockedUntil } : {}),
    ...(invitation.redactedShareLabel ? { redactedShareLabel: invitation.redactedShareLabel } : {}),
    grantRequests: (invitation.grantRequests ?? []).map((request) => ({
      ...request,
      requestedGrants: [...request.requestedGrants],
    })),
  };
}

/** Parse a node-scoped create-share request body. */
function parseNodeTaskShareBody(
  body: { subject?: unknown; grants?: unknown; ttlMs?: unknown; displayLabel?: unknown },
  shareMaxTtlMs: number,
): { taskId: string; ttlMs?: number; displayLabel?: string } | { error: string } {
  const subject = body.subject as { kind?: unknown; taskId?: unknown } | undefined;
  if (
    typeof subject !== 'object'
    || subject === null
    || subject.kind !== 'task'
    || typeof subject.taskId !== 'string'
    || subject.taskId.length === 0
  ) {
    return { error: 'subject must be { kind: "task", taskId }' };
  }
  if (body.grants !== undefined) {
    if (!Array.isArray(body.grants) || body.grants.length !== 1 || body.grants[0] !== 'view') {
      return { error: 'Phase A0 node shares grant "view" only' };
    }
  }
  if (body.ttlMs !== undefined && (
    typeof body.ttlMs !== 'number'
    || !Number.isFinite(body.ttlMs)
    || body.ttlMs < NODE_SHARE_MIN_TTL_MS
    || body.ttlMs > shareMaxTtlMs
  )) {
    return { error: `ttlMs must be a number between ${NODE_SHARE_MIN_TTL_MS} and ${shareMaxTtlMs}` };
  }
  if (body.displayLabel !== undefined && typeof body.displayLabel !== 'string') {
    return { error: 'displayLabel must be a string' };
  }
  const displayLabel = typeof body.displayLabel === 'string'
    ? body.displayLabel.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 80)
    : '';
  return {
    taskId: subject.taskId,
    ...(body.ttlMs !== undefined ? { ttlMs: body.ttlMs as number } : {}),
    ...(displayLabel ? { displayLabel } : {}),
  };
}

function parseGrantRequestBody(body: { grants?: unknown; comment?: unknown }): { grants: TaskShareMutableGrant[]; comment?: string } | { error: string } {
  const grants = parseGrantList(body.grants);
  if (!grants) return { error: 'non-empty grants array is required' };
  const requestedGrants = [...new Set(grants)].filter(isMutableTaskShareGrant);
  if (requestedGrants.length !== grants.length || requestedGrants.length === 0) {
    return { error: 'request grants must be Phase E mutable task-share grants' };
  }
  if (body.comment !== undefined && typeof body.comment !== 'string') {
    return { error: 'comment must be a string' };
  }
  return {
    grants: requestedGrants,
    ...(typeof body.comment === 'string' ? { comment: body.comment } : {}),
  };
}

function grantRequestStatus(reason: string): 400 | 404 | 409 {
  switch (reason) {
    case 'not-found':
      return 404;
    case 'empty-grants':
      return 400;
    default:
      return 409;
  }
}

function isRemoteTaskProjection(value: unknown): value is RemoteTaskProjectionV1 {
  const projection = value as Partial<RemoteTaskProjectionV1>;
  return typeof value === 'object'
    && value !== null
    && projection.schemaVersion === 'remote-task-projection.v1'
    && typeof projection.nodeId === 'string'
    && typeof projection.taskId === 'string'
    && typeof projection.taskLabel === 'string'
    && projection.taskLabel.length <= 80
    && (
      projection.status === 'pending'
      || projection.status === 'open'
      || projection.status === 'inProgress'
      || projection.status === 'needsInput'
      || projection.status === 'completed'
      || projection.status === 'failed'
      || projection.status === 'cancelled'
    )
    && typeof projection.hasFinding === 'boolean'
    && typeof projection.needsInput === 'boolean'
    && typeof projection.updatedAt === 'string';
}

function remoteTaskProjectionEnvelopeFromEvent(event: RemoteControlEvent): RemoteTaskProjectionEnvelopeV1 | null {
  const payload = event.payload as Partial<RemoteTaskProjectionEnvelopeV1>;
  if (
    typeof payload === 'object'
    && payload !== null
    && payload.type === 'remote.taskProjection.v1'
    && typeof payload.invitationId === 'string'
    && isRemoteTaskProjection(payload.projection)
  ) {
    return payload as RemoteTaskProjectionEnvelopeV1;
  }
  return null;
}

function isRemoteTaskProjectionPayload(value: unknown): boolean {
  return typeof value === 'object'
    && value !== null
    && (value as { type?: unknown }).type === 'remote.taskProjection.v1';
}

function authAllows(auth: RelayClientAuth, grant: KnownGrant | null, invitationStore?: InvitationStore): boolean {
  if (auth.kind === 'owner' || auth.grants.includes('admin')) return true;
  if (auth.expiresAt && Date.parse(auth.expiresAt) <= Date.now()) return false;
  if (!grant) return false;
  let grants = auth.grants;
  if (auth.invitationId && invitationStore) {
    const invitation = invitationStore.list().find((candidate) => candidate.invitationId === auth.invitationId);
    if (!invitation || invitation.revokedAt || Date.parse(invitation.expiresAt) <= Date.now()) return false;
    grants = invitation.grants;
  }
  return grants.some((candidate) => candidate === grant && isKnownGrant(candidate));
}

function authAllowsTerminalStream(auth: RelayClientAuth, invitationStore?: InvitationStore): boolean {
  return authAllows(auth, 'terminalInput', invitationStore);
}

function isRemoteCommandResultMessage(value: unknown): value is { type: 'remote.command.result' } & CommandResult {
  const msg = value as Partial<CommandResult> & { type?: unknown };
  return typeof value === 'object'
    && value !== null
    && msg.type === 'remote.command.result'
    && typeof msg.commandId === 'string'
    && typeof msg.action === 'string'
    && typeof msg.outcome === 'string';
}

function supportsTerminalStream(hello: NodeHello | undefined): boolean {
  return hello?.supportedFeatures.includes('terminal-stream') ?? false;
}

export function createRelayServer(opts: RelayServerOptions = {}): RelayServerHandle {
  const stateLoadedStartedAt = Date.now();
  const stateDbPath = opts.stateDbPath ?? process.env.KOOKR_RELAY_STATE_DB_PATH ?? null;
  const stateStore = opts.stateStore ?? (stateDbPath ? new RelaySqliteStateStore(stateDbPath) : null);
  const stateSnapshot = stateStore?.load() ?? { registrations: [], invitations: [], quarantinedRows: 0 };
  if (stateStore) {
    console.log(JSON.stringify({
      event: 'relay.state.loaded',
      invitations: stateSnapshot.invitations.length,
      registrations: stateSnapshot.registrations.length,
      lockouts: stateSnapshot.invitations.filter((invitation) => Boolean(invitation.lockedUntil)).length,
      quarantinedRows: stateSnapshot.quarantinedRows,
      ms: Date.now() - stateLoadedStartedAt,
    }));
  }
  const bindHost = opts.bindHost ?? process.env.KOOKR_RELAY_BIND_HOST ?? '0.0.0.0';
  const trustedProxy = opts.trustedProxy ?? (
    process.env.KOOKR_RELAY_TRUSTED_PROXY === '0' ? false : isLoopbackHost(bindHost)
  );
  if (!isLoopbackHost(bindHost) && process.env.KOOKR_RELAY_ALLOW_INSECURE_BIND !== '1') {
    console.warn(JSON.stringify({
      event: 'relay.insecure_bind_warning',
      bindHost,
      message: 'KOOKR_RELAY_BIND_HOST is non-loopback; put the relay behind TLS and set KOOKR_RELAY_ALLOW_INSECURE_BIND=1 to acknowledge this release warning.',
    }));
  }
  const registrations = new Map<NodeId, NodeRegistration>();
  const tokenIndex = new Map<string, NodeRegistration>();
  const nodeSockets = new Map<NodeId, WebSocket>();
  const nodeHello = new Map<NodeId, NodeHello>();
  const subscribers = new Map<NodeId, Set<RelayClientSubscription>>();
  const commandRecipients = new Map<string, PendingCommandRecipient>();
  const presence = new Map<NodeId, Map<string, PresenceMember>>();
  const replay = new Map<NodeId, RemoteControlEvent[]>();
  const terminalReplay = new Map<NodeId, Map<string, TerminalStreamEvent[]>>();
  const metadataAudit: RelayMetadataAuditRow[] = [];
  const ticketSourceFailures = new Map<string, { count: number; lockedUntil?: number }>();
  let closing = false;
  let stateWriteFailure: { operation: string; message: string; at: string } | null = null;
  const hosted = normalizeHostedRelayOptions(opts);
  const accountToken = opts.accountToken ?? process.env.KOOKR_RELAY_ACCOUNT_TOKEN;
  const accountId = opts.accountId ?? process.env.KOOKR_RELAY_ACCOUNT_ID ?? opts.ownerId ?? 'hosted-owner';
  const accountPairLimiter = createWindowLimiter(60_000);
  const shareCreateLimiter = createWindowLimiter(60_000);
  const shareResetLimiter = createWindowLimiter(60_000);
  const shareMaxTtlMs = resolveRelayShareMaxTtlMs(opts.shareMaxTtlMs ?? process.env.KOOKR_RELAY_SHARE_MAX_TTL_MS);
  const relayMetrics = emptyMetrics();
  const windowEvents: Array<{ at: number; kind: 'rateLimitHits' | 'perShareLockCount' | 'securityEvents' | 'http5xxCount' }> = [];
  const recentWindowMs = parseHostedRelayPositiveInt(process.env.KOOKR_RELAY_METRICS_WINDOW_MS, 5 * 60_000);
  const invitations = new InvitationStore({
    initialInvitations: stateSnapshot.invitations,
    onSave: (invitation) => {
      if (!stateStore) return;
      try {
        stateStore.saveInvitation(invitation);
      } catch (err) {
        stateWriteFailure = {
          operation: 'saveInvitation',
          message: err instanceof Error ? err.message : String(err),
          at: new Date().toISOString(),
        };
        throw new RelayStateWriteError('saveInvitation', err);
      }
    },
  });
  const streamMetrics = { clientDropped: { backpressure: 0 } };
  const streamBackpressureBytes = opts.streamBackpressureBytes ?? 1_000_000;
  const terminalReplayMaxEvents = opts.terminalReplayMaxEvents ?? 512;
  const vapidKeys: VapidKeyStore = createVapidKeyStore();
  const pushSubscriptions: PushSubscriptionStore = createPushSubscriptionStore();
  const pushFanout: PushFanout = createPushFanout({
    subscriptions: pushSubscriptions,
    vapidKeys,
    disabled: opts.pushDisabled ?? process.env.KOOKR_PUSH_DISABLED === 'true',
    sender: opts.pushSender,
    subject: opts.pushSubject,
  });
  const ownerId = opts.ownerId ?? 'local-owner';

  for (const registration of stateSnapshot.registrations) {
    registrations.set(registration.nodeId, registration);
    tokenIndex.set(registration.tokenHash, registration);
  }

  const recordRecent = (kind: 'rateLimitHits' | 'perShareLockCount' | 'securityEvents' | 'http5xxCount'): void => {
    windowEvents.push({ at: Date.now(), kind });
  };

  const incrementRateLimit = (): void => {
    relayMetrics.rateLimitHits += 1;
    recordRecent('rateLimitHits');
  };

  const incrementHttp5xx = (): void => {
    relayMetrics.http5xxCount += 1;
    recordRecent('http5xxCount');
  };

  const incrementSecurityEvent = (): void => {
    relayMetrics.securityEvents += 1;
    recordRecent('securityEvents');
  };

  const persistRegistration = (registration: NodeRegistration): void => {
    if (closing) return;
    if (!stateStore) return;
    try {
      stateStore.saveRegistration(registration);
    } catch (err) {
      stateWriteFailure = {
        operation: 'saveRegistration',
        message: err instanceof Error ? err.message : String(err),
        at: new Date().toISOString(),
      };
      throw new RelayStateWriteError('saveRegistration', err);
    }
  };

  const recordLastSeen = (registration: NodeRegistration): void => {
    const updated: NodeRegistration = { ...registration, lastSeen: new Date().toISOString() };
    try {
      persistRegistration(updated);
      Object.assign(registration, updated);
    } catch (err) {
      if (err instanceof RelayStateWriteError) {
        console.error(JSON.stringify({
          event: 'relay.state.write_failed',
          operation: err.operation,
          message: err.message,
        }));
        return;
      }
      throw err;
    }
  };

  const registerNode = (regOpts: { displayName?: string; ownerId?: string; deviceId?: string } = {}) => {
    const nodeId = asNodeId(`kookr-node-${randomUUID()}`);
    const nodeToken = issueNodeToken();
    const registration: NodeRegistration = {
      nodeId,
      ownerId: regOpts.ownerId ?? ownerId,
      displayName: regOpts.displayName ?? nodeId,
      ...(regOpts.deviceId ? { deviceId: regOpts.deviceId } : {}),
      tokenHash: tokenHash(nodeToken),
      createdAt: new Date().toISOString(),
    };
    persistRegistration(registration);
    registrations.set(nodeId, registration);
    tokenIndex.set(registration.tokenHash, registration);
    return { nodeId, nodeToken };
  };

  const currentHostedStatus = (): HostedRelayStatus => hostedRelayStatus(hosted, Boolean(accountToken));

  const hostedBlocksNewShares = (): string | null => {
    if (!hosted.enabled) return null;
    const status = currentHostedStatus();
    if (!status.configured) return 'hosted-relay-unavailable';
    if (status.mode === 'maintenance') return 'hosted-relay-maintenance';
    if (status.mode === 'emergencyDisabled') return 'hosted-relay-emergency-disabled';
    return null;
  };

  const hostedBlocksAccountPairing = (): string | null => {
    const status = currentHostedStatus();
    if (!status.configured) return 'hosted-relay-unavailable';
    if (status.mode === 'maintenance') return 'hosted-relay-maintenance';
    if (status.mode === 'emergencyDisabled') return 'hosted-relay-emergency-disabled';
    return null;
  };

  const authenticateAccount = (req: IncomingMessage): string | null => {
    if (!accountToken) return null;
    return safeEqualString(bearer(req), accountToken) ? accountId : null;
  };

  const rotateNodeToken = (nodeId: NodeId): { nodeId: NodeId; nodeToken: string } | null => {
    const registration = registrations.get(nodeId);
    if (!registration) return null;
    const nodeToken = issueNodeToken();
    const updated: NodeRegistration = { ...registration, tokenHash: tokenHash(nodeToken) };
    persistRegistration(updated);
    tokenIndex.delete(registration.tokenHash);
    Object.assign(registration, updated);
    tokenIndex.set(updated.tokenHash, registration);
    const activeSocket = nodeSockets.get(nodeId);
    if (activeSocket) {
      nodeSockets.delete(nodeId);
      activeSocket.close(4003, 'node token rotated');
    }
    return { nodeId, nodeToken };
  };

  const createInvitation = (input: { nodeId: NodeId; subject?: ShareSubject; grants: ShareGrant[]; ttlMs?: number; shareTicket?: boolean; displayLabel?: string }) => (
    invitations.create(input)
  );

  /**
   * Authenticate a node-scoped HTTP request by its node token. The node may
   * only ever act on its own `nodeId`; the relay never trusts a `nodeId`
   * supplied in the request body. Returns `null` for any unknown/missing
   * token so the caller can answer 401 without leaking which tokens exist.
   */
  const authenticateNode = (req: IncomingMessage): NodeRegistration | null => {
    const token = bearer(req);
    if (!token) return null;
    return tokenIndex.get(tokenHash(token)) ?? null;
  };

  const acceptInvitation = (token: string, acceptedBy?: string) => {
    const accepted = invitations.accept(token, acceptedBy);
    if (accepted.ok) {
      relayMetrics.ticketsAccepted += 1;
      sendPolicyDelta(accepted.accepted.invitation.nodeId, accepted.accepted.policyGrant);
    } else {
      countReason(relayMetrics, accepted.reason);
    }
    return accepted;
  };

  const acceptShareTicket = (shareId: string, password: string, acceptedBy?: string) => {
    const accepted = invitations.acceptTicket(shareId, password, acceptedBy);
    if (accepted.ok) {
      relayMetrics.ticketsAccepted += 1;
      sendPolicyDelta(accepted.accepted.invitation.nodeId, accepted.accepted.policyGrant);
    } else {
      countReason(relayMetrics, accepted.reason);
      if (accepted.reason === 'locked') {
        relayMetrics.perShareLockCount += 1;
        recordRecent('perShareLockCount');
      }
    }
    return accepted;
  };

  const sourceLocked = (sourceKey: string): boolean => {
    const record = ticketSourceFailures.get(sourceKey);
    if (!record?.lockedUntil) return false;
    if (record.lockedUntil > Date.now()) return true;
    ticketSourceFailures.delete(sourceKey);
    return false;
  };

  const recordTicketFailure = (sourceKey: string): void => {
    const existing = ticketSourceFailures.get(sourceKey);
    const count = (existing?.count ?? 0) + 1;
    ticketSourceFailures.set(sourceKey, {
      count,
      ...(count >= SHARE_TICKET_SOURCE_MAX_FAILED_ATTEMPTS
        ? { lockedUntil: Date.now() + SHARE_TICKET_SOURCE_LOCKOUT_MS }
        : {}),
    });
  };

  const revokeInvitation = (invitationId: string) => {
    const startedAt = Date.now();
    const revoked = invitations.revoke(invitationId);
    if (revoked.ok) {
      if (!revoked.alreadyRevoked) relayMetrics.ticketsRevoked += 1;
      closeRevokedSubscribers(revoked.invitation);
      sendPolicyRevoke(revoked.invitation);
      relayMetrics.lastRevokePropagationLatencyMs = Date.now() - startedAt;
    }
    return revoked;
  };

  const sendPolicyDelta = (nodeId: NodeId, grant: PolicyGrantRecord): void => {
    const ws = nodeSockets.get(nodeId);
    if (!ws || ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify({
        type: 'policy.delta',
        nodeId,
        policyVersion: grant.policyVersion,
        upserts: [grant],
        revokes: [],
      }));
    } catch {
      relayMetrics.policySyncFailures += 1;
    }
  };

  const sendPolicySync = (nodeId: NodeId, ws: WebSocket): void => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({
      type: 'policy.sync',
      nodeId,
      policyVersion: invitations.currentPolicyVersion(),
      grants: invitations.activePolicyGrantsForNode(nodeId),
      revokedGrantIds: invitations.revokedGrantIdsForNode(nodeId),
    }));
  };

  const sendPolicyRevoke = (invitation: InvitationRecord): void => {
    const ws = nodeSockets.get(invitation.nodeId);
    if (!ws || ws.readyState !== ws.OPEN) return;
    const msg: PolicyRevokeMessage = {
      type: 'policy.revoke',
      nodeId: invitation.nodeId,
      grantId: invitation.grantId,
      policyVersion: invitation.policyVersion,
    };
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      relayMetrics.policySyncFailures += 1;
    }
  };

  const closeRevokedSubscribers = (invitation: InvitationRecord): void => {
    const set = subscribers.get(invitation.nodeId);
    if (!set) return;
    for (const sub of [...set]) {
      if (sub.auth.invitationId !== invitation.invitationId) continue;
      sub.ws.close(4001, 'grant revoked');
      set.delete(sub);
    }
    if (set.size === 0) subscribers.delete(invitation.nodeId);
  };

  const connectedViewerCount = (nodeId: NodeId, invitationId: string): number => (
    [...(presence.get(nodeId)?.values() ?? [])]
      .filter((member) => member.invitationId === invitationId && member.grants.includes('view'))
      .length
  );

  const toNodeInvitationViewWithPresence = (invitation: InvitationRecord): RelayNodeInvitationView => (
    toNodeInvitationView(invitation, connectedViewerCount(invitation.nodeId, invitation.invitationId))
  );

  const nodeStatuses = (): RelayNodeStatus[] => [...registrations.values()].map((registration) => {
    const hello = nodeHello.get(registration.nodeId);
    return {
      nodeId: registration.nodeId,
      ownerId: registration.ownerId,
      displayName: registration.displayName,
      connected: nodeSockets.has(registration.nodeId),
      ...(registration.lastSeen ? { lastSeen: registration.lastSeen } : {}),
      ...(hello ? { protocolVersion: hello.protocolVersion } : {}),
      policySyncVersion: 0,
      policySyncStatus: 'synced',
      activeLeases: 0,
      pendingPermissions: 0,
    };
  });

  const metricsSnapshot = (): HostedRelayMetricSnapshot => {
    const now = Date.now();
    while (windowEvents.length > 0 && now - windowEvents[0].at > recentWindowMs) windowEvents.shift();
    const recent = {
      rateLimitHits: windowEvents.filter((event) => event.kind === 'rateLimitHits').length,
      perShareLockCount: windowEvents.filter((event) => event.kind === 'perShareLockCount').length,
      securityEvents: windowEvents.filter((event) => event.kind === 'securityEvents').length,
      http5xxCount: windowEvents.filter((event) => event.kind === 'http5xxCount').length,
    };
    const heartbeatAges = [...registrations.values()]
      .map((registration) => registration.lastSeen ? now - Date.parse(registration.lastSeen) : null)
      .filter((age): age is number => typeof age === 'number' && Number.isFinite(age));
    return {
      ...relayMetrics,
      ticketsExpired: invitations.list().filter((invitation) => (
        !invitation.revokedAt && Date.parse(invitation.expiresAt) <= now
      )).length,
      activeNodeSockets: nodeSockets.size,
      activeClientSockets: [...subscribers.values()].reduce((total, set) => total + set.size, 0),
      maxNodeHeartbeatAgeMs: heartbeatAges.length > 0 ? Math.max(...heartbeatAges) : null,
      recentWindowMs,
      recent,
    };
  };

  const relayAlerts = (metrics: HostedRelayMetricSnapshot): HostedRelayAlert[] => {
    const alerts: HostedRelayAlert[] = [];
    if (currentHostedStatus().mode === 'maintenance') {
      alerts.push({ code: 'maintenance-mode', severity: 'warning', message: 'Hosted relay is in maintenance mode.' });
    }
    if (currentHostedStatus().mode === 'emergencyDisabled') {
      alerts.push({ code: 'emergency-disabled', severity: 'critical', message: 'Hosted relay sharing is emergency-disabled.' });
    }
    if ((metrics.recent?.rateLimitHits ?? metrics.rateLimitHits) > 0) {
      alerts.push({ code: 'rate-limit-hits', severity: 'warning', message: 'Relay rate limits have blocked recent requests.' });
    }
    if ((metrics.recent?.perShareLockCount ?? metrics.perShareLockCount) > 0) {
      alerts.push({ code: 'per-share-lockout', severity: 'warning', message: 'At least one share ticket has been locked after repeated failures.' });
    }
    if ((metrics.recent?.securityEvents ?? metrics.securityEvents) > 0) {
      alerts.push({ code: 'security-events', severity: 'critical', message: 'Relay security events were observed recently.' });
    }
    if (metrics.maxNodeHeartbeatAgeMs !== null && metrics.maxNodeHeartbeatAgeMs > hosted.maxHeartbeatAgeMsAlert) {
      alerts.push({ code: 'heartbeat-age', severity: 'warning', message: 'At least one node heartbeat is stale.' });
    }
    if (metrics.policySyncFailures > 0) {
      alerts.push({ code: 'policy-sync-failures', severity: 'critical', message: 'Policy sync messages have failed.' });
    }
    if ((metrics.recent?.http5xxCount ?? metrics.http5xxCount) >= hosted.maxHttp5xxAlert) {
      alerts.push({ code: 'http-5xx-rate', severity: 'critical', message: 'Relay 5xx responses crossed the alert threshold.' });
    }
    return alerts;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        const dbProbeOk = opts.stateProbe ? opts.stateProbe() : (stateStore?.probe() ?? true);
        const dbReachable = dbProbeOk && stateWriteFailure === null;
        sendJson(res, 200, {
          status: currentHostedStatus().mode === 'emergencyDisabled' || !dbReachable ? 'degraded' : 'ok',
          dbReachable,
          ...(stateWriteFailure ? { stateWriteFailure } : {}),
          tlsExpiresAt: hosted.tlsExpiresAt,
          version: process.env.KOOKR_BUILD_VERSION ?? process.env.npm_package_version ?? 'dev',
          hostedRelay: currentHostedStatus(),
        });
        return;
      }
      if (
        url.pathname.startsWith('/relay/admin/')
        && !opts.allowInsecureAdmin
        && !isLoopbackAddress(clientAddress(req, { trustedProxy }))
      ) {
        incrementSecurityEvent();
        sendJson(res, 403, { error: 'admin-api-loopback-only' });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/relay/ops/status') {
        sendJson(res, 200, currentHostedStatus());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/relay/admin/metrics') {
        if (!opts.allowInsecureAdmin && !isAuthorizedAdmin(req, opts.adminToken)) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const metrics = metricsSnapshot();
        const response: HostedRelayMetricsResponse = { metrics, alerts: relayAlerts(metrics) };
        sendJson(res, 200, response);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/relay/dashboard') {
        sendHtml(res, 200, relayDashboardHtml());
        return;
      }
      if (req.method === 'GET' && (url.pathname === '/relay/join' || url.pathname.startsWith('/relay/join/'))) {
        sendHtml(res, 200, relayJoinHtml());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/relay/assets/xterm.js') {
        sendText(
          res,
          200,
          'text/javascript; charset=utf-8',
          await readFile(join(process.cwd(), 'node_modules/@xterm/xterm/lib/xterm.js'), 'utf8'),
        );
        return;
      }
      if (req.method === 'GET' && url.pathname === '/relay/assets/xterm.css') {
        sendText(
          res,
          200,
          'text/css; charset=utf-8',
          await readFile(join(process.cwd(), 'node_modules/@xterm/xterm/css/xterm.css'), 'utf8'),
        );
        return;
      }
      if (req.method === 'GET' && url.pathname === '/relay/dashboard/state') {
        const nodeId = url.searchParams.get('nodeId');
        if (!nodeId || !registrations.has(asNodeId(nodeId))) {
          sendJson(res, 404, { error: 'node not found' });
          return;
        }
        const auth = authenticateClient(
          req,
          opts,
          invitations,
          registrations.get(asNodeId(nodeId))?.ownerId ?? ownerId,
          asNodeId(nodeId),
          url,
        );
        if (!auth) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const encrypted = Boolean((req.socket as typeof req.socket & { encrypted?: boolean }).encrypted);
        const relayHostFingerprint = createHash('sha256')
          .update(`${req.headers.host ?? 'unknown'}:${encrypted ? 'tls' : 'plain'}`)
          .digest('hex')
          .slice(0, 16);
        const terminal = parseTerminalSubscription(url);
        if (terminal && !authAllowsTerminalStream(auth, invitations)) {
          sendJson(res, 403, { error: 'terminal grant required' });
          return;
        }
        const afterSeq = parseSeq(url.searchParams.get('afterSeq')) ?? asSeq(0);
        const terminalEvents = terminal
          ? collectTerminalReplayEvents(asNodeId(nodeId), terminal.sessionId, terminal.sessionEpoch, afterSeq)
          : [];
        const requestedNodeId = asNodeId(nodeId);
        const registration = registrations.get(requestedNodeId);
        const connected = nodeSockets.has(requestedNodeId);
        sendJson(res, 200, {
          nodeId,
          relayHostFingerprint,
          node: {
            nodeId,
            connected,
            ...(registration?.lastSeen ? { lastSeen: registration.lastSeen } : {}),
          },
          events: connected
            ? (replay.get(requestedNodeId) ?? [])
              .filter((event) => canSendEventToAuth(requestedNodeId, auth, event))
              .map((event) => eventForAuth(auth, event))
            : [],
          terminalEvents,
          members: [...(presence.get(asNodeId(nodeId))?.values() ?? [])],
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/relay/push/vapid-public-key') {
        const current = vapidKeys.current();
        sendJson(res, 200, { publicKey: current.publicKey, version: current.version, rotatedAt: current.rotatedAt });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/relay/push/subscriptions') {
        if (!isAuthorizedClient(req, opts, url)) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const body = await readJson(req) as { deviceId?: unknown; nodeId?: unknown; subscription?: unknown; vapidKeyVersion?: unknown };
        if (typeof body.deviceId !== 'string' || body.deviceId.length === 0) {
          sendJson(res, 400, { error: 'deviceId is required' });
          return;
        }
        if (typeof body.nodeId !== 'string' || !registrations.has(asNodeId(body.nodeId))) {
          sendJson(res, 400, { error: 'known nodeId is required' });
          return;
        }
        if (!isPushSubscription(body.subscription)) {
          sendJson(res, 400, { error: 'valid push subscription is required' });
          return;
        }
        const current = vapidKeys.current();
        if (body.vapidKeyVersion !== undefined && body.vapidKeyVersion !== current.version) {
          sendJson(res, 409, { error: 'vapid key version mismatch', currentVersion: current.version });
          return;
        }
        const stored = pushSubscriptions.upsert({
          deviceId: body.deviceId,
          nodeId: asNodeId(body.nodeId),
          subscription: body.subscription,
          vapidKeyVersion: current.version,
        });
        sendJson(res, 201, {
          deviceId: stored.deviceId,
          nodeId: stored.nodeId,
          vapidKeyVersion: stored.vapidKeyVersion,
        });
        return;
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/relay/push/subscriptions/')) {
        if (!isAuthorizedClient(req, opts, url)) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const deviceId = decodeURIComponent(url.pathname.slice('/relay/push/subscriptions/'.length));
        sendJson(res, 200, { removed: pushSubscriptions.remove(deviceId) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/relay/admin/push/vapid/rotate') {
        if (!opts.allowInsecureAdmin && !isAuthorizedAdmin(req, opts.adminToken)) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const rotated = vapidKeys.rotate();
        const invalidated = pushSubscriptions.invalidateVersion(rotated.version);
        sendJson(res, 200, { publicKey: rotated.publicKey, version: rotated.version, rotatedAt: rotated.rotatedAt, invalidated });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/relay/admin/push/test') {
        if (!opts.allowInsecureAdmin && !isAuthorizedAdmin(req, opts.adminToken)) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const body = await readJson(req) as { deviceId?: unknown };
        if (typeof body.deviceId !== 'string' || body.deviceId.length === 0) {
          sendJson(res, 400, { error: 'deviceId is required' });
          return;
        }
        sendJson(res, 200, await sendTestPush(body.deviceId));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/relay/admin/nodes') {
        if (!opts.allowInsecureAdmin && !isAuthorizedAdmin(req, opts.adminToken)) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        sendJson(res, 200, { nodes: nodeStatuses() });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/relay/admin/nodes') {
        if (!opts.allowInsecureAdmin && !isAuthorizedAdmin(req, opts.adminToken)) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const body = await readJson(req) as { displayName?: unknown; ownerId?: unknown };
        const issued = registerNode({
          displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
          ownerId: typeof body.ownerId === 'string' ? body.ownerId : undefined,
        });
        sendJson(res, 201, issued);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/relay/account/nodes') {
        const account = authenticateAccount(req);
        if (!account) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const modeBlock = hostedBlocksAccountPairing();
        if (modeBlock) {
          incrementHttp5xx();
          sendJson(res, 503, { error: modeBlock });
          return;
        }
        if (!accountPairLimiter(`account:${account}`, hosted.accountPairLimitPerMinute)) {
          incrementRateLimit();
          sendJson(res, 429, { error: 'rate-limit-exceeded' });
          return;
        }
        const body = await readJson(req) as { displayName?: unknown; deviceId?: unknown };
        const issued = registerNode({
          displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
          deviceId: typeof body.deviceId === 'string' ? body.deviceId : undefined,
          ownerId: account,
        });
        const response: HostedRelayNodeCredentialResponse = issued;
        sendJson(res, 201, response);
        return;
      }
      if (req.method === 'POST' && url.pathname.startsWith('/relay/account/nodes/') && url.pathname.endsWith('/token/rotate')) {
        const account = authenticateAccount(req);
        if (!account) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const nodeId = asNodeId(decodeURIComponent(
          url.pathname.slice('/relay/account/nodes/'.length, -'/token/rotate'.length),
        ));
        const registration = registrations.get(nodeId);
        if (!registration || registration.ownerId !== account) {
          sendJson(res, 404, { error: 'node not found' });
          return;
        }
        const rotated = rotateNodeToken(nodeId);
        if (!rotated) {
          sendJson(res, 404, { error: 'node not found' });
          return;
        }
        sendJson(res, 200, rotated);
        return;
      }
      if (req.method === 'POST' && url.pathname.startsWith('/relay/admin/nodes/') && url.pathname.endsWith('/token/rotate')) {
        if (!opts.allowInsecureAdmin && !isAuthorizedAdmin(req, opts.adminToken)) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const nodeId = asNodeId(decodeURIComponent(
          url.pathname.slice('/relay/admin/nodes/'.length, -'/token/rotate'.length),
        ));
        const rotated = rotateNodeToken(nodeId);
        if (!rotated) {
          sendJson(res, 404, { error: 'node not found' });
          return;
        }
        sendJson(res, 200, rotated);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/relay/admin/invitations') {
        if (!opts.allowInsecureAdmin && !isAuthorizedAdmin(req, opts.adminToken)) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        sendJson(res, 200, { invitations: invitations.list() });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/relay/admin/invitations') {
        if (!opts.allowInsecureAdmin && !isAuthorizedAdmin(req, opts.adminToken)) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const modeBlock = hostedBlocksNewShares();
        if (modeBlock) {
          incrementHttp5xx();
          sendJson(res, 503, { error: modeBlock });
          return;
        }
        const body = await readJson(req) as { nodeId?: unknown; subject?: unknown; grants?: unknown; ttlMs?: unknown };
        if (typeof body.nodeId !== 'string' || !registrations.has(asNodeId(body.nodeId))) {
          sendJson(res, 400, { error: 'known nodeId is required' });
          return;
        }
        const grants = parseGrantList(body.grants);
        if (!grants) {
          sendJson(res, 400, { error: 'non-empty grants array is required' });
          return;
        }
        if (body.subject !== undefined && (!isShareSubject(body.subject) || body.subject.nodeId !== body.nodeId)) {
          sendJson(res, 400, { error: 'subject must target the invited node' });
          return;
        }
        const created = createInvitation({
          nodeId: asNodeId(body.nodeId),
          subject: body.subject,
          grants,
          ttlMs: typeof body.ttlMs === 'number' && Number.isFinite(body.ttlMs) ? body.ttlMs : undefined,
        });
        relayMetrics.ticketsCreated += 1;
        sendJson(res, 201, {
          invitation: created.invitation,
          token: created.token,
          acceptUrl: `/relay/join#inviteToken=${encodeURIComponent(created.token)}`,
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/relay/invitations/accept') {
        const body = await readJson(req) as { token?: unknown; displayName?: unknown };
        const token = typeof body.token === 'string' ? body.token : url.searchParams.get('token');
        if (!token) {
          sendJson(res, 400, { error: 'token is required' });
          return;
        }
        const accepted = acceptInvitation(token, typeof body.displayName === 'string' ? body.displayName : undefined);
        if (!accepted.ok) {
          sendJson(res, accepted.reason === 'not-found' ? 404 : 409, { error: accepted.reason });
          return;
        }
        sendJson(
          res,
          200,
          { nodeId: accepted.accepted.invitation.nodeId },
          { 'set-cookie': memberCookie(accepted.accepted.memberToken, req, { trustedProxy }) },
        );
        return;
      }
      if (req.method === 'POST' && url.pathname === '/relay/share-tickets/accept') {
        const sourceKey = remoteAddressKey(req, { trustedProxy });
        const body = await readJson(req) as { shareId?: unknown; password?: unknown; displayName?: unknown };
        const shareId = typeof body.shareId === 'string' ? body.shareId : '';
        const password = typeof body.password === 'string' ? body.password : '';
        if (!shareId || !password) {
          sendJson(res, 400, { error: 'shareId and password are required' });
          return;
        }
        if (sourceLocked(sourceKey)) {
          incrementRateLimit();
          sendJson(res, 409, { error: 'ticket-unavailable' });
          return;
        }
        const accepted = acceptShareTicket(
          shareId,
          password,
          typeof body.displayName === 'string' ? body.displayName : undefined,
        );
        if (!accepted.ok) {
          recordTicketFailure(sourceKey);
          sendJson(res, 409, { error: 'ticket-unavailable' });
          return;
        }
        ticketSourceFailures.delete(sourceKey);
        sendJson(
          res,
          200,
          { nodeId: accepted.accepted.invitation.nodeId },
          { 'set-cookie': memberCookie(accepted.accepted.memberToken, req, { trustedProxy }) },
        );
        return;
      }
      if (req.method === 'POST' && url.pathname === '/relay/member/grant-requests') {
        const modeBlock = hostedBlocksNewShares();
        if (modeBlock) {
          incrementHttp5xx();
          sendJson(res, 503, { error: modeBlock });
          return;
        }
        const body = await readJson(req) as { nodeId?: unknown; grants?: unknown; comment?: unknown };
        if (typeof body.nodeId !== 'string') {
          sendJson(res, 400, { error: 'nodeId is required' });
          return;
        }
        const auth = authenticateClient(req, opts, invitations, ownerId, asNodeId(body.nodeId), url);
        if (!auth || auth.kind !== 'member' || !auth.invitationId) {
          sendJson(res, 401, { error: 'member-auth-required' });
          return;
        }
        const parsed = parseGrantRequestBody(body);
        if ('error' in parsed) {
          sendJson(res, 400, { error: parsed.error });
          return;
        }
        const requested = invitations.requestGrants({
          invitationId: auth.invitationId,
          requestedGrants: parsed.grants,
          requestedBy: auth.actorId,
          comment: parsed.comment,
        });
        if (!requested.ok) {
          sendJson(res, grantRequestStatus(requested.reason), { error: requested.reason });
          return;
        }
        sendJson(res, 201, { request: requested.request });
        return;
      }
      if (req.method === 'POST' && url.pathname.startsWith('/relay/admin/invitations/') && url.pathname.endsWith('/revoke')) {
        if (!opts.allowInsecureAdmin && !isAuthorizedAdmin(req, opts.adminToken)) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const invitationId = decodeURIComponent(url.pathname.slice('/relay/admin/invitations/'.length, -'/revoke'.length));
        const revoked = revokeInvitation(invitationId);
        if (!revoked.ok) {
          sendJson(res, 404, { error: revoked.reason });
          return;
        }
        sendJson(res, 200, { invitation: revoked.invitation, alreadyRevoked: revoked.alreadyRevoked });
        return;
      }
      // --- Node-scoped Phase A0 task-share endpoints ---------------------
      // Authenticated by the node token (not the relay admin token) and
      // scoped to the calling node's own `nodeId`. The local dashboard
      // backend uses these so it never needs the relay admin credential.
      if (req.method === 'GET' && url.pathname === '/relay/node/status') {
        const registration = authenticateNode(req);
        if (!registration) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const response: RelayNodeCredentialStatusResponse = {
          nodeId: registration.nodeId,
          displayName: registration.displayName,
        };
        sendJson(res, 200, response);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/relay/node/invitations') {
        const registration = authenticateNode(req);
        if (!registration) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        sendJson(res, 200, {
          invitations: invitations.list()
            .filter((invitation) => invitation.nodeId === registration.nodeId && isNodeTaskShare(invitation))
            .map(toNodeInvitationViewWithPresence),
        });
        return;
      }
      if (
        req.method === 'GET'
        && url.pathname.startsWith('/relay/node/invitations/')
        && !url.pathname.endsWith('/revoke')
      ) {
        const registration = authenticateNode(req);
        if (!registration) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const invitationId = decodeURIComponent(url.pathname.slice('/relay/node/invitations/'.length));
        if (!invitationId || invitationId.includes('/')) {
          sendJson(res, 404, { error: 'not-found' });
          return;
        }
        const existing = invitations.list().find((invitation) => invitation.invitationId === invitationId);
        if (!existing || existing.nodeId !== registration.nodeId || !isNodeTaskShare(existing)) {
          sendJson(res, 404, { error: 'not-found' });
          return;
        }
        sendJson(res, 200, {
          invitation: toNodeInvitationViewWithPresence(existing),
          node: {
            nodeId: registration.nodeId,
            connected: nodeSockets.has(registration.nodeId),
            ...(registration.lastSeen ? { lastSeen: registration.lastSeen } : {}),
          },
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/relay/node/invitations') {
        const registration = authenticateNode(req);
        if (!registration) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const modeBlock = hostedBlocksNewShares();
        if (modeBlock) {
          incrementHttp5xx();
          sendJson(res, 503, { error: modeBlock });
          return;
        }
        if (!shareCreateLimiter(`node:${registration.nodeId}`, hosted.shareCreateLimitPerMinute)) {
          incrementRateLimit();
          sendJson(res, 429, { error: 'rate-limit-exceeded' });
          return;
        }
        const parsed = parseNodeTaskShareBody(
          await readJson(req) as { subject?: unknown; grants?: unknown; ttlMs?: unknown; displayLabel?: unknown },
          shareMaxTtlMs,
        );
        if ('error' in parsed) {
          sendJson(res, 400, { error: parsed.error });
          return;
        }
        const created = createInvitation({
          nodeId: registration.nodeId,
          subject: { kind: 'task', nodeId: registration.nodeId, taskId: parsed.taskId },
          grants: ['view'],
          shareTicket: true,
          ttlMs: parsed.ttlMs ?? NODE_SHARE_DEFAULT_TTL_MS,
          ...(parsed.displayLabel ? { displayLabel: parsed.displayLabel } : {}),
        });
        relayMetrics.ticketsCreated += 1;
        sendJson(res, 201, {
          invitation: toNodeInvitationViewWithPresence(created.invitation),
          token: created.token,
          ...(created.shareTicket ? { shareTicket: created.shareTicket } : {}),
        });
        return;
      }
      if (
        req.method === 'POST'
        && url.pathname.startsWith('/relay/node/invitations/')
        && url.pathname.endsWith('/share-ticket/reset')
      ) {
        const registration = authenticateNode(req);
        if (!registration) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const invitationId = decodeURIComponent(
          url.pathname.slice('/relay/node/invitations/'.length, -'/share-ticket/reset'.length),
        );
        const existing = invitations.list().find((invitation) => invitation.invitationId === invitationId);
        if (!existing || existing.nodeId !== registration.nodeId || !isNodeTaskShare(existing)) {
          sendJson(res, 404, { error: 'not-found' });
          return;
        }
        if (!shareResetLimiter(`share-reset:${invitationId}`, 3)) {
          incrementRateLimit();
          sendJson(res, 429, { error: 'rate-limit-exceeded' });
          return;
        }
        const reset = invitations.resetShareTicket(invitationId);
        if (!reset.ok) {
          sendJson(res, 409, { error: reset.reason });
          return;
        }
        sendJson(res, 200, {
          invitation: toNodeInvitationViewWithPresence(reset.invitation),
          shareTicket: reset.shareTicket,
        });
        return;
      }
      if (
        req.method === 'POST'
        && url.pathname.startsWith('/relay/node/invitations/')
        && url.pathname.endsWith('/revoke')
      ) {
        const registration = authenticateNode(req);
        if (!registration) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const invitationId = decodeURIComponent(
          url.pathname.slice('/relay/node/invitations/'.length, -'/revoke'.length),
        );
        const existing = invitations.list().find((invitation) => invitation.invitationId === invitationId);
        // A node may only revoke its own Phase A0 task shares. Mismatches —
        // unknown id, another node's invitation, or a non-A0 invitation —
        // answer 404 (not 403) so a node cannot probe for invitation IDs or
        // act on invitations outside the A0 surface.
        if (!existing || existing.nodeId !== registration.nodeId || !isNodeTaskShare(existing)) {
          sendJson(res, 404, { error: 'not-found' });
          return;
        }
        const revoked = revokeInvitation(invitationId);
        if (!revoked.ok) {
          sendJson(res, 404, { error: revoked.reason });
          return;
        }
        sendJson(res, 200, {
          invitation: toNodeInvitationViewWithPresence(revoked.invitation),
          alreadyRevoked: revoked.alreadyRevoked,
        });
        return;
      }
      if (
        req.method === 'POST'
        && url.pathname.startsWith('/relay/node/invitations/')
        && (
          url.pathname.endsWith('/approve')
          || url.pathname.endsWith('/deny')
        )
      ) {
        const registration = authenticateNode(req);
        if (!registration) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const parts = url.pathname.split('/').map(decodeURIComponent);
        const invitationId = parts[4] ?? '';
        const requestId = parts[6] ?? '';
        const resolution = parts[7] ?? '';
        if (parts[5] !== 'grant-requests' || !invitationId || !requestId || (resolution !== 'approve' && resolution !== 'deny')) {
          sendJson(res, 404, { error: 'not-found' });
          return;
        }
        const modeBlock = hostedBlocksNewShares();
        if (modeBlock) {
          incrementHttp5xx();
          sendJson(res, 503, { error: modeBlock });
          return;
        }
        const existing = invitations.list().find((invitation) => invitation.invitationId === invitationId);
        if (!existing || existing.nodeId !== registration.nodeId || !isNodeTaskShare(existing)) {
          sendJson(res, 404, { error: 'not-found' });
          return;
        }
        const resolved = invitations.resolveGrantRequest({
          invitationId,
          requestId,
          approve: resolution === 'approve',
        });
        if (!resolved.ok) {
          sendJson(res, grantRequestStatus(resolved.reason), { error: resolved.reason });
          return;
        }
        if (resolution === 'approve' && resolved.invitation.acceptedAt) {
          sendPolicyDelta(registration.nodeId, {
            grantId: resolved.invitation.grantId,
            subject: resolved.invitation.subject,
            grants: [...resolved.invitation.grants],
            policyVersion: resolved.invitation.policyVersion,
            expiresAt: resolved.invitation.expiresAt,
          });
        }
        broadcastPresence(registration.nodeId);
        sendJson(res, 200, {
          invitation: toNodeInvitationViewWithPresence(resolved.invitation),
          request: resolved.request,
        });
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof RelayStateWriteError) {
        incrementHttp5xx();
        sendJson(res, 503, { error: 'relay-state-write-failed', operation: err.operation });
        return;
      }
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  const nodeWss = new WebSocketServer({ noServer: true });
  const clientWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/relay/node') {
      const token = bearer(req);
      const registration = token ? tokenIndex.get(tokenHash(token)) : undefined;
      if (!registration) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      nodeWss.handleUpgrade(req, socket, head, (ws) => {
        nodeWss.emit('connection', ws, req, registration);
      });
      return;
    }
    if (url.pathname === '/relay/client') {
      const nodeId = url.searchParams.get('nodeId');
      if (!nodeId || !registrations.has(asNodeId(nodeId))) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      const auth = authenticateClient(
        req,
        opts,
        invitations,
        registrations.get(asNodeId(nodeId))?.ownerId ?? ownerId,
        asNodeId(nodeId),
        url,
      );
      if (!auth) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      const terminal = parseTerminalSubscription(url);
      if (terminal && !authAllowsTerminalStream(auth, invitations)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      clientWss.handleUpgrade(req, socket, head, (ws) => {
        clientWss.emit('connection', ws, req, asNodeId(nodeId), auth);
      });
      return;
    }
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  });

  nodeWss.on('connection', (ws: WebSocket, _req: IncomingMessage, registration: NodeRegistration) => {
    let accepted = false;
    ws.on('message', (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        ws.close(1002, 'invalid json');
        return;
      }

      if (!accepted) {
        if (!isNodeHello(parsed) || parsed.nodeId !== registration.nodeId) {
          ws.send(JSON.stringify(makeRelayHello({
            outcome: 'refused',
            acceptedVersion: REMOTE_PROTOCOL_VERSION,
            refusalReason: 'credential-revoked',
          })));
          ws.close(1008, 'invalid node hello');
          return;
        }
        if (parsed.protocolVersion !== REMOTE_PROTOCOL_VERSION) {
          ws.send(JSON.stringify(makeRelayHello({
            outcome: 'refused',
            acceptedVersion: REMOTE_PROTOCOL_VERSION,
            refusalReason: 'unsupported-version',
          })));
          ws.close(1008, 'unsupported protocol');
          return;
        }
        accepted = true;
        const existing = nodeSockets.get(registration.nodeId);
        if (existing && existing !== ws) {
          existing.close(4000, 'superseded node connection');
        }
        nodeSockets.set(registration.nodeId, ws);
        nodeHello.set(registration.nodeId, parsed);
        recordLastSeen(registration);
        ws.send(JSON.stringify(makeRelayHello({
          outcome: 'accepted',
          acceptedVersion: REMOTE_PROTOCOL_VERSION,
          enabledFeatures: parsed.supportedFeatures,
          shareMaxTtlMs,
        })));
        sendPolicySync(registration.nodeId, ws);
        return;
      }

      if (
        isRemoteControlEvent(parsed)
        && parsed.nodeId === registration.nodeId
        && parsed.nodeEpoch === nodeHello.get(registration.nodeId)?.nodeEpoch
        && nodeSockets.get(registration.nodeId) === ws
      ) {
        recordLastSeen(registration);
        routeControlEvent(parsed);
        return;
      }

      if (
        isTerminalStreamEvent(parsed)
        && parsed.nodeId === registration.nodeId
        && parsed.nodeEpoch === nodeHello.get(registration.nodeId)?.nodeEpoch
        && nodeSockets.get(registration.nodeId) === ws
        && supportsTerminalStream(nodeHello.get(registration.nodeId))
      ) {
        recordLastSeen(registration);
        routeTerminalStreamEvent(parsed);
        return;
      }

      if (
        isRemoteCommandResultMessage(parsed)
        && nodeSockets.get(registration.nodeId) === ws
      ) {
        recordLastSeen(registration);
        routeCommandResult(registration.nodeId, parsed);
      }
    });
    ws.on('close', () => {
      if (nodeSockets.get(registration.nodeId) === ws) {
        nodeSockets.delete(registration.nodeId);
        recordLastSeen(registration);
      }
    });
  });

  function routeControlEvent(event: RemoteControlEvent): void {
    const events = replay.get(event.nodeId) ?? [];
    events.push(event);
    replay.set(event.nodeId, events.slice(-100));

    if (isPushAlertDeltaPayload(event.payload)) {
      void pushFanout.sendToNode(event.nodeId, event.payload.payload);
    }

    const subscribed = subscribers.get(event.nodeId);
    if (!subscribed) return;
    for (const sub of [...subscribed]) {
      if (!canSendEventToSubscriber(event.nodeId, sub, event)) continue;
      if (sub.ws.readyState === sub.ws.OPEN) sub.ws.send(JSON.stringify(eventForAuth(sub.auth, event)));
    }
  }

  function subscriptionStillAuthorized(nodeId: NodeId, sub: RelayClientSubscription): boolean {
    if (sub.auth.kind === 'owner') return true;
    if (!sub.auth.expiresAt || Date.parse(sub.auth.expiresAt) > Date.now()) return true;
    sub.ws.close(4002, 'grant expired');
    const set = subscribers.get(nodeId);
    set?.delete(sub);
    if (set?.size === 0) subscribers.delete(nodeId);
    if (sub.auth.invitationId) {
      const byNode = presence.get(nodeId);
      for (const [clientId, member] of byNode ?? []) {
        if (member.invitationId === sub.auth.invitationId) byNode?.delete(clientId);
      }
      if (byNode?.size === 0) presence.delete(nodeId);
    }
    return false;
  }

  function commandRecipientKey(nodeId: NodeId, commandId: string): string {
    return `${nodeId}\0${commandId}`;
  }

  function rememberCommandRecipient(nodeId: NodeId, commandId: string, subscription: RelayClientSubscription): void {
    commandRecipients.set(commandRecipientKey(nodeId, commandId), { nodeId, commandId, subscription });
  }

  function forgetCommandRecipient(nodeId: NodeId, commandId: string): void {
    commandRecipients.delete(commandRecipientKey(nodeId, commandId));
  }

  function projectionAuthStillAuthorized(
    nodeId: NodeId,
    auth: RelayClientAuth,
    envelope: RemoteTaskProjectionEnvelopeV1,
  ): boolean {
    if (auth.kind === 'owner') return true;
    if (!auth.invitationId || auth.invitationId !== envelope.invitationId) return false;
    const invitation = invitations.list().find((candidate) => candidate.invitationId === auth.invitationId);
    if (!invitation || invitation.nodeId !== nodeId || invitation.grantId !== auth.grantId) return false;
    if (invitation.revokedAt) return false;
    if (Date.parse(invitation.expiresAt) <= Date.now()) return false;
    if (!isNodeTaskShare(invitation)) return false;
    return invitation.subject.taskId === envelope.projection.taskId
      && invitation.grants.includes('view')
      && envelope.projection.nodeId === nodeId;
  }

  function projectionSubscriptionStillAuthorized(
    nodeId: NodeId,
    sub: RelayClientSubscription,
    envelope: RemoteTaskProjectionEnvelopeV1,
  ): boolean {
    if (projectionAuthStillAuthorized(nodeId, sub.auth, envelope)) return true;
    const invitation = sub.auth.invitationId
      ? invitations.list().find((candidate) => candidate.invitationId === sub.auth.invitationId)
      : null;
    if (invitation?.revokedAt) {
      sub.ws.close(4001, 'grant revoked');
      return false;
    }
    if (invitation && Date.parse(invitation.expiresAt) <= Date.now()) {
      sub.ws.close(4002, 'grant expired');
      return false;
    }
    return false;
  }

  function canSendEventToAuth(nodeId: NodeId, auth: RelayClientAuth, event: RemoteControlEvent): boolean {
    if (auth.kind === 'owner') return true;
    const projection = remoteTaskProjectionEnvelopeFromEvent(event);
    if (projection) return projectionAuthStillAuthorized(nodeId, auth, projection);
    return false;
  }

  function canSendEventToSubscriber(nodeId: NodeId, sub: RelayClientSubscription, event: RemoteControlEvent): boolean {
    if (!subscriptionStillAuthorized(nodeId, sub)) return false;
    if (sub.auth.kind === 'owner') return true;
    const projection = remoteTaskProjectionEnvelopeFromEvent(event);
    if (projection) return projectionSubscriptionStillAuthorized(nodeId, sub, projection);
    return false;
  }

  function eventForAuth(auth: RelayClientAuth, event: RemoteControlEvent): RemoteControlEvent {
    if (auth.kind === 'owner' || !auth.invitationId) return event;
    const envelope = remoteTaskProjectionEnvelopeFromEvent(event);
    if (!envelope) return event;
    const invitation = invitations.list().find((candidate) => candidate.invitationId === auth.invitationId);
    const displayLabel = invitation?.redactedShareLabel?.trim();
    if (!displayLabel) return event;
    const defaultLabel = defaultRedactedShareLabel(invitation?.shareId);
    const shareLifetimeMs = invitation ? Date.parse(invitation.expiresAt) - Date.parse(invitation.createdAt) : 0;
    if (displayLabel === defaultLabel && shareLifetimeMs <= NODE_SHARE_DEFAULT_MAX_TTL_MS) return event;
    return {
      ...event,
      payload: {
        ...envelope,
        projection: {
          ...envelope.projection,
          taskLabel: displayLabel,
        },
      },
    } as RemoteControlEvent;
  }

  function recordPresence(nodeId: NodeId, clientId: string, auth: RelayClientAuth): void {
    let byNode = presence.get(nodeId);
    if (!byNode) {
      byNode = new Map();
      presence.set(nodeId, byNode);
    }
    byNode.set(clientId, {
      clientId,
      actorId: auth.actorId,
      nodeId,
      grants: [...auth.grants],
      connectedAt: new Date().toISOString(),
      ...(auth.invitationId ? { invitationId: auth.invitationId } : {}),
    });
    broadcastPresence(nodeId);
  }

  function removePresence(nodeId: NodeId, clientId: string): void {
    const byNode = presence.get(nodeId);
    if (!byNode) return;
    byNode.delete(clientId);
    if (byNode.size === 0) presence.delete(nodeId);
    broadcastPresence(nodeId);
  }

  function broadcastPresence(nodeId: NodeId): void {
    const subscribed = subscribers.get(nodeId);
    if (!subscribed) return;
    const encoded = JSON.stringify({
      type: 'relay.presence',
      nodeId,
      members: [...(presence.get(nodeId)?.values() ?? [])],
    });
    for (const sub of [...subscribed]) {
      if (!subscriptionStillAuthorized(nodeId, sub)) continue;
      if (sub.ws.readyState === sub.ws.OPEN) sub.ws.send(encoded);
    }
  }

  function appendTerminalReplay(event: TerminalStreamEvent): void {
    if (event.kind === 'terminal.replay-gap') return;
    let bySession = terminalReplay.get(event.nodeId);
    if (!bySession) {
      bySession = new Map();
      terminalReplay.set(event.nodeId, bySession);
    }
    const key = streamKey(event.nodeEpoch, event.sessionId, event.sessionEpoch);
    const events = bySession.get(key) ?? [];
    events.push(event);
    bySession.set(key, events.slice(-terminalReplayMaxEvents));
  }

  function makeTerminalGapEvent(opts: {
    nodeId: NodeId;
    nodeEpoch: NodeEpoch;
    sessionId: SessionId;
    sessionEpoch: SessionEpoch;
    fromSeq: Seq;
    toSeq: Seq;
    reason: TerminalReplayGapEvent['payload']['reason'];
  }): TerminalReplayGapEvent {
    return {
      nodeId: opts.nodeId,
      nodeEpoch: opts.nodeEpoch,
      sessionId: opts.sessionId,
      sessionEpoch: opts.sessionEpoch,
      seq: opts.toSeq,
      ts: new Date().toISOString(),
      kind: 'terminal.replay-gap',
      payload: {
        fromSeq: opts.fromSeq,
        toSeq: opts.toSeq,
        reason: opts.reason,
      },
    };
  }

  function collectTerminalReplayEvents(
    nodeId: NodeId,
    sessionId: SessionId,
    sessionEpoch: SessionEpoch,
    afterSeq: Seq,
  ): TerminalStreamEvent[] {
    const hello = nodeHello.get(nodeId);
    if (!hello) return [];
    const events = terminalReplay.get(nodeId)?.get(streamKey(hello.nodeEpoch, sessionId, sessionEpoch)) ?? [];
    const selected = events.filter((event) => event.seq > afterSeq);
    const oldest = events[0]?.seq;
    const out: TerminalStreamEvent[] = [];
    if (hello && oldest !== undefined && afterSeq < asSeq(Number(oldest) - 1)) {
      out.push(makeTerminalGapEvent({
        nodeId,
        nodeEpoch: hello.nodeEpoch,
        sessionId,
        sessionEpoch,
        fromSeq: asSeq(Number(afterSeq) + 1),
        toSeq: asSeq(Number(oldest) - 1),
        reason: 'replay-buffer-miss',
      }));
    }
    out.push(...selected);
    return out;
  }

  function replayTerminalEvents(
    ws: WebSocket,
    nodeId: NodeId,
    sessionId: SessionId,
    sessionEpoch: SessionEpoch,
    afterSeq: Seq,
  ): void {
    for (const event of collectTerminalReplayEvents(nodeId, sessionId, sessionEpoch, afterSeq)) {
      safeSendStream(ws, event);
    }
  }

  function safeSendStream(ws: WebSocket, event: TerminalStreamEvent): void {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > streamBackpressureBytes) {
      streamMetrics.clientDropped.backpressure += 1;
      ws.close(1013, 'terminal stream backpressure');
      return;
    }
    ws.send(JSON.stringify(event));
  }

  function routeTerminalStreamEvent(event: TerminalStreamEvent): void {
    appendTerminalReplay(event);
    const subscribed = subscribers.get(event.nodeId);
    if (!subscribed) return;
    for (const sub of [...subscribed]) {
      if (!subscriptionStillAuthorized(event.nodeId, sub)) continue;
      if (!authAllowsTerminalStream(sub.auth, invitations)) continue;
      if (
        sub.terminal?.sessionId === event.sessionId
        && sub.terminal.sessionEpoch === event.sessionEpoch
      ) {
        safeSendStream(sub.ws, event);
      }
    }
  }

  function appendMetadataAudit(row: RelayMetadataAuditRow): void {
    metadataAudit.push(row);
  }

  function routeCommandResult(nodeId: NodeId, result: CommandResult): void {
    appendMetadataAudit({
      type: 'relay.metadata-audit',
      commandId: result.commandId,
      nodeId,
      action: result.action,
      outcome: result.outcome,
      timestamp: new Date().toISOString(),
      ...(result.reason ? { reason: result.reason } : {}),
    });
    const subscribed = subscribers.get(nodeId);
    if (!subscribed) return;
    const encoded = JSON.stringify({ type: 'remote.command.result', ...result });
    const recipient = commandRecipients.get(commandRecipientKey(nodeId, result.commandId));
    if (recipient) {
      forgetCommandRecipient(nodeId, result.commandId);
      const sub = recipient.subscription;
      if (subscriptionStillAuthorized(nodeId, sub) && sub.ws.readyState === sub.ws.OPEN) sub.ws.send(encoded);
      return;
    }
    for (const sub of [...subscribed]) {
      if (!subscriptionStillAuthorized(nodeId, sub)) continue;
      if (sub.auth.kind !== 'owner') continue;
      if (sub.ws.readyState === sub.ws.OPEN) sub.ws.send(encoded);
    }
  }

  clientWss.on('connection', (ws: WebSocket, _req: IncomingMessage, subscribedNodeId: NodeId, auth: RelayClientAuth) => {
    const url = new URL(_req.url ?? '/', 'http://127.0.0.1');
    const relayClientId = `relay-client-${randomUUID()}`;
    const terminal = parseTerminalSubscription(url);
    const subscription: RelayClientSubscription = { ws, auth, ...(terminal ? { terminal } : {}) };
    let set = subscribers.get(subscribedNodeId);
    if (!set) {
      set = new Set();
      subscribers.set(subscribedNodeId, set);
    }
    set.add(subscription);
    for (const event of replay.get(subscribedNodeId) ?? []) {
      if (!canSendEventToSubscriber(subscribedNodeId, subscription, event)) continue;
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(eventForAuth(auth, event)));
    }
    const requestedSessionId = url.searchParams.get('terminalSessionId');
    const requestedSessionEpoch = url.searchParams.get('terminalSessionEpoch');
    const requestedAfterSeq = parseSeq(url.searchParams.get('afterSeq'));
    if (requestedSessionId && requestedSessionEpoch && requestedAfterSeq !== null) {
      replayTerminalEvents(
        ws,
        subscribedNodeId,
        asSessionId(requestedSessionId),
        asSessionEpoch(requestedSessionEpoch),
        requestedAfterSeq,
      );
    }
    recordPresence(subscribedNodeId, relayClientId, auth);
    ws.on('message', (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        ws.close(1002, 'invalid json');
        return;
      }
      const command = parsed as { type?: unknown; nodeId?: unknown; payload?: unknown };
      if (command.type === 'terminal.replay.request') {
        if (!authAllowsTerminalStream(auth, invitations)) {
          ws.close(1008, 'terminal grant required');
          return;
        }
        const payload = command.payload as { sessionId?: unknown; sessionEpoch?: unknown; afterSeq?: unknown };
        const afterSeq = typeof payload?.afterSeq === 'number' && Number.isInteger(payload.afterSeq)
          ? payload.afterSeq
          : null;
        if (
          typeof payload?.sessionId === 'string'
          && typeof payload.sessionEpoch === 'string'
          && afterSeq !== null
          && afterSeq >= 0
        ) {
          replayTerminalEvents(
            ws,
            subscribedNodeId,
            asSessionId(payload.sessionId),
            asSessionEpoch(payload.sessionEpoch),
            asSeq(afterSeq),
          );
        }
        return;
      }
      if (command.type !== 'remote.command') return;
      if (typeof command.nodeId === 'string' && command.nodeId !== subscribedNodeId) {
        ws.close(1008, 'command node mismatch');
        return;
      }
      const commandId = typeof (command as { commandId?: unknown }).commandId === 'string'
        ? (command as { commandId: string }).commandId
        : `invalid-${Date.now()}`;
      const action = (command as { action?: unknown }).action;
      appendMetadataAudit({
        type: 'relay.metadata-audit',
        commandId,
        nodeId: subscribedNodeId,
        ...(typeof action === 'string' ? { action: action as RemoteCommandAction } : {}),
        outcome: 'forwarded',
        timestamp: new Date().toISOString(),
      });
      const requiredGrant = grantForRemoteCommandAction(action);
      if (!authAllows(auth, requiredGrant, invitations)) {
        const result = {
          type: 'remote.command.result',
          commandId,
          action: typeof action === 'string' ? action : 'presetReply',
          outcome: 'rejected-pre-audit',
          reason: requiredGrant ? `missing ${requiredGrant} grant` : 'unknown action',
        };
        appendMetadataAudit({
          type: 'relay.metadata-audit',
          commandId,
          nodeId: subscribedNodeId,
          ...(typeof action === 'string' ? { action: action as RemoteCommandAction } : {}),
          outcome: 'rejected-pre-audit',
          timestamp: new Date().toISOString(),
          reason: result.reason,
        });
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(result));
        return;
      }
      const target = nodeSockets.get(subscribedNodeId);
      if (target?.readyState === WebSocket.OPEN) {
        const registration = registrations.get(subscribedNodeId);
        rememberCommandRecipient(subscribedNodeId, commandId, subscription);
        target.send(JSON.stringify({
          ...command,
          nodeId: subscribedNodeId,
          actorId: auth.actorId || registration?.ownerId || ownerId,
          clientId: relayClientId,
          grantId: auth.grantId,
        }));
      } else {
        const result = {
          type: 'remote.command.result',
          commandId,
          action: typeof action === 'string' ? action : 'presetReply',
          outcome: 'node-offline',
          reason: 'node offline',
        };
        appendMetadataAudit({
          type: 'relay.metadata-audit',
          commandId,
          nodeId: subscribedNodeId,
          ...(typeof action === 'string' ? { action: action as RemoteCommandAction } : {}),
          outcome: 'node-offline',
          timestamp: new Date().toISOString(),
          reason: 'node offline',
        });
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(result));
      }
    });
    ws.on('close', () => {
      set.delete(subscription);
      if (set.size === 0) subscribers.delete(subscribedNodeId);
      for (const [key, recipient] of commandRecipients) {
        if (recipient.subscription === subscription) commandRecipients.delete(key);
      }
      removePresence(subscribedNodeId, relayClientId);
    });
  });

  return {
    httpServer: server,
    url(): string {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('relay server is not listening');
      }
      return `http://127.0.0.1:${address.port}`;
    },
    registerNode,
    createInvitation,
    acceptInvitation,
    revokeInvitation,
    invitations: () => invitations.list(),
    nodeStatuses,
    pushSubscriptions: () => pushSubscriptions.list(),
    streamMetrics: () => ({
      clientDropped: { ...streamMetrics.clientDropped },
    }),
    rotateVapidKeys(): { publicKey: string; version: number; invalidated: number } {
      const rotated = vapidKeys.rotate();
      return {
        publicKey: rotated.publicKey,
        version: rotated.version,
        invalidated: pushSubscriptions.invalidateVersion(rotated.version),
      };
    },
    sendTestPush,
    metadataAuditRows: () => [...metadataAudit],
    async close(): Promise<void> {
      closing = true;
      for (const ws of [...nodeSockets.values()]) ws.close(1001, 'relay closing');
      for (const set of subscribers.values()) {
        for (const sub of set) sub.ws.close(1001, 'relay closing');
      }
      nodeWss.close();
      clientWss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      stateStore?.close();
    },
  };

  async function sendTestPush(deviceId: string): Promise<PushDeliveryOutcome> {
    return await pushFanout.sendToDevice(deviceId, makeRedactedPushPayload({
      nodeDisplayName: 'Kookr',
      taskId: 'test-alert',
      taskLabel: 'Test push',
      alertKind: 'blocked',
      alertId: `test-${Date.now()}`,
    }));
  }
}

function relayDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kookr Relay</title>
  <link rel="stylesheet" href="/relay/assets/xterm.css">
  <style>
    body { margin: 0; font: 14px system-ui, sans-serif; background: #101416; color: #e7ecef; }
    main { max-width: 840px; margin: 0 auto; padding: 16px; }
    h1 { font-size: 20px; margin: 0 0 12px; }
    .task { border: 1px solid #2b373d; border-radius: 6px; padding: 12px; margin: 10px 0; background: #151c20; }
    .muted { color: #aeb9bf; }
    .alert { color: #ffd166; }
    .terminal { border: 1px solid #2b373d; border-radius: 6px; margin: 10px 0; background: #06080a; min-height: 220px; max-height: 420px; overflow: hidden; }
    .consent { border: 1px solid #7c5f16; border-radius: 6px; padding: 12px; margin: 10px 0; background: #211b0d; }
    .toolbar, .members, .invitations { border: 1px solid #2b373d; border-radius: 6px; padding: 12px; margin: 10px 0; background: #151c20; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 6px 0; }
    input, select { background: #0c1114; color: #e7ecef; border: 1px solid #2b373d; border-radius: 4px; padding: 7px 8px; }
    button { background: #1f6feb; color: white; border: 0; border-radius: 4px; padding: 8px 10px; }
    button.secondary { background: #2b373d; }
  </style>
</head>
<body>
<main>
  <h1>Kookr Relay</h1>
  <div id="status" class="muted">Connecting...</div>
  <section class="toolbar" id="node-switcher" hidden>
    <strong>Nodes</strong>
    <div id="nodes" class="row"></div>
  </section>
  <section class="members">
    <strong>Members</strong>
    <div id="members" class="muted" role="status" aria-live="polite">No remote members</div>
  </section>
  <section class="invitations" id="invitation-admin" hidden>
    <strong>Invitations</strong>
    <div class="row">
      <input id="invite-grants" value="view,comment,terminalInput" aria-label="Invitation grants">
      <button id="invite-create" type="button">Create invite</button>
    </div>
    <div id="invite-output" class="muted" role="status" aria-live="polite"></div>
    <div id="invitations"></div>
  </section>
  <section id="consent" class="consent" hidden>
    <strong>Terminal sharing exposes session bytes to this relay.</strong>
    <p class="muted">The relay host can observe terminal bytes for shared sessions. Continue only if you trust this relay.</p>
    <button id="consent-accept" type="button">Allow terminal viewing on this relay</button>
  </section>
  <section id="terminal-region" role="region" aria-label="Remote terminal output" hidden>
    <div id="terminal" class="terminal"></div>
  </section>
  <section id="tasks"></section>
</main>
<script src="/relay/assets/xterm.js"></script>
<script>
const params = new URLSearchParams(location.search);
const fragmentParams = new URLSearchParams(location.hash.startsWith('#') ? location.hash.slice(1) : '');
if (location.hash) history.replaceState(null, '', location.pathname + location.search);
let nodeId = params.get('nodeId') || '';
const clientToken = params.get('clientToken') || '';
const inviteToken = fragmentParams.get('inviteToken') || '';
const terminalSessionId = params.get('terminalSessionId') || '';
const terminalSessionEpoch = params.get('terminalSessionEpoch') || '';
const afterSeq = params.get('afterSeq') || '';
const terminalRequested = terminalSessionId.length > 0 && terminalSessionEpoch.length > 0;
const statusEl = document.getElementById('status');
const tasksEl = document.getElementById('tasks');
const nodesEl = document.getElementById('nodes');
const nodeSwitcherEl = document.getElementById('node-switcher');
const membersEl = document.getElementById('members');
const invitationAdminEl = document.getElementById('invitation-admin');
const invitationsEl = document.getElementById('invitations');
const inviteGrantsEl = document.getElementById('invite-grants');
const inviteCreateEl = document.getElementById('invite-create');
const inviteOutputEl = document.getElementById('invite-output');
const terminalEl = document.getElementById('terminal');
const terminalRegionEl = document.getElementById('terminal-region');
const consentEl = document.getElementById('consent');
const consentAccept = document.getElementById('consent-accept');
const tasks = new Map();
const alerts = new Map();
let members = [];
const pendingTerminalEvents = [];
let terminal = null;
let relayHostFingerprint = location.origin;
let terminalConsent = false;
function consentKey() { return 'kookr-relay-terminal-consent:' + nodeId + ':' + relayHostFingerprint; }
function refreshConsent() {
  if (!terminalRequested) {
    consentEl.hidden = true;
    terminalRegionEl.hidden = true;
    return;
  }
  terminalConsent = localStorage.getItem(consentKey()) === 'accepted';
  consentEl.hidden = terminalConsent;
  terminalRegionEl.hidden = !terminalConsent;
  if (terminalConsent && !terminal) {
    terminal = new Terminal({
      cursorBlink: false,
      disableStdin: true,
      screenReaderMode: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      scrollback: 10000,
      theme: {
        background: '#06080a',
        foreground: '#d8dee9',
        cursor: '#d8dee9',
      },
    });
    terminal.open(terminalEl);
    terminal.textarea?.setAttribute('aria-label', 'Remote terminal output');
  }
}
consentAccept.onclick = () => {
  localStorage.setItem(consentKey(), 'accepted');
  refreshConsent();
  for (const event of pendingTerminalEvents.splice(0)) ingestTerminal(event);
};
function render() {
  tasksEl.textContent = '';
  for (const task of tasks.values()) {
    const el = document.createElement('article');
    el.className = 'task';
    const title = task.taskShortLabel || task.taskId || 'Task';
    el.innerHTML = '<strong></strong><div class="muted"></div>';
    el.querySelector('strong').textContent = title;
    el.querySelector('.muted').textContent = [task.status || 'unknown', task.updatedAt || ''].filter(Boolean).join(' · ');
    tasksEl.appendChild(el);
  }
  for (const alert of alerts.values()) {
    const el = document.createElement('article');
    el.className = 'task alert';
    el.textContent = (alert.alertKind || 'alert') + ' · ' + (alert.taskShortLabel || alert.agentId || alert.alertId || 'Task');
    tasksEl.appendChild(el);
  }
}
function renderMembers() {
  if (!members.length) {
    membersEl.textContent = 'No remote members';
    return;
  }
  membersEl.textContent = '';
  for (const member of members) {
    const row = document.createElement('div');
    row.className = 'row';
    row.textContent = (member.actorId || member.clientId || 'member') + ' · ' + (member.grants || []).join(', ');
    membersEl.appendChild(row);
  }
}
function writeTerminalPayload(payload) {
  if (!terminalConsent) {
    consentEl.hidden = false;
    return;
  }
  refreshConsent();
  terminal?.write(payload);
}
function ingestTerminal(event) {
  if (!event || typeof event !== 'object') return;
  if (!terminalConsent) {
    pendingTerminalEvents.push(event);
    consentEl.hidden = false;
    return;
  }
  if (event.kind === 'terminal.bytes' && event.payload && event.payload.encoding === 'base64') {
    const raw = atob(event.payload.data || '');
    const bytes = Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
    writeTerminalPayload(bytes);
  } else if (event.kind === 'terminal.replay-gap' && event.payload) {
    writeTerminalPayload('\\r\\n\\x1b[33m[stream gap: missing seq ' + event.payload.fromSeq + '-' + event.payload.toSeq + ']\\x1b[0m\\r\\n');
  }
}
function ingest(event) {
  if (event && event.type === 'relay.presence') {
    members = Array.isArray(event.members) ? event.members : [];
    renderMembers();
    return;
  }
  if (event && typeof event === 'object' && String(event.kind || '').startsWith('terminal.')) {
    ingestTerminal(event);
    return;
  }
  const payload = event && event.payload;
  if (!payload || typeof payload !== 'object') return;
  if (payload.type === 'push.alert' && payload.payload) {
    alerts.set(payload.payload.alertId || String(alerts.size), payload.payload);
  }
  if (payload.type === 'remote.taskProjection.v1' && payload.projection && typeof payload.projection.taskId === 'string') {
    tasks.set(payload.projection.taskId, {
      ...payload.projection,
      taskShortLabel: payload.projection.taskLabel || payload.projection.taskId,
    });
  }
  const items = Array.isArray(payload.tasks) ? payload.tasks : Array.isArray(payload.taskProjections) ? payload.taskProjections : [];
  for (const task of items) {
    if (task && typeof task.taskId === 'string') tasks.set(task.taskId, task);
  }
  render();
}
async function acceptInviteIfPresent() {
  if (!inviteToken) return;
  const res = await fetch('/relay/invitations/accept', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: inviteToken, displayName: 'relay browser' }),
  });
  if (!res.ok) {
    statusEl.textContent = 'Invitation failed';
    return;
  }
  const body = await res.json();
  if (!nodeId && typeof body.nodeId === 'string') nodeId = body.nodeId;
}
async function loadNodes() {
  try {
    const url = new URL('/relay/admin/nodes', location.href);
    if (clientToken) url.searchParams.set('clientToken', clientToken);
    const res = await fetch(url);
    if (!res.ok) return;
    const body = await res.json();
    const nodes = Array.isArray(body.nodes) ? body.nodes : [];
    nodeSwitcherEl.hidden = nodes.length === 0;
    nodesEl.textContent = '';
    for (const node of nodes) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = node.nodeId === nodeId ? '' : 'secondary';
      button.textContent = (node.displayName || node.nodeId) + (node.connected ? ' live' : ' offline');
      if (node.nodeId === nodeId) button.setAttribute('aria-current', 'true');
      button.onclick = () => {
        const next = new URL(location.href);
        next.searchParams.set('nodeId', node.nodeId);
        location.href = next.toString();
      };
      nodesEl.appendChild(button);
    }
  } catch {
    // Optional owner-only node switcher; invitation clients can still connect directly.
  }
}
async function loadInvitations() {
  try {
    const res = await fetch('/relay/admin/invitations');
    if (!res.ok) return;
    invitationAdminEl.hidden = false;
    const body = await res.json();
    invitationsEl.textContent = '';
    for (const invitation of body.invitations || []) {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('span');
      label.textContent = invitation.invitationId + ' · ' + invitation.grants.join(', ') + (invitation.revokedAt ? ' · revoked' : '');
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'secondary';
      revoke.textContent = 'Revoke';
      revoke.setAttribute('aria-label', 'Revoke invitation ' + invitation.invitationId);
      revoke.disabled = Boolean(invitation.revokedAt);
      revoke.onclick = async () => {
        await fetch('/relay/admin/invitations/' + encodeURIComponent(invitation.invitationId) + '/revoke', { method: 'POST' });
        await loadInvitations();
      };
      row.append(label, revoke);
      invitationsEl.appendChild(row);
    }
  } catch {
    // Optional owner-only invitation panel; members should not see admin fetch failures.
  }
}
inviteCreateEl.onclick = async () => {
  if (!nodeId) return;
  const grants = inviteGrantsEl.value.split(',').map((item) => item.trim()).filter(Boolean);
  const res = await fetch('/relay/admin/invitations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nodeId, grants }),
  });
  if (!res.ok) return;
  const body = await res.json();
  inviteOutputEl.textContent = location.origin + '/relay/join#inviteToken=' + encodeURIComponent(body.token);
  await loadInvitations();
};
async function boot() {
  await acceptInviteIfPresent();
  await loadNodes();
  await loadInvitations();
  if (!nodeId) {
    statusEl.textContent = 'Missing nodeId';
    return;
  }
  try {
    const stateUrl = new URL('/relay/dashboard/state', location.href);
    stateUrl.searchParams.set('nodeId', nodeId);
    if (clientToken) stateUrl.searchParams.set('clientToken', clientToken);
    if (terminalSessionId) stateUrl.searchParams.set('terminalSessionId', terminalSessionId);
    if (terminalSessionEpoch) stateUrl.searchParams.set('terminalSessionEpoch', terminalSessionEpoch);
    const state = await fetch(stateUrl, { credentials: 'include' });
    if (state.ok) {
      const body = await state.json();
      relayHostFingerprint = body.relayHostFingerprint || relayHostFingerprint;
      refreshConsent();
      for (const event of body.events || []) ingest(event);
      for (const event of body.terminalEvents || []) ingest(event);
      members = Array.isArray(body.members) ? body.members : members;
      renderMembers();
    }
  } catch { refreshConsent(); }
  const wsUrl = new URL('/relay/client', location.href);
  wsUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  wsUrl.searchParams.set('nodeId', nodeId);
  if (clientToken) wsUrl.searchParams.set('clientToken', clientToken);
  if (terminalSessionId) wsUrl.searchParams.set('terminalSessionId', terminalSessionId);
  if (terminalSessionEpoch) wsUrl.searchParams.set('terminalSessionEpoch', terminalSessionEpoch);
  if (afterSeq) wsUrl.searchParams.set('afterSeq', afterSeq);
  const ws = new WebSocket(wsUrl);
  ws.onopen = () => { statusEl.textContent = 'Live'; };
  ws.onclose = () => { statusEl.textContent = 'Disconnected'; };
  ws.onmessage = (msg) => { try { ingest(JSON.parse(msg.data)); } catch {} };
}
boot();
</script>
</body>
</html>`;
}

function relayJoinHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kookr shared task</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #0d1117; color: #e7ecef; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0d1117; }
    main { width: min(720px, calc(100vw - 32px)); }
    h1 { font-size: 24px; margin: 0 0 8px; }
    .panel { border: 1px solid #2b373d; border-radius: 8px; background: #151c20; padding: 18px; }
    .muted { color: #aeb9bf; }
    .status { margin: 12px 0; min-height: 20px; color: #aeb9bf; }
    label { display: grid; gap: 6px; margin: 14px 0; }
    input { background: #0c1114; color: #e7ecef; border: 1px solid #2b373d; border-radius: 4px; padding: 9px 10px; }
    button { background: #1f6feb; color: white; border: 0; border-radius: 4px; padding: 9px 12px; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .task { border: 1px solid #2b373d; border-radius: 6px; padding: 14px; margin-top: 14px; background: #0f1519; }
    .task strong { display: block; font-size: 18px; margin-bottom: 8px; }
    .task dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 12px; margin: 0; }
    .task dt { color: #aeb9bf; }
    .task dd { margin: 0; }
    .offline { border: 1px solid #4b5563; border-radius: 6px; padding: 14px; margin-top: 14px; background: #111827; }
    .error { color: #ff7b72; }
    .request { border: 1px solid #7c5f16; border-radius: 6px; padding: 12px; margin-top: 14px; background: #211b0d; }
  </style>
</head>
<body>
<main>
  <section class="panel">
    <h1>Shared Kookr task</h1>
    <p class="muted">View-only access as an unverified guest.</p>
    <form id="join-form">
      <div id="ticket-fields">
        <label>
          Share ID
          <input id="share-id" maxlength="12" autocomplete="one-time-code" inputmode="numeric">
        </label>
        <label>
          Password
          <input id="share-password" type="password" autocomplete="one-time-code">
        </label>
      </div>
      <label>
        Display name
        <input id="display-name" maxlength="40" autocomplete="name" value="Guest">
      </label>
      <button id="join-button" type="submit">Join</button>
    </form>
    <div id="status" class="status" role="status" aria-live="polite">Ready to join</div>
    <section id="task" class="task" hidden aria-label="Shared task projection">
      <strong id="task-label"></strong>
      <dl>
        <dt>Status</dt><dd id="task-status"></dd>
        <dt>Finding</dt><dd id="task-finding"></dd>
        <dt>Needs input</dt><dd id="task-needs-input"></dd>
        <dt>Updated</dt><dd id="task-updated"></dd>
      </dl>
    </section>
    <section id="offline-node" class="offline" hidden aria-label="Shared machine offline">
      <strong>The shared task's machine is currently offline.</strong>
      <p id="offline-last-seen" class="muted"></p>
    </section>
    <section id="grant-request" class="request" hidden aria-label="Collaborator grant request">
      <p class="muted">Ask the owner before any remote control is enabled.</p>
      <button id="request-control" type="button">Request terminal input</button>
    </section>
  </section>
</main>
<script>
const fragmentParams = new URLSearchParams(location.hash.startsWith('#') ? location.hash.slice(1) : '');
const inviteToken = fragmentParams.get('inviteToken') || '';
const pathShareId = location.pathname.startsWith('/relay/join/')
  ? decodeURIComponent(location.pathname.slice('/relay/join/'.length))
  : '';
let fragmentPassword = fragmentParams.get('password') || '';
// Also accept /relay/join/482-913#cobalt-mint-7 for voice/manual entry
// links while still scrubbing the fragment before any network work starts.
if (!fragmentPassword && location.hash && !location.hash.includes('=')) {
  try {
    fragmentPassword = decodeURIComponent(location.hash.slice(1));
  } catch {
    fragmentPassword = '';
  }
}
if (location.hash) history.replaceState(null, '', location.pathname + location.search);

const statusEl = document.getElementById('status');
const formEl = document.getElementById('join-form');
const ticketFieldsEl = document.getElementById('ticket-fields');
const shareIdEl = document.getElementById('share-id');
const sharePasswordEl = document.getElementById('share-password');
const nameEl = document.getElementById('display-name');
const joinButtonEl = document.getElementById('join-button');
const taskEl = document.getElementById('task');
const taskLabelEl = document.getElementById('task-label');
const taskStatusEl = document.getElementById('task-status');
const taskFindingEl = document.getElementById('task-finding');
const taskNeedsInputEl = document.getElementById('task-needs-input');
const taskUpdatedEl = document.getElementById('task-updated');
const grantRequestEl = document.getElementById('grant-request');
const requestControlEl = document.getElementById('request-control');
const offlineNodeEl = document.getElementById('offline-node');
const offlineLastSeenEl = document.getElementById('offline-last-seen');
const nodeKey = 'kookr-relay-join-node:' + location.host;
let nodeId = sessionStorage.getItem(nodeKey) || '';
let ws = null;
shareIdEl.value = pathShareId;
sharePasswordEl.value = fragmentPassword;
if (inviteToken) ticketFieldsEl.hidden = true;

function sanitizeDisplayName(value) {
  return String(value || 'Guest')
    .replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069]/g, '')
    .trim()
    .slice(0, 40) || 'Guest';
}

function normalizeShareId(value) {
  const digits = String(value || '').replace(/\\D/g, '');
  if (digits.length !== 6) return '';
  return digits.slice(0, 3) + '-' + digits.slice(3);
}

function setStatus(text, error) {
  statusEl.textContent = text;
  statusEl.className = error ? 'status error' : 'status';
}

function renderProjection(projection) {
  if (!projection || projection.schemaVersion !== 'remote-task-projection.v1') return;
  offlineNodeEl.hidden = true;
  taskLabelEl.textContent = projection.taskLabel || projection.taskId || 'Task';
  taskStatusEl.textContent = projection.status || 'unknown';
  taskFindingEl.textContent = projection.hasFinding ? 'yes' : 'no';
  taskNeedsInputEl.textContent = projection.needsInput ? 'yes' : 'no';
  taskUpdatedEl.textContent = projection.updatedAt || '';
  taskEl.hidden = false;
  grantRequestEl.hidden = false;
}

function formatLastSeen(value) {
  if (!value) return 'Last seen unknown.';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Last seen unknown.';
  return 'Last seen ' + date.toLocaleString() + '.';
}

function renderOfflineNode(node) {
  taskEl.hidden = true;
  grantRequestEl.hidden = true;
  offlineLastSeenEl.textContent = formatLastSeen(node && node.lastSeen);
  offlineNodeEl.hidden = false;
  setStatus('Machine offline. The link is still valid, but the task is not viewable right now.');
}

function ingest(event) {
  const payload = event && event.payload;
  if (payload && payload.type === 'remote.taskProjection.v1') {
    renderProjection(payload.projection);
    setStatus('Live view-only task projection');
  }
}

async function loadState() {
  if (!nodeId) return false;
  const stateUrl = new URL('/relay/dashboard/state', location.href);
  stateUrl.searchParams.set('nodeId', nodeId);
  const state = await fetch(stateUrl, { credentials: 'include' });
  if (!state.ok) return false;
  const body = await state.json();
  if (body.node && body.node.connected === false) {
    renderOfflineNode(body.node);
    return false;
  }
  for (const event of body.events || []) ingest(event);
  return true;
}

function connect() {
  if (!nodeId) return;
  if (ws) ws.close();
  const wsUrl = new URL('/relay/client', location.href);
  wsUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  wsUrl.searchParams.set('nodeId', nodeId);
  ws = new WebSocket(wsUrl);
  ws.onopen = () => setStatus('Connected. Waiting for task projection...');
  ws.onclose = () => {
    if (!taskEl.hidden) setStatus('Disconnected. Access may have been revoked or expired.', true);
  };
  ws.onmessage = (msg) => { try { ingest(JSON.parse(msg.data)); } catch {} };
}

async function acceptInvite() {
  const shareId = normalizeShareId(shareIdEl.value);
  const password = sharePasswordEl.value;
  if (!inviteToken && (!shareId || !password)) {
    if (nodeId) {
      if (await loadState()) connect();
      return;
    }
    setStatus('Enter the share ID and password.', true);
    return;
  }
  joinButtonEl.disabled = true;
  setStatus('Joining...');
  const res = await fetch(inviteToken ? '/relay/invitations/accept' : '/relay/share-tickets/accept', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(inviteToken
      ? { token: inviteToken, displayName: sanitizeDisplayName(nameEl.value) }
      : { shareId, password, displayName: sanitizeDisplayName(nameEl.value) }),
  });
  if (!res.ok) {
    setStatus('Share failed or expired.', true);
    joinButtonEl.disabled = false;
    return;
  }
  const body = await res.json();
  nodeId = typeof body.nodeId === 'string' ? body.nodeId : '';
  if (nodeId) sessionStorage.setItem(nodeKey, nodeId);
  if (await loadState()) connect();
  formEl.hidden = true;
}

requestControlEl.addEventListener('click', async () => {
  if (!nodeId) return;
  requestControlEl.disabled = true;
  setStatus('Requesting owner approval...');
  const res = await fetch('/relay/member/grant-requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      nodeId,
      grants: ['terminalInput'],
      comment: sanitizeDisplayName(nameEl.value) + ' requested terminal input',
    }),
  });
  if (!res.ok) {
    setStatus('Control request failed or expired.', true);
    requestControlEl.disabled = false;
    return;
  }
  setStatus('Waiting for owner approval.');
});

formEl.addEventListener('submit', (event) => {
  event.preventDefault();
  void acceptInvite();
});

if (!inviteToken && nodeId) {
  formEl.hidden = true;
  void acceptInvite();
}
</script>
</body>
</html>`;
}

if (process.argv[1]?.endsWith('/relay/server.ts') || process.argv[1]?.endsWith('/relay/server.js')) {
  const port = Number.parseInt(process.env.PORT ?? '8080', 10);
  const adminToken = process.env.KOOKR_RELAY_ADMIN_TOKEN;
  const clientToken = process.env.KOOKR_RELAY_CLIENT_TOKEN;
  const allowInsecureAdmin = process.env.KOOKR_RELAY_INSECURE_DEV === '1';
  const bindHost = process.env.KOOKR_RELAY_BIND_HOST ?? '0.0.0.0';
  const stateDbPath = process.env.KOOKR_RELAY_STATE_DB_PATH ?? 'relay-state.sqlite';
  if (!adminToken && !allowInsecureAdmin) {
    console.error('[relay] KOOKR_RELAY_ADMIN_TOKEN is required. Set KOOKR_RELAY_INSECURE_DEV=1 only for local development.');
    process.exit(1);
  }
  try {
    const relay = createRelayServer({
      adminToken,
      clientToken,
      allowInsecureAdmin,
      allowInsecureClients: allowInsecureAdmin,
      bindHost,
      stateDbPath,
    });
    relay.httpServer.listen(port, bindHost, () => {
      console.log(`[relay] listening on http://${bindHost}:${port}`);
    });
  } catch (err) {
    console.error('[relay] failed to start:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

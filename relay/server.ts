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
import { asGrantId, asNodeId, asPolicyVersion, asSeq, asSessionEpoch, asSessionId, type GrantId, type NodeEpoch, type NodeId, type PolicyVersion, type Seq, type SessionEpoch, type SessionId } from '../src/remote/ids.js';
import type { KnownGrant, PolicyGrantRecord, PolicyRevokeMessage, ShareGrant, ShareSubject } from '../src/remote/policy-sync.js';
import { grantForRemoteCommandAction, isKnownGrant } from '../src/remote/grants.js';
import { payloadHash } from '../src/remote/retry-token.js';
import { isTerminalStreamEvent, type TerminalReplayGapEvent, type TerminalStreamEvent } from '../src/remote/stream-events.js';
import { isPushAlertDeltaPayload, makeRedactedPushPayload } from '../src/remote/push.js';
import type { RelayNodeCredentialStatusResponse } from '../src/shared/contracts/relay-connection.js';
import type { MemberShareStateResponse } from '../src/shared/contracts/session-sharing-public.js';
import type {
  RemoteTaskProjectionEnvelopeV1,
  RemoteTaskProjectionV1,
  RelayNodeInvitationView,
  RelayShareTicketSecret,
  ShareSessionProjectionEnvelopeV1,
  ShareSessionProjectionV1,
  TaskShareGrant,
  TaskShareMutableGrant,
} from '../src/remote/share-contract.js';
import { InvitationStore, type InvitationRecord } from './src/invitations/store.js';
import { buildMemberShareState, type MemberNodeState } from './src/member-state.js';
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
    projectionId?: string;
    sessionAlias?: 'primary';
  };
  terminalTransportAllowed?: boolean;
}

interface RelayClientAuth {
  kind: 'owner' | 'member';
  actorId: string;
  grants: ShareGrant[];
  grantId: GrantId;
  deviceId?: string;
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

interface MemberWebSocketNonce {
  invitationId: string;
  deviceId: string;
  expiresAt: number;
}

interface MemberRetryTokenBinding {
  invitationId: string;
  deviceId: string;
  leaseId: string;
  projectionVersion: number;
  policyVersion: PolicyVersion;
  payloadHash: string;
  expiresAt: number;
}

export interface RelayNodeStatus {
  nodeId: NodeId;
  ownerId: string;
  displayName: string;
  connected: boolean;
  lastSeen?: string;
  protocolVersion?: number;
  policySyncVersion: number;
  policySyncStatus: PolicySyncState;
  pendingPolicyGrantIds?: GrantId[];
  lastPolicySyncError?: string;
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
  policyAckTimeoutMs?: number;
}

type PolicySyncState = 'notSent' | 'sentAwaitingAck' | 'acked' | 'stale' | 'timedOut' | 'failed';

interface NodePolicySyncState {
  status: PolicySyncState;
  relayPolicyVersion: PolicyVersion;
  lastPolicySentAt?: string;
  nodeAckedPolicyVersion?: PolicyVersion;
  lastPolicyAckAt?: string;
  pendingGrantIds: GrantId[];
  lastSyncError?: string;
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

function terminalTransportAllowed(req: IncomingMessage, opts: { trustedProxy: boolean }): boolean {
  return requestIsSecure(req, opts) || isLoopbackAddress(clientAddress(req, opts));
}

function requestOrigin(req: IncomingMessage, opts: { trustedProxy: boolean }): string {
  const proto = requestIsSecure(req, opts) ? 'https' : 'http';
  return `${proto}://${req.headers.host ?? '127.0.0.1'}`;
}

function originHeaderAllowed(req: IncomingMessage, opts: { trustedProxy: boolean }): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) return false;
  try {
    return new URL(origin).origin === requestOrigin(req, opts);
  } catch {
    return false;
  }
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
const RELAY_MEMBER_CSRF_COOKIE = 'kookr_relay_csrf_token';
const RELAY_MEMBER_DEVICE_COOKIE = 'kookr_relay_device_id';
const MEMBER_WS_NONCE_TTL_MS = 60_000;
const MEMBER_RETRY_TOKEN_TTL_MS = 30_000;

function sendJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string | string[]> = {}): void {
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

function cookieAttributes(req: IncomingMessage, opts: { trustedProxy: boolean }, expiresAt?: string): string[] {
  const secure = requestIsSecure(req, opts);
  const maxAge = expiresAt ? Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000)) : null;
  return [
    'Path=/relay',
    'SameSite=Lax',
    Number.isFinite(maxAge) && maxAge !== null ? `Max-Age=${maxAge}` : '',
    secure ? 'Secure' : '',
  ].filter(Boolean);
}

function memberCookies(input: { memberToken: string; csrfToken: string; deviceId: string; expiresAt?: string }, req: IncomingMessage, opts: { trustedProxy: boolean }): string[] {
  const attrs = cookieAttributes(req, opts, input.expiresAt);
  return [
    [`${RELAY_MEMBER_COOKIE}=${encodeURIComponent(input.memberToken)}`, ...attrs, 'HttpOnly'].join('; '),
    [`${RELAY_MEMBER_CSRF_COOKIE}=${encodeURIComponent(input.csrfToken)}`, ...attrs].join('; '),
    [`${RELAY_MEMBER_DEVICE_COOKIE}=${encodeURIComponent(input.deviceId)}`, ...attrs].join('; '),
  ];
}

function memberBrowserCookies(input: { csrfToken: string; deviceId: string; expiresAt?: string }, req: IncomingMessage, opts: { trustedProxy: boolean }): string[] {
  const attrs = cookieAttributes(req, opts, input.expiresAt);
  return [
    [`${RELAY_MEMBER_CSRF_COOKIE}=${encodeURIComponent(input.csrfToken)}`, ...attrs].join('; '),
    [`${RELAY_MEMBER_DEVICE_COOKIE}=${encodeURIComponent(input.deviceId)}`, ...attrs].join('; '),
  ];
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
      const deviceId = invitation.memberDeviceId ?? cookieValue(req, RELAY_MEMBER_DEVICE_COOKIE) ?? undefined;
      return {
        kind: 'member',
        actorId: invitation.acceptedBy ?? invitation.memberId ?? invitation.invitationId,
        grants: [...invitation.grants],
        grantId: invitation.grantId,
        ...(deviceId ? { deviceId } : {}),
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
  const projectionId = url.searchParams.get('projectionId');
  const sessionAlias = url.searchParams.get('sessionAlias');
  if (projectionId || sessionAlias) {
    if (!projectionId || sessionAlias !== 'primary') return undefined;
    return {
      projectionId,
      sessionAlias,
      sessionId: asSessionId(''),
      sessionEpoch: asSessionEpoch(''),
    };
  }
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
const TASK_SHARE_GRANTS: readonly TaskShareGrant[] = ['view', 'terminalView', 'terminalInput', 'launch', 'stop', 'permissionApprove'];
const MUTABLE_TASK_SHARE_GRANTS: readonly TaskShareMutableGrant[] = ['terminalView', 'terminalInput', 'launch', 'stop', 'permissionApprove'];

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
 * `memberTokenHash`, `grantId`) are intentionally dropped. `policyVersion`
 * stays visible so the node can publish share-session projections against the
 * same policy version that terminal-input authorization waits to be acked.
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
    policyVersion: invitation.policyVersion,
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
  const normalized = [...new Set(grants.includes('terminalInput') && !grants.includes('terminalView')
    ? ['terminalView', ...grants]
    : grants)];
  const requestedGrants = normalized.filter(isMutableTaskShareGrant);
  if (requestedGrants.length !== normalized.length || requestedGrants.length === 0) {
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

function grantRequestStatus(reason: string): 400 | 404 | 409 | 429 {
  switch (reason) {
    case 'not-found':
      return 404;
    case 'empty-grants':
      return 400;
    case 'denied-cooldown':
      return 429;
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

function isShareSessionProjection(value: unknown): value is ShareSessionProjectionV1 {
  const projection = value as Partial<ShareSessionProjectionV1>;
  const primary = projection.primarySharedSession as Partial<NonNullable<ShareSessionProjectionV1['primarySharedSession']>> | undefined;
  return typeof value === 'object'
    && value !== null
    && projection.schemaVersion === 'share-session-projection.v1'
    && typeof projection.nodeId === 'string'
    && typeof projection.nodeInstanceId === 'string'
    && typeof projection.projectionId === 'string'
    && typeof projection.projectionVersion === 'number'
    && typeof projection.policyVersion === 'number'
    && typeof projection.generatedAt === 'string'
    && (projection.expiresAt === undefined || typeof projection.expiresAt === 'string')
    && (
      projection.primarySharedSession === undefined
      || (
        typeof primary === 'object'
        && primary !== null
        && primary.sessionAlias === 'primary'
        && typeof primary.sessionId === 'string'
        && (primary.sessionEpoch === undefined || typeof primary.sessionEpoch === 'string')
        && (primary.title === undefined || typeof primary.title === 'string')
        && (primary.lastActivityAt === undefined || typeof primary.lastActivityAt === 'string')
        && (primary.replayCursor === undefined || typeof primary.replayCursor === 'string')
      )
    );
}

function shareSessionProjectionEnvelopeFromEvent(event: RemoteControlEvent): ShareSessionProjectionEnvelopeV1 | null {
  const payload = event.payload as Partial<ShareSessionProjectionEnvelopeV1>;
  if (
    typeof payload === 'object'
    && payload !== null
    && payload.type === 'remote.shareSessionProjection.v1'
    && typeof payload.invitationId === 'string'
    && isShareSessionProjection(payload.projection)
  ) {
    return payload as ShareSessionProjectionEnvelopeV1;
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
  if (grant === 'terminalInput') return grants.includes('terminalInput');
  if (grant === 'terminalView') return grants.includes('terminalView') || grants.includes('terminalInput');
  return grants.some((candidate) => candidate === grant && isKnownGrant(candidate));
}

function authAllowsTerminalStream(auth: RelayClientAuth, invitationStore?: InvitationStore): boolean {
  return authAllows(auth, 'terminalView', invitationStore);
}

function grantsAllowTerminalView(grants: readonly ShareGrant[]): boolean {
  return grants.includes('terminalView') || grants.includes('terminalInput');
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
  const nodePolicySync = new Map<NodeId, NodePolicySyncState>();
  const subscribers = new Map<NodeId, Set<RelayClientSubscription>>();
  const commandRecipients = new Map<string, PendingCommandRecipient>();
  const presence = new Map<NodeId, Map<string, PresenceMember>>();
  const replay = new Map<NodeId, RemoteControlEvent[]>();
  const terminalReplay = new Map<NodeId, Map<string, TerminalStreamEvent[]>>();
  const shareSessionProjections = new Map<string, ShareSessionProjectionEnvelopeV1>();
  const memberWebSocketNonces = new Map<string, MemberWebSocketNonce>();
  const memberRetryTokens = new Map<string, MemberRetryTokenBinding>();
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
  const policyAckTimeoutMs = opts.policyAckTimeoutMs ?? 5_000;
  const vapidKeys: VapidKeyStore = createVapidKeyStore();
  const pushSubscriptions: PushSubscriptionStore = createPushSubscriptionStore();
  const pushFanout: PushFanout = createPushFanout({
    subscriptions: pushSubscriptions,
    vapidKeys,
    disabled: opts.pushDisabled ?? process.env.KOOKR_PUSH_DISABLED === 'true',
    sender: opts.pushSender,
    subject: opts.pushSubject,
  });
  const approvalNotificationDevices = new Map<string, Set<string>>();
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

  const acceptInvitation = (token: string, acceptedBy?: string, deviceId?: string) => {
    const accepted = invitations.accept(token, acceptedBy, deviceId);
    if (accepted.ok) {
      relayMetrics.ticketsAccepted += 1;
      sendPolicyDelta(accepted.accepted.invitation.nodeId, accepted.accepted.policyGrant);
    } else {
      countReason(relayMetrics, accepted.reason);
    }
    return accepted;
  };

  const acceptShareTicket = (shareId: string, password: string, acceptedBy?: string, deviceId?: string) => {
    const accepted = invitations.acceptTicket(shareId, password, acceptedBy, deviceId);
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

  const currentNodePolicyState = (nodeId: NodeId): NodePolicySyncState => {
    const existing = nodePolicySync.get(nodeId);
    if (!existing) {
      return {
        status: 'notSent',
        relayPolicyVersion: asPolicyVersion(0),
        pendingGrantIds: [],
      };
    }
    if (
      existing.status === 'sentAwaitingAck'
      && existing.lastPolicySentAt
      && Date.now() - Date.parse(existing.lastPolicySentAt) > policyAckTimeoutMs
    ) {
      return { ...existing, status: 'timedOut' };
    }
    if (
      existing.nodeAckedPolicyVersion !== undefined
      && existing.nodeAckedPolicyVersion < existing.relayPolicyVersion
      && existing.status === 'acked'
    ) {
      return { ...existing, status: 'stale' };
    }
    return existing;
  };

  const setPolicySent = (nodeId: NodeId, policyVersion: PolicyVersion, pendingGrantIds: GrantId[]): void => {
    const previous = currentNodePolicyState(nodeId);
    nodePolicySync.set(nodeId, {
      status: 'sentAwaitingAck',
      relayPolicyVersion: policyVersion,
      lastPolicySentAt: new Date().toISOString(),
      ...(previous.nodeAckedPolicyVersion !== undefined ? { nodeAckedPolicyVersion: previous.nodeAckedPolicyVersion } : {}),
      ...(previous.lastPolicyAckAt ? { lastPolicyAckAt: previous.lastPolicyAckAt } : {}),
      pendingGrantIds,
    });
  };

  const setPolicyFailed = (nodeId: NodeId, policyVersion: PolicyVersion, pendingGrantIds: GrantId[], error: string): void => {
    const previous = currentNodePolicyState(nodeId);
    nodePolicySync.set(nodeId, {
      status: 'failed',
      relayPolicyVersion: policyVersion,
      lastPolicySentAt: previous.lastPolicySentAt,
      ...(previous.nodeAckedPolicyVersion !== undefined ? { nodeAckedPolicyVersion: previous.nodeAckedPolicyVersion } : {}),
      ...(previous.lastPolicyAckAt ? { lastPolicyAckAt: previous.lastPolicyAckAt } : {}),
      pendingGrantIds,
      lastSyncError: error,
    });
  };

  const policyAckedForInput = (nodeId: NodeId, policyVersion: PolicyVersion): boolean => {
    const state = currentNodePolicyState(nodeId);
    return state.status === 'acked'
      && state.nodeAckedPolicyVersion !== undefined
      && state.nodeAckedPolicyVersion >= policyVersion
      && state.relayPolicyVersion <= state.nodeAckedPolicyVersion;
  };

  const sendPolicyDelta = (nodeId: NodeId, grant: PolicyGrantRecord): void => {
    const ws = nodeSockets.get(nodeId);
    if (!ws || ws.readyState !== ws.OPEN) return;
    try {
      setPolicySent(nodeId, grant.policyVersion, [grant.grantId]);
      ws.send(JSON.stringify({
        type: 'policy.delta',
        nodeId,
        policyVersion: grant.policyVersion,
        upserts: [grant],
        revokes: [],
      }));
      broadcastMemberShareState(nodeId);
    } catch (err) {
      setPolicyFailed(nodeId, grant.policyVersion, [grant.grantId], err instanceof Error ? err.message : String(err));
      relayMetrics.policySyncFailures += 1;
      broadcastMemberShareState(nodeId);
    }
  };

  const sendPolicySync = (nodeId: NodeId, ws: WebSocket): void => {
    if (ws.readyState !== ws.OPEN) return;
    const grants = invitations.activePolicyGrantsForNode(nodeId);
    const revokedGrantIds = invitations.revokedGrantIdsForNode(nodeId);
    setPolicySent(nodeId, invitations.currentPolicyVersion(), [
      ...grants.map((grant) => grant.grantId),
      ...revokedGrantIds,
    ]);
    ws.send(JSON.stringify({
      type: 'policy.sync',
      nodeId,
      policyVersion: invitations.currentPolicyVersion(),
      grants,
      revokedGrantIds,
    }));
    broadcastMemberShareState(nodeId);
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
      setPolicySent(invitation.nodeId, invitation.policyVersion, [invitation.grantId]);
      ws.send(JSON.stringify(msg));
      broadcastMemberShareState(invitation.nodeId);
    } catch (err) {
      setPolicyFailed(invitation.nodeId, invitation.policyVersion, [invitation.grantId], err instanceof Error ? err.message : String(err));
      relayMetrics.policySyncFailures += 1;
      broadcastMemberShareState(invitation.nodeId);
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

  const memberNodeState = (nodeId: NodeId): MemberNodeState | null => {
    const registration = registrations.get(nodeId);
    if (!registration) return null;
    const policy = nodePolicySync.get(nodeId);
    return {
      displayName: registration.displayName,
      connected: nodeSockets.has(nodeId),
      ...(registration.lastSeen ? { lastSeen: registration.lastSeen } : {}),
      ...(nodeHello.get(nodeId) ? { hello: nodeHello.get(nodeId)! } : {}),
      policySyncStatus: currentNodePolicyState(nodeId).status,
      ...(policy?.lastPolicyAckAt ? { lastPolicyAckAt: policy.lastPolicyAckAt } : {}),
    };
  };

  const memberShareStateForToken = (memberToken: string, deviceId?: string): MemberShareStateResponse | null => {
    const invitation = invitations.findByMemberToken(memberToken);
    if (!invitation) return null;
    const node = memberNodeState(invitation.nodeId);
    if (!node) return null;
    return { state: buildMemberShareState({ invitation, node, deviceId }) };
  };

  const memberShareStateForTransport = (
    state: MemberShareStateResponse,
    allowed: boolean,
  ): MemberShareStateResponse => {
    if (allowed) return state;
    if (state.state.terminal.state !== 'available' && state.state.terminal.state !== 'viewOnly') return state;
    return {
      state: {
        ...state.state,
        terminal: {
          state: 'blocked',
          reason: 'transport.insecure',
          message: 'Terminal sharing requires HTTPS for public links.',
        },
      },
    };
  };

  const issueMemberWebSocketNonce = (invitationId: string, deviceId: string): string => {
    const now = Date.now();
    for (const [key, record] of memberWebSocketNonces) {
      if (record.expiresAt <= now) memberWebSocketNonces.delete(key);
    }
    const nonce = `kookr_ws_v1_${randomBytes(24).toString('base64url')}`;
    memberWebSocketNonces.set(tokenHash(nonce), {
      invitationId,
      deviceId,
      expiresAt: now + MEMBER_WS_NONCE_TTL_MS,
    });
    return nonce;
  };

  const consumeMemberWebSocketNonce = (auth: RelayClientAuth, url: URL): boolean => {
    if (auth.kind !== 'member' || !auth.invitationId || !auth.deviceId) return false;
    const nonce = url.searchParams.get('wsNonce');
    if (!nonce) return false;
    const key = tokenHash(nonce);
    const record = memberWebSocketNonces.get(key);
    if (!record || record.expiresAt <= Date.now()) {
      memberWebSocketNonces.delete(key);
      return false;
    }
    if (record.invitationId !== auth.invitationId || record.deviceId !== auth.deviceId) return false;
    memberWebSocketNonces.delete(key);
    return true;
  };

  const verifyMemberCsrf = (req: IncomingMessage, auth: RelayClientAuth): boolean => {
    if (auth.kind !== 'member' || !auth.invitationId) return false;
    const header = req.headers['x-kookr-csrf-token'] ?? req.headers['x-kookr-csrf'];
    const headerToken = Array.isArray(header) ? header.at(-1) : header;
    const cookieToken = cookieValue(req, RELAY_MEMBER_CSRF_COOKIE);
    if (!headerToken || !cookieToken || headerToken !== cookieToken) return false;
    return invitations.verifyMemberCsrfToken(auth.invitationId, headerToken);
  };

  const memberSecurityPayload = (invitationId: string, deviceId: string, csrfToken: string | null): {
    csrfToken?: string;
    webSocketNonce: string;
    deviceId: string;
  } => ({
    ...(csrfToken ? { csrfToken } : {}),
    webSocketNonce: issueMemberWebSocketNonce(invitationId, deviceId),
    deviceId,
  });

  const rememberApprovalNotificationDevice = (invitationId: string, deviceId: string): void => {
    const devices = approvalNotificationDevices.get(invitationId) ?? new Set<string>();
    devices.add(deviceId);
    approvalNotificationDevices.set(invitationId, devices);
  };

  const notifyApprovalWatchers = (invitation: InvitationRecord, requestId: string, resolution: 'approved' | 'denied'): void => {
    const devices = approvalNotificationDevices.get(invitation.invitationId);
    if (!devices || devices.size === 0) return;
    const node = registrations.get(invitation.nodeId);
    const taskId = invitation.subject.kind === 'task' ? invitation.subject.taskId : invitation.invitationId;
    const taskLabel = invitation.redactedShareLabel ?? defaultRedactedShareLabel(invitation.shareId);
    for (const deviceId of devices) {
      void pushFanout.sendToDevice(deviceId, makeRedactedPushPayload({
        nodeDisplayName: node?.displayName,
        taskId,
        taskLabel,
        alertKind: 'approval-updated',
        alertId: `approval-${invitation.invitationId}-${requestId}-${resolution}`,
      }));
    }
  };

  const nodeStatuses = (): RelayNodeStatus[] => [...registrations.values()].map((registration) => {
    const hello = nodeHello.get(registration.nodeId);
    const policy = currentNodePolicyState(registration.nodeId);
    return {
      nodeId: registration.nodeId,
      ownerId: registration.ownerId,
      displayName: registration.displayName,
      connected: nodeSockets.has(registration.nodeId),
      ...(registration.lastSeen ? { lastSeen: registration.lastSeen } : {}),
      ...(hello ? { protocolVersion: hello.protocolVersion } : {}),
      policySyncVersion: policy.relayPolicyVersion,
      policySyncStatus: policy.status,
      ...(policy.pendingGrantIds.length > 0 ? { pendingPolicyGrantIds: [...policy.pendingGrantIds] } : {}),
      ...(policy.lastSyncError ? { lastPolicySyncError: policy.lastSyncError } : {}),
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
      if (req.method === 'GET' && url.pathname === '/relay/member-sw.js') {
        sendText(res, 200, 'text/javascript; charset=utf-8', relayMemberServiceWorkerJs());
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
        if (terminal && !terminalTransportAllowed(req, { trustedProxy })) {
          incrementSecurityEvent();
          sendJson(res, 403, { error: 'transport.insecure' });
          return;
        }
        const resolvedTerminal = resolveTerminalSubscription(asNodeId(nodeId), auth, terminal);
        if (resolvedTerminal && 'error' in resolvedTerminal) {
          sendJson(res, 403, { error: resolvedTerminal.error });
          return;
        }
        const afterSeq = parseSeq(url.searchParams.get('afterSeq')) ?? asSeq(0);
        const terminalEvents = resolvedTerminal
          ? collectTerminalReplayEvents(asNodeId(nodeId), resolvedTerminal.sessionId, resolvedTerminal.sessionEpoch, afterSeq)
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
        const accepted = acceptInvitation(
          token,
          typeof body.displayName === 'string' ? body.displayName : undefined,
          cookieValue(req, RELAY_MEMBER_DEVICE_COOKIE) ?? undefined,
        );
        if (!accepted.ok) {
          sendJson(res, accepted.reason === 'not-found' ? 404 : 409, { error: accepted.reason });
          return;
        }
        sendJson(
          res,
          200,
          {
            nodeId: accepted.accepted.invitation.nodeId,
            security: memberSecurityPayload(
              accepted.accepted.invitation.invitationId,
              accepted.accepted.deviceId,
              accepted.accepted.csrfToken,
            ),
          },
          {
            'set-cookie': memberCookies({
              memberToken: accepted.accepted.memberToken,
              csrfToken: accepted.accepted.csrfToken,
              deviceId: accepted.accepted.deviceId,
              expiresAt: accepted.accepted.invitation.expiresAt,
            }, req, { trustedProxy }),
          },
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
          cookieValue(req, RELAY_MEMBER_DEVICE_COOKIE) ?? undefined,
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
          {
            nodeId: accepted.accepted.invitation.nodeId,
            security: memberSecurityPayload(
              accepted.accepted.invitation.invitationId,
              accepted.accepted.deviceId,
              accepted.accepted.csrfToken,
            ),
          },
          {
            'set-cookie': memberCookies({
              memberToken: accepted.accepted.memberToken,
              csrfToken: accepted.accepted.csrfToken,
              deviceId: accepted.accepted.deviceId,
              expiresAt: accepted.accepted.invitation.expiresAt,
            }, req, { trustedProxy }),
          },
        );
        return;
      }
      if (req.method === 'GET' && url.pathname === '/relay/member/share-state') {
        const memberToken = cookieValue(req, RELAY_MEMBER_COOKIE);
        const invitation = memberToken ? invitations.findByMemberToken(memberToken) : null;
        const browserSession = invitation
          ? invitations.ensureMemberBrowserSession({
              invitationId: invitation.invitationId,
              deviceId: invitation.memberDeviceId ?? cookieValue(req, RELAY_MEMBER_DEVICE_COOKIE) ?? undefined,
              csrfToken: cookieValue(req, RELAY_MEMBER_CSRF_COOKIE) ?? undefined,
            })
          : null;
        const deviceId = browserSession?.ok ? browserSession.deviceId : '';
        const state = memberToken ? memberShareStateForToken(memberToken, deviceId) : null;
        if (!state) {
          sendJson(res, 401, { error: 'member-auth-required' });
          return;
        }
        sendJson(res, 200, {
          ...memberShareStateForTransport(state, terminalTransportAllowed(req, { trustedProxy })),
          ...(browserSession?.ok ? {
            security: memberSecurityPayload(
              browserSession.invitation.invitationId,
              browserSession.deviceId,
              browserSession.csrfToken,
            ),
          } : {}),
        }, browserSession?.ok
          ? { 'set-cookie': memberBrowserCookies({
              csrfToken: browserSession.csrfToken,
              deviceId: browserSession.deviceId,
              expiresAt: browserSession.invitation.expiresAt,
            }, req, { trustedProxy }) }
          : {});
        return;
      }
      if (req.method === 'POST' && url.pathname === '/relay/member/approval-notifications') {
        const body = await readJson(req) as { nodeId?: unknown; subscription?: unknown; vapidKeyVersion?: unknown };
        if (typeof body.nodeId !== 'string') {
          sendJson(res, 400, { error: 'nodeId is required' });
          return;
        }
        const auth = authenticateClient(req, opts, invitations, ownerId, asNodeId(body.nodeId), url);
        if (!auth || auth.kind !== 'member' || !auth.invitationId || !auth.deviceId) {
          sendJson(res, 401, { error: 'member-auth-required' });
          return;
        }
        if (!verifyMemberCsrf(req, auth)) {
          incrementSecurityEvent();
          sendJson(res, 403, { error: 'csrf-required' });
          return;
        }
        rememberApprovalNotificationDevice(auth.invitationId, auth.deviceId);
        if (body.subscription !== undefined) {
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
            deviceId: auth.deviceId,
            nodeId: asNodeId(body.nodeId),
            subscription: body.subscription,
            vapidKeyVersion: current.version,
          });
          sendJson(res, 201, {
            mode: 'push',
            deviceId: stored.deviceId,
            nodeId: stored.nodeId,
            vapidKeyVersion: stored.vapidKeyVersion,
          });
          return;
        }
        sendJson(res, 202, { mode: 'poll', deviceId: auth.deviceId });
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
        if (!verifyMemberCsrf(req, auth)) {
          incrementSecurityEvent();
          sendJson(res, 403, { error: 'csrf-required' });
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
          sendJson(res, grantRequestStatus(requested.reason), {
            error: requested.reason,
            ...(requested.retryAt ? { retryAt: requested.retryAt } : {}),
          });
          return;
        }
        broadcastMemberShareState(requested.invitation.nodeId);
        sendJson(res, 201, { request: requested.request });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/relay/member/controller-lease') {
        const body = await readJson(req) as {
          nodeId?: unknown;
          holderLabel?: unknown;
          ttlMs?: unknown;
          takeover?: unknown;
          projectionId?: unknown;
          sessionAlias?: unknown;
          projectionVersion?: unknown;
          policyVersion?: unknown;
        };
        if (typeof body.nodeId !== 'string') {
          sendJson(res, 400, { error: 'nodeId is required' });
          return;
        }
        const auth = authenticateClient(req, opts, invitations, ownerId, asNodeId(body.nodeId), url);
        if (!auth || auth.kind !== 'member' || !auth.invitationId || !auth.deviceId) {
          sendJson(res, 401, { error: 'member-auth-required' });
          return;
        }
        if (!terminalTransportAllowed(req, { trustedProxy })) {
          incrementSecurityEvent();
          sendJson(res, 403, { error: 'transport.insecure' });
          return;
        }
        if (!verifyMemberCsrf(req, auth)) {
          incrementSecurityEvent();
          sendJson(res, 403, { error: 'csrf-required' });
          return;
        }
        if (!authAllows(auth, 'terminalInput', invitations)) {
          sendJson(res, 403, { error: 'terminal-input-grant-required' });
          return;
        }
        const invitation = invitations.list().find((candidate) => candidate.invitationId === auth.invitationId);
        if (!invitation || !policyAckedForInput(asNodeId(body.nodeId), invitation.policyVersion)) {
          sendJson(res, 409, { error: `policy sync ${currentNodePolicyState(asNodeId(body.nodeId)).status}` });
          return;
        }
        if (invitation.subject.kind !== 'session') {
          const projection = terminalProjectionForAuth(
            asNodeId(body.nodeId),
            auth,
            typeof body.projectionId === 'string' ? body.projectionId : null,
            body.sessionAlias === 'primary' ? 'primary' : null,
          );
          if (!projection) {
            sendJson(res, 409, { error: 'projection-stale' });
            return;
          }
          if (
            body.projectionVersion !== projection.projection.projectionVersion
            || body.policyVersion !== projection.projection.policyVersion
          ) {
            sendJson(res, 409, { error: 'projection-stale' });
            return;
          }
        }
        const lease = invitations.acquireControllerLease({
          invitationId: auth.invitationId,
          deviceId: auth.deviceId,
          holderLabel: typeof body.holderLabel === 'string' ? body.holderLabel : undefined,
          ttlMs: typeof body.ttlMs === 'number' && Number.isFinite(body.ttlMs) ? body.ttlMs : undefined,
          takeover: body.takeover === true,
          projectionVersion: typeof body.projectionVersion === 'number' && Number.isInteger(body.projectionVersion)
            ? body.projectionVersion
            : undefined,
          policyVersion: typeof body.policyVersion === 'number' && Number.isInteger(body.policyVersion)
            ? asPolicyVersion(body.policyVersion)
            : undefined,
        });
        if (!lease.ok) {
          sendJson(res, lease.reason === 'held-by-another-device' ? 409 : 400, {
            error: lease.reason,
            ...(lease.lease ? { lease: lease.lease } : {}),
          });
          return;
        }
        broadcastMemberShareState(lease.invitation.nodeId);
        sendJson(res, 200, {
          lease: lease.lease,
          ...(lease.previousLease ? { previousLease: lease.previousLease } : {}),
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/relay/member/retry-tokens') {
        const body = await readJson(req) as {
          nodeId?: unknown;
          leaseId?: unknown;
          projectionVersion?: unknown;
          policyVersion?: unknown;
          payloadHash?: unknown;
        };
        if (typeof body.nodeId !== 'string') {
          sendJson(res, 400, { error: 'nodeId is required' });
          return;
        }
        const auth = authenticateClient(req, opts, invitations, ownerId, asNodeId(body.nodeId), url);
        if (!auth || auth.kind !== 'member' || !auth.invitationId || !auth.deviceId) {
          sendJson(res, 401, { error: 'member-auth-required' });
          return;
        }
        if (!terminalTransportAllowed(req, { trustedProxy })) {
          incrementSecurityEvent();
          sendJson(res, 403, { error: 'transport.insecure' });
          return;
        }
        if (!verifyMemberCsrf(req, auth)) {
          incrementSecurityEvent();
          sendJson(res, 403, { error: 'csrf-required' });
          return;
        }
        const invitation = invitations.list().find((candidate) => candidate.invitationId === auth.invitationId);
        const lease = invitation?.controllerLease;
        if (
          !invitation
          || !lease
          || lease.deviceId !== auth.deviceId
          || Date.parse(lease.expiresAt) <= Date.now()
          || body.leaseId !== lease.leaseId
          || typeof body.projectionVersion !== 'number'
          || typeof body.policyVersion !== 'number'
          || typeof body.payloadHash !== 'string'
        ) {
          sendJson(res, 409, { error: 'retry-token-binding-required' });
          return;
        }
        const token = `kookr_retry_v1_${randomBytes(24).toString('base64url')}`;
        const expiresAt = Date.now() + MEMBER_RETRY_TOKEN_TTL_MS;
        for (const [key, binding] of memberRetryTokens) {
          if (binding.expiresAt <= Date.now()) memberRetryTokens.delete(key);
        }
        memberRetryTokens.set(tokenHash(token), {
          invitationId: auth.invitationId,
          deviceId: auth.deviceId,
          leaseId: lease.leaseId,
          projectionVersion: body.projectionVersion,
          policyVersion: asPolicyVersion(body.policyVersion),
          payloadHash: body.payloadHash,
          expiresAt,
        });
        sendJson(res, 201, { retryToken: token, expiresAt: new Date(expiresAt).toISOString() });
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
        notifyApprovalWatchers(
          resolved.invitation,
          requestId,
          resolution === 'approve' ? 'approved' : 'denied',
        );
        broadcastPresence(registration.nodeId);
        broadcastMemberShareState(registration.nodeId);
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
      if (auth.kind === 'member' && !originHeaderAllowed(req, { trustedProxy })) {
        incrementSecurityEvent();
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      if (auth.kind === 'member' && !consumeMemberWebSocketNonce(auth, url)) {
        incrementSecurityEvent();
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      const terminal = parseTerminalSubscription(url);
      if (terminal && !authAllowsTerminalStream(auth, invitations)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      if (terminal && !terminalTransportAllowed(req, { trustedProxy })) {
        incrementSecurityEvent();
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      const resolvedTerminal = resolveTerminalSubscription(asNodeId(nodeId), auth, terminal);
      if (resolvedTerminal && 'error' in resolvedTerminal) {
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
        for (const [key, projection] of [...shareSessionProjections]) {
          if (projection.projection.nodeId === registration.nodeId && projection.projection.nodeInstanceId !== String(parsed.nodeEpoch)) {
            shareSessionProjections.delete(key);
          }
        }
        const subscribed = subscribers.get(registration.nodeId);
        for (const sub of [...(subscribed ?? [])]) {
          if (sub.terminal?.projectionId) {
            sub.ws.close(4004, 'projection stale');
            subscribed?.delete(sub);
          }
        }
        recordLastSeen(registration);
        ws.send(JSON.stringify(makeRelayHello({
          outcome: 'accepted',
          acceptedVersion: REMOTE_PROTOCOL_VERSION,
          enabledFeatures: parsed.supportedFeatures,
          shareMaxTtlMs,
        })));
        sendPolicySync(registration.nodeId, ws);
        broadcastMemberShareState(registration.nodeId);
        return;
      }

      if (
        parsed
        && typeof parsed === 'object'
        && (parsed as { type?: unknown }).type === 'policy.delta.ack'
        && (parsed as { nodeId?: unknown }).nodeId === registration.nodeId
        && typeof (parsed as { policyVersion?: unknown }).policyVersion === 'number'
      ) {
        const ack = parsed as { policyVersion: number };
        const current = currentNodePolicyState(registration.nodeId);
        if (ack.policyVersion >= current.relayPolicyVersion) {
          nodePolicySync.set(registration.nodeId, {
            status: 'acked',
            relayPolicyVersion: asPolicyVersion(ack.policyVersion),
            nodeAckedPolicyVersion: asPolicyVersion(ack.policyVersion),
            lastPolicySentAt: current.lastPolicySentAt,
            lastPolicyAckAt: new Date().toISOString(),
            pendingGrantIds: [],
          });
        } else {
          nodePolicySync.set(registration.nodeId, {
            ...current,
            status: 'stale',
            nodeAckedPolicyVersion: asPolicyVersion(ack.policyVersion),
            lastPolicyAckAt: new Date().toISOString(),
          });
        }
          broadcastMemberShareState(registration.nodeId);
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
        broadcastMemberShareState(registration.nodeId);
      }
    });
  });

  function routeControlEvent(event: RemoteControlEvent): void {
    const sessionProjection = shareSessionProjectionEnvelopeFromEvent(event);
    if (sessionProjection) {
      const key = `${event.nodeId}\0${sessionProjection.projection.projectionId}`;
      const previous = shareSessionProjections.get(key);
      shareSessionProjections.set(key, sessionProjection);
      if (
        previous
        && (
          previous.invitationId !== sessionProjection.invitationId
          || previous.projection.projectionVersion !== sessionProjection.projection.projectionVersion
          || previous.projection.nodeInstanceId !== sessionProjection.projection.nodeInstanceId
        )
      ) {
        const subscribed = subscribers.get(event.nodeId);
        for (const sub of [...(subscribed ?? [])]) {
          if (sub.terminal?.projectionId === sessionProjection.projection.projectionId) {
            sub.ws.close(4004, 'projection replaced');
            subscribed?.delete(sub);
          }
        }
      }
    }
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

  function shareSessionProjectionAuthStillAuthorized(
    nodeId: NodeId,
    auth: RelayClientAuth,
    envelope: ShareSessionProjectionEnvelopeV1,
  ): boolean {
    if (auth.kind === 'owner') return true;
    if (!auth.invitationId || auth.invitationId !== envelope.invitationId) return false;
    const invitation = invitations.list().find((candidate) => candidate.invitationId === auth.invitationId);
    if (!invitation || invitation.nodeId !== nodeId || invitation.grantId !== auth.grantId) return false;
    if (invitation.revokedAt || Date.parse(invitation.expiresAt) <= Date.now()) return false;
    if (!isNodeTaskShare(invitation)) return false;
    if (!grantsAllowTerminalView(invitation.grants)) return false;
    if (envelope.projection.nodeId !== nodeId) return false;
    if (envelope.projection.nodeInstanceId !== String(nodeHello.get(nodeId)?.nodeEpoch ?? '')) return false;
    if (envelope.projection.expiresAt && Date.parse(envelope.projection.expiresAt) <= Date.now()) return false;
    return true;
  }

  function terminalProjectionForAuth(
    nodeId: NodeId,
    auth: RelayClientAuth,
    projectionId: string | null,
    sessionAlias: string | null,
  ): ShareSessionProjectionEnvelopeV1 | null {
    if (!projectionId || sessionAlias !== 'primary') return null;
    const envelope = shareSessionProjections.get(`${nodeId}\0${projectionId}`);
    if (!envelope || !shareSessionProjectionAuthStillAuthorized(nodeId, auth, envelope)) return null;
    if (!envelope.projection.primarySharedSession) return null;
    return envelope;
  }

  function resolveTerminalSubscription(
    nodeId: NodeId,
    auth: RelayClientAuth,
    terminal: RelayClientSubscription['terminal'] | undefined,
  ): RelayClientSubscription['terminal'] | { error: 'projection-required' | 'projection-stale' } | undefined {
    if (!terminal) return undefined;
    if (auth.kind === 'owner') return terminal;
    if (!terminal.projectionId || terminal.sessionAlias !== 'primary') {
      const invitation = auth.invitationId
        ? invitations.list().find((candidate) => candidate.invitationId === auth.invitationId)
        : null;
      if (
        invitation?.subject.kind === 'session'
        && invitation.subject.sessionId === terminal.sessionId
        && invitation.nodeId === nodeId
      ) {
        return terminal;
      }
      return { error: 'projection-required' };
    }
    const envelope = terminalProjectionForAuth(nodeId, auth, terminal.projectionId, terminal.sessionAlias);
    const primary = envelope?.projection.primarySharedSession;
    if (!primary) return { error: 'projection-stale' };
    return {
      projectionId: terminal.projectionId,
      sessionAlias: 'primary',
      sessionId: primary.sessionId,
      sessionEpoch: primary.sessionEpoch ?? asSessionEpoch('1'),
    };
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
    const sessionProjection = shareSessionProjectionEnvelopeFromEvent(event);
    if (sessionProjection) return shareSessionProjectionAuthStillAuthorized(nodeId, auth, sessionProjection);
    return false;
  }

  function canSendEventToSubscriber(nodeId: NodeId, sub: RelayClientSubscription, event: RemoteControlEvent): boolean {
    if (!subscriptionStillAuthorized(nodeId, sub)) return false;
    if (sub.auth.kind === 'owner') return true;
    const projection = remoteTaskProjectionEnvelopeFromEvent(event);
    if (projection) return projectionSubscriptionStillAuthorized(nodeId, sub, projection);
    const sessionProjection = shareSessionProjectionEnvelopeFromEvent(event);
    if (sessionProjection) return shareSessionProjectionAuthStillAuthorized(nodeId, sub.auth, sessionProjection);
    return false;
  }

  function eventForAuth(auth: RelayClientAuth, event: RemoteControlEvent): RemoteControlEvent {
    if (auth.kind === 'owner' || !auth.invitationId) return event;
    const sessionEnvelope = shareSessionProjectionEnvelopeFromEvent(event);
    if (sessionEnvelope) {
      return {
        ...event,
        payload: {
          ...sessionEnvelope,
          projection: {
            ...sessionEnvelope.projection,
            primarySharedSession: sessionEnvelope.projection.primarySharedSession
              ? {
                  sessionAlias: sessionEnvelope.projection.primarySharedSession.sessionAlias,
                  title: sessionEnvelope.projection.primarySharedSession.title,
                  lastActivityAt: sessionEnvelope.projection.primarySharedSession.lastActivityAt,
                  replayCursor: sessionEnvelope.projection.primarySharedSession.replayCursor,
                }
              : undefined,
          },
        },
      } as RemoteControlEvent;
    }
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

  function broadcastMemberShareState(nodeId: NodeId): void {
    const subscribed = subscribers.get(nodeId);
    if (!subscribed) return;
    for (const sub of [...subscribed]) {
      if (!subscriptionStillAuthorized(nodeId, sub)) continue;
      if (sub.auth.kind !== 'member' || !sub.auth.invitationId) continue;
      const invitation = invitations.list().find((candidate) => candidate.invitationId === sub.auth.invitationId);
      const node = memberNodeState(nodeId);
      if (!invitation || !node) continue;
      if (sub.ws.readyState === sub.ws.OPEN) {
        const state = memberShareStateForTransport(
          { state: buildMemberShareState({ invitation, node, deviceId: sub.auth.deviceId }) },
          sub.terminalTransportAllowed ?? true,
        );
        sub.ws.send(JSON.stringify({
          type: 'relay.memberShareState',
          state: state.state,
        }));
      }
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
    const terminalInputTransportAllowed = terminalTransportAllowed(_req, { trustedProxy });
    const relayClientId = `relay-client-${randomUUID()}`;
    const terminal = parseTerminalSubscription(url);
    const resolvedTerminal = resolveTerminalSubscription(subscribedNodeId, auth, terminal);
    if (resolvedTerminal && 'error' in resolvedTerminal) {
      ws.close(1008, resolvedTerminal.error);
      return;
    }
    const subscription: RelayClientSubscription = {
      ws,
      auth,
      terminalTransportAllowed: terminalInputTransportAllowed,
      ...(resolvedTerminal ? { terminal: resolvedTerminal } : {}),
    };
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
    if (subscription.terminal && requestedAfterSeq !== null) {
      replayTerminalEvents(
        ws,
        subscribedNodeId,
        subscription.terminal.sessionId,
        subscription.terminal.sessionEpoch,
        requestedAfterSeq,
      );
    }
    recordPresence(subscribedNodeId, relayClientId, auth);
    if (auth.kind === 'member' && auth.invitationId) {
      const invitation = invitations.list().find((candidate) => candidate.invitationId === auth.invitationId);
      const node = memberNodeState(subscribedNodeId);
      if (invitation && node && ws.readyState === ws.OPEN) {
        const state = memberShareStateForTransport(
          { state: buildMemberShareState({ invitation, node, deviceId: auth.deviceId }) },
          terminalInputTransportAllowed,
        );
        ws.send(JSON.stringify({
          type: 'relay.memberShareState',
          state: state.state,
        }));
      }
    }
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
        const payload = command.payload as {
          sessionId?: unknown;
          sessionEpoch?: unknown;
          projectionId?: unknown;
          sessionAlias?: unknown;
          afterSeq?: unknown;
        };
        const afterSeq = typeof payload?.afterSeq === 'number' && Number.isInteger(payload.afterSeq)
          ? payload.afterSeq
          : null;
        const requestedTerminal = auth.kind === 'owner'
          ? (
              typeof payload?.sessionId === 'string' && typeof payload.sessionEpoch === 'string'
                ? { sessionId: asSessionId(payload.sessionId), sessionEpoch: asSessionEpoch(payload.sessionEpoch) }
                : null
            )
          : resolveTerminalSubscription(subscribedNodeId, auth, {
              projectionId: typeof payload?.projectionId === 'string' ? payload.projectionId : undefined,
              sessionAlias: payload?.sessionAlias === 'primary' ? 'primary' : undefined,
              sessionId: asSessionId(''),
              sessionEpoch: asSessionEpoch(''),
            });
        if (requestedTerminal && 'error' in requestedTerminal) {
          ws.close(1008, requestedTerminal.error);
          return;
        }
        if (
          requestedTerminal
          && afterSeq !== null
          && afterSeq >= 0
        ) {
          replayTerminalEvents(
            ws,
            subscribedNodeId,
            requestedTerminal.sessionId,
            requestedTerminal.sessionEpoch,
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
      const sendCommandReject = (reason: string, outcome: CommandOutcome = 'rejected-pre-audit'): void => {
        const result = {
          type: 'remote.command.result',
          commandId,
          action: typeof action === 'string' ? action : 'presetReply',
          outcome,
          reason,
        };
        appendMetadataAudit({
          type: 'relay.metadata-audit',
          commandId,
          nodeId: subscribedNodeId,
          ...(typeof action === 'string' ? { action: action as RemoteCommandAction } : {}),
          outcome,
          timestamp: new Date().toISOString(),
          reason,
        });
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(result));
      };
      appendMetadataAudit({
        type: 'relay.metadata-audit',
        commandId,
        nodeId: subscribedNodeId,
        ...(typeof action === 'string' ? { action: action as RemoteCommandAction } : {}),
        outcome: 'forwarded',
        timestamp: new Date().toISOString(),
      });
      const requiredGrant = grantForRemoteCommandAction(action);
      if (requiredGrant === 'terminalInput' && !terminalInputTransportAllowed) {
        incrementSecurityEvent();
        sendCommandReject('transport.insecure');
        return;
      }
      if (!authAllows(auth, requiredGrant, invitations)) {
        sendCommandReject(requiredGrant ? `missing ${requiredGrant} grant` : 'unknown action');
        return;
      }
      let terminalCommandSession: RelayClientSubscription['terminal'] | null = null;
      let submitMessagePayload: {
        text: string;
        appendNewline: boolean;
        provenance?: 'typed' | 'paste';
      } | null = null;
      if (auth.kind === 'member' && requiredGrant === 'terminalInput') {
        const invitation = auth.invitationId
          ? invitations.list().find((candidate) => candidate.invitationId === auth.invitationId)
          : null;
        if (!invitation || !policyAckedForInput(subscribedNodeId, invitation.policyVersion)) {
          const policyState = currentNodePolicyState(subscribedNodeId).status;
          sendCommandReject(`policy sync ${policyState}`);
          return;
        }
        const projectionId = typeof (command as { projectionId?: unknown }).projectionId === 'string'
          ? (command as { projectionId: string }).projectionId
          : typeof (command.payload as { projectionId?: unknown } | undefined)?.projectionId === 'string'
            ? (command.payload as { projectionId: string }).projectionId
            : null;
        const sessionAlias = (command as { sessionAlias?: unknown }).sessionAlias === 'primary'
          ? 'primary'
          : (command.payload as { sessionAlias?: unknown } | undefined)?.sessionAlias === 'primary'
            ? 'primary'
            : null;
        const projection = projectionId && sessionAlias === 'primary'
          ? terminalProjectionForAuth(subscribedNodeId, auth, projectionId, sessionAlias)
          : null;
        const resolved = resolveTerminalSubscription(subscribedNodeId, auth, {
          projectionId: projectionId ?? undefined,
          sessionAlias: sessionAlias ?? undefined,
          sessionId: typeof (command as { sessionId?: unknown }).sessionId === 'string'
            ? asSessionId((command as { sessionId: string }).sessionId)
            : asSessionId(''),
          sessionEpoch: typeof (command as { sessionEpoch?: unknown }).sessionEpoch === 'string'
            ? asSessionEpoch((command as { sessionEpoch: string }).sessionEpoch)
            : asSessionEpoch(''),
        });
        if (!resolved || 'error' in resolved) {
          sendCommandReject(resolved?.error ?? 'projection-required');
          return;
        }
        const leaseId = typeof (command as { leaseId?: unknown }).leaseId === 'string'
          ? (command as { leaseId: string }).leaseId
          : typeof (command.payload as { leaseId?: unknown } | undefined)?.leaseId === 'string'
            ? (command.payload as { leaseId: string }).leaseId
            : '';
        if ((action === 'submitMessage' || action === 'leaseHeartbeat') && !leaseId) {
          sendCommandReject('controller-lease-required');
          return;
        }
        const projectionVersion = typeof (command as { projectionVersion?: unknown }).projectionVersion === 'number'
          ? (command as { projectionVersion: number }).projectionVersion
          : typeof (command.payload as { projectionVersion?: unknown } | undefined)?.projectionVersion === 'number'
            ? (command.payload as { projectionVersion: number }).projectionVersion
            : Number.NaN;
        const policyVersion = typeof (command as { policyVersion?: unknown }).policyVersion === 'number'
          ? (command as { policyVersion: number }).policyVersion
          : typeof (command.payload as { policyVersion?: unknown } | undefined)?.policyVersion === 'number'
            ? (command.payload as { policyVersion: number }).policyVersion
            : Number.NaN;
        const retryToken = typeof (command as { retryToken?: unknown }).retryToken === 'string'
          ? (command as { retryToken: string }).retryToken
          : typeof (command.payload as { retryToken?: unknown } | undefined)?.retryToken === 'string'
            ? (command.payload as { retryToken: string }).retryToken
            : null;
        if (retryToken) {
          const binding = memberRetryTokens.get(tokenHash(retryToken));
          const matches = binding
            && binding.expiresAt > Date.now()
            && binding.invitationId === auth.invitationId
            && binding.deviceId === auth.deviceId
            && binding.leaseId === leaseId
            && binding.projectionVersion === projectionVersion
            && binding.policyVersion === policyVersion
            && binding.payloadHash === payloadHash(command.payload);
          if (!matches) {
            sendCommandReject('retry-token-mismatch');
            return;
          }
        }
        if (projection && (
          projectionVersion !== projection.projection.projectionVersion
          || policyVersion !== projection.projection.policyVersion
        )) {
          sendCommandReject('projection-stale');
          return;
        }
        if (action === 'submitMessage') {
          const payload = command.payload as { text?: unknown; appendNewline?: unknown; provenance?: unknown } | undefined;
          if (
            typeof payload?.text !== 'string'
            || payload.text.length > 4096
            || (payload.appendNewline !== undefined && typeof payload.appendNewline !== 'boolean')
            || (payload.text.length === 0 && payload.appendNewline === false)
          ) {
            sendCommandReject('invalid submit message');
            return;
          }
          submitMessagePayload = {
            text: payload.text,
            appendNewline: payload.appendNewline !== false,
            ...(payload.provenance === 'paste' ? { provenance: 'paste' as const } : { provenance: 'typed' as const }),
          };
        }
        const activeLease = invitation.controllerLease && Date.parse(invitation.controllerLease.expiresAt) > Date.now()
          ? invitation.controllerLease
          : null;
        const leaseMatches = Boolean(
          activeLease
          && auth.deviceId
          && activeLease.deviceId === auth.deviceId,
        );
        if (!leaseMatches) {
          sendCommandReject(activeLease && activeLease.deviceId !== auth.deviceId
              ? 'controller-lease-held-by-another-device'
              : 'controller-lease-required');
          return;
        }
        terminalCommandSession = resolved;
      }
      const target = nodeSockets.get(subscribedNodeId);
      if (target?.readyState === WebSocket.OPEN) {
        const registration = registrations.get(subscribedNodeId);
        const nodeEpoch = nodeHello.get(subscribedNodeId)?.nodeEpoch;
        if (!nodeEpoch) {
          sendCommandReject('node epoch unavailable', 'node-offline');
          return;
        }
        const idempotencyKey = typeof (command as { idempotencyKey?: unknown }).idempotencyKey === 'string'
          ? (command as { idempotencyKey: string }).idempotencyKey
          : `idem-${commandId}`;
        const baseRevision = typeof (command as { baseRevision?: unknown }).baseRevision === 'number'
          ? (command as { baseRevision: number }).baseRevision
          : 0;
        const lastSeenSeq = typeof (command as { lastSeenSeq?: unknown }).lastSeenSeq === 'number'
          ? (command as { lastSeenSeq: number }).lastSeenSeq
          : 0;
        const commandLeaseId = typeof (command as { leaseId?: unknown }).leaseId === 'string'
          ? (command as { leaseId: string }).leaseId
          : (command.payload as { leaseId?: string } | undefined)?.leaseId;
        rememberCommandRecipient(subscribedNodeId, commandId, subscription);
        target.send(JSON.stringify({
          ...command,
          nodeId: subscribedNodeId,
          nodeEpoch,
          idempotencyKey,
          ...(commandLeaseId ? { leaseId: commandLeaseId } : {}),
          ...(terminalCommandSession ? {
            sessionId: terminalCommandSession.sessionId,
            sessionEpoch: terminalCommandSession.sessionEpoch,
            projectionId: terminalCommandSession.projectionId,
            sessionAlias: terminalCommandSession.sessionAlias,
          } : {}),
          ...(action === 'submitMessage' && terminalCommandSession && submitMessagePayload ? {
            baseRevision,
            lastSeenSeq,
            payload: {
              type: 'submit-message',
              sessionId: terminalCommandSession.sessionId,
              sessionEpoch: terminalCommandSession.sessionEpoch,
              leaseId: commandLeaseId,
              commandId,
              idempotencyKey,
              text: submitMessagePayload.text,
              appendNewline: submitMessagePayload.appendNewline,
              baseRevision,
              lastSeenSeq,
              maxAgeMs: 10_000,
              commandMetadata: {
                provenance: submitMessagePayload.provenance,
                ...(auth.deviceId ? { sourceDeviceId: auth.deviceId } : {}),
              },
            },
          } : {}),
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
      <input id="invite-grants" value="view,comment,terminalView,terminalInput" aria-label="Invitation grants">
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

function relayMemberServiceWorkerJs(): string {
  return `
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch {}
  const task = typeof payload.taskShortLabel === 'string' && payload.taskShortLabel
    ? payload.taskShortLabel
    : 'Shared task';
  const node = typeof payload.nodeDisplayName === 'string' && payload.nodeDisplayName
    ? payload.nodeDisplayName
    : 'Kookr';
  const title = payload.alertKind === 'approval-updated' ? 'Kookr approval updated' : 'Kookr share update';
  event.waitUntil(self.registration.showNotification(title, {
    body: node + ' · ' + task,
    tag: typeof payload.alertId === 'string' ? payload.alertId : 'kookr-share-update',
    data: { url: '/relay/join' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data && event.notification.data.url || '/relay/join'));
});
`;
}

function relayJoinHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kookr shared task</title>
  <link rel="stylesheet" href="/relay/assets/xterm.css">
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #0d1117; color: #e7ecef; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; min-height: 100dvh; display: flex; align-items: stretch; justify-content: center; background: #0d1117; }
    main { width: min(960px, 100vw); padding: 16px; display: flex; }
    h1 { font-size: 24px; margin: 0 0 8px; }
    .panel { border: 1px solid #2b373d; border-radius: 8px; background: #151c20; padding: 18px; width: 100%; align-self: center; }
    .muted { color: #aeb9bf; }
    .status { margin: 12px 0; min-height: 20px; color: #aeb9bf; }
    label { display: grid; gap: 6px; margin: 14px 0; }
    input { background: #0c1114; color: #e7ecef; border: 1px solid #2b373d; border-radius: 4px; padding: 9px 10px; }
    textarea { width: 100%; min-height: 68px; resize: vertical; background: #0c1114; color: #e7ecef; border: 1px solid #2b373d; border-radius: 4px; padding: 9px 10px; font: inherit; }
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
    .blocked { border-color: #7f1d1d; background: #2a1111; }
    .approval-watch { border: 1px solid #2b373d; border-radius: 6px; padding: 12px; margin-top: 10px; background: #0f1519; }
    .approval-watch .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .terminal-shell { margin-top: 14px; border: 1px solid #2b373d; border-radius: 6px; background: #06080a; overflow: hidden; }
    .terminal-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; background: #0f1519; border-bottom: 1px solid #2b373d; }
    .terminal-toolbar strong { font-size: 13px; }
    .terminal-viewer { height: clamp(220px, 42dvh, 520px); min-height: 180px; }
    .terminal-banner { margin-top: 10px; border: 1px solid #7c5f16; border-radius: 6px; padding: 10px; background: #211b0d; color: #f4d58d; }
    .composer { margin-top: 14px; display: grid; gap: 8px; }
    .composer-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
    @media (max-width: 520px) {
      main { padding: 10px; }
      .panel { padding: 14px; align-self: stretch; }
      h1 { font-size: 21px; }
      .task dl { grid-template-columns: 1fr; gap: 3px; }
      .terminal-viewer { height: clamp(180px, 36dvh, 360px); }
    }
  </style>
</head>
<body>
<main>
  <section class="panel">
    <h1>Shared Kookr task</h1>
    <p class="muted">Shared task access as an unverified guest.</p>
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
    <section id="terminal-status" class="request" hidden aria-label="Terminal sharing status">
      <strong id="terminal-status-title"></strong>
      <p id="terminal-status-copy" class="muted"></p>
    </section>
    <section id="terminal-shell" class="terminal-shell" hidden aria-label="Shared terminal">
      <div class="terminal-toolbar">
        <strong>Terminal</strong>
        <span id="terminal-live-state" class="muted">Waiting for terminal projection</span>
      </div>
      <div id="terminal" class="terminal-viewer"></div>
    </section>
    <div id="terminal-banner" class="terminal-banner" aria-live="polite" hidden></div>
    <section id="terminal-composer" class="composer" hidden aria-label="Terminal input">
      <textarea id="terminal-input" disabled aria-label="Terminal input message"></textarea>
      <div class="composer-actions">
        <button id="terminal-send-text" type="button" disabled>Send text</button>
        <button id="terminal-send-enter" type="button" disabled>Send Enter</button>
      </div>
    </section>
    <section id="grant-request" class="request" hidden aria-label="Collaborator grant request">
      <p id="grant-request-copy" class="muted">Terminal input requires owner approval.</p>
      <button id="request-control" type="button">Request terminal input</button>
    </section>
    <section id="approval-watch" class="approval-watch" hidden aria-label="Approval notification">
      <div class="row">
        <button id="notify-approval" type="button">Notify me when approved</button>
        <span id="approval-watch-status" class="muted" role="status" aria-live="polite">Polling for approval.</span>
      </div>
    </section>
  </section>
</main>
<script src="/relay/assets/xterm.js"></script>
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
const grantRequestCopyEl = document.getElementById('grant-request-copy');
const approvalWatchEl = document.getElementById('approval-watch');
const notifyApprovalEl = document.getElementById('notify-approval');
const approvalWatchStatusEl = document.getElementById('approval-watch-status');
const offlineNodeEl = document.getElementById('offline-node');
const offlineLastSeenEl = document.getElementById('offline-last-seen');
const terminalStatusEl = document.getElementById('terminal-status');
const terminalStatusTitleEl = document.getElementById('terminal-status-title');
const terminalStatusCopyEl = document.getElementById('terminal-status-copy');
const terminalShellEl = document.getElementById('terminal-shell');
const terminalEl = document.getElementById('terminal');
const terminalLiveStateEl = document.getElementById('terminal-live-state');
const terminalBannerEl = document.getElementById('terminal-banner');
const terminalComposerEl = document.getElementById('terminal-composer');
const terminalInputEl = document.getElementById('terminal-input');
const terminalSendTextEl = document.getElementById('terminal-send-text');
const terminalSendEnterEl = document.getElementById('terminal-send-enter');
const nodeKey = 'kookr-relay-join-node:' + location.host;
let nodeId = sessionStorage.getItem(nodeKey) || '';
let ws = null;
let terminalWs = null;
let terminal = null;
let terminalProjection = null;
let terminalStreamKey = '';
let lastTerminalSeq = 0;
let terminalStreamOpenedAtMs = 0;
let terminalMayView = false;
let terminalMayInput = false;
let csrfToken = '';
let nextWebSocketNonce = '';
let controllerLease = null;
let nodeLeaseReady = false;
let leaseHeartbeatTimer = null;
let statePollingTimer = null;
const pendingCommands = new Map();
shareIdEl.value = pathShareId;
sharePasswordEl.value = fragmentPassword;
if (inviteToken) ticketFieldsEl.hidden = true;

function cookieValue(name) {
  const prefix = name + '=';
  for (const part of document.cookie.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) return decodeURIComponent(trimmed.slice(prefix.length));
  }
  return '';
}

function applySecurity(body) {
  const security = body && body.security;
  if (!security || typeof security !== 'object') return;
  if (typeof security.csrfToken === 'string') csrfToken = security.csrfToken;
  if (typeof security.webSocketNonce === 'string') nextWebSocketNonce = security.webSocketNonce;
}

function base64UrlToUint8Array(value) {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}

async function pollMemberState() {
  try {
    const res = await fetch('/relay/member/share-state', { credentials: 'include' });
    if (!res.ok) return false;
    const body = await res.json();
    applySecurity(body);
    renderMemberShareState(body.state);
    return true;
  } catch {
    return false;
  }
}

function startStatePolling(label) {
  approvalWatchEl.hidden = false;
  approvalWatchStatusEl.textContent = label || 'Polling for approval.';
  if (statePollingTimer) return;
  statePollingTimer = setInterval(() => {
    void pollMemberState();
  }, 5000);
}

function stopStatePolling() {
  if (statePollingTimer) clearInterval(statePollingTimer);
  statePollingTimer = null;
  approvalWatchEl.hidden = true;
}

async function registerApprovalNotification(payload) {
  return fetch('/relay/member/approval-notifications', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-kookr-csrf-token': csrfToken || cookieValue('kookr_relay_csrf_token'),
    },
    credentials: 'include',
    body: JSON.stringify({ nodeId, ...payload }),
  });
}

async function enableApprovalNotification() {
  if (!nodeId) return;
  notifyApprovalEl.disabled = true;
  startStatePolling('Polling is active.');
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      await registerApprovalNotification({});
      approvalWatchStatusEl.textContent = 'Polling for approval.';
      return;
    }
    const permission = Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission();
    if (permission !== 'granted') {
      await registerApprovalNotification({});
      approvalWatchStatusEl.textContent = 'Notifications unavailable; polling for approval.';
      return;
    }
    const keyRes = await fetch('/relay/push/vapid-public-key', { credentials: 'include' });
    if (!keyRes.ok) throw new Error('push key unavailable');
    const key = await keyRes.json();
    const registration = await navigator.serviceWorker.register('/relay/member-sw.js', { scope: '/relay/' });
    const existing = await registration.pushManager.getSubscription();
    const subscription = existing || await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToUint8Array(key.publicKey),
    });
    const res = await registerApprovalNotification({ subscription: subscription.toJSON(), vapidKeyVersion: key.version });
    if (!res.ok) throw new Error('subscription failed');
    approvalWatchStatusEl.textContent = 'Notifications enabled. Polling stays active as backup.';
  } catch {
    approvalWatchStatusEl.textContent = 'Notifications unavailable; polling for approval.';
  }
}

async function takeWebSocketNonce() {
  if (nextWebSocketNonce) {
    const nonce = nextWebSocketNonce;
    nextWebSocketNonce = '';
    return nonce;
  }
  try {
    const res = await fetch('/relay/member/share-state', { credentials: 'include' });
    if (!res.ok) return '';
    const body = await res.json();
    applySecurity(body);
    if (nextWebSocketNonce) {
      const nonce = nextWebSocketNonce;
      nextWebSocketNonce = '';
      return nonce;
    }
  } catch {}
  return '';
}

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

function setTerminalBanner(text, blocked) {
  terminalBannerEl.textContent = text || '';
  terminalBannerEl.hidden = !text;
  terminalBannerEl.className = blocked ? 'terminal-banner blocked' : 'terminal-banner';
  terminalBannerEl.dataset.sticky = '';
  terminalInputEl.disabled = true;
  terminalSendTextEl.disabled = true;
  terminalSendEnterEl.disabled = true;
}

function ensureTerminal() {
  terminalShellEl.hidden = false;
  terminalComposerEl.hidden = false;
  if (terminal) return;
  const TerminalCtor = window.Terminal;
  if (!TerminalCtor) {
    setTerminalBanner('Terminal renderer is unavailable in this browser.', true);
    return;
  }
  terminal = new TerminalCtor({
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
  terminal.textarea?.setAttribute('aria-label', 'Read-only terminal output');
}

function writeTerminal(textOrBytes) {
  ensureTerminal();
  terminal?.write(textOrBytes);
}

function commandId(prefix) {
  const suffix = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(16).slice(2);
  return prefix + '-' + suffix;
}

// Must match canonicalJson in src/remote/retry-token.ts for relay-side retry-token validation.
function canonicalJson(value) {
  if (value === undefined) return '"__kookr_undefined__"';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function commandPayloadHash(payload) {
  return sha256Hex(canonicalJson(payload));
}

function remoteCommand(action, extra) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !nodeId) return Promise.reject(new Error('not connected'));
  const id = commandId(action);
  const message = {
    type: 'remote.command',
    commandId: id,
    nodeId,
    nodeEpoch: terminalProjection?.nodeEpoch || '',
    action,
    idempotencyKey: 'idem-' + id,
    projectionId: terminalProjection?.projectionId,
    sessionAlias: 'primary',
    projectionVersion: terminalProjection?.projectionVersion,
    policyVersion: terminalProjection?.policyVersion,
    ...extra,
  };
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingCommands.delete(id);
      reject(new Error('command timed out'));
    }, 10_000);
    pendingCommands.set(id, {
      resolve: (result) => {
        clearTimeout(timeout);
        if (result.outcome === 'accepted') resolve(result);
        else reject(new Error(result.reason || result.outcome || 'command rejected'));
      },
    });
    ws.send(JSON.stringify(message));
  });
}

function renderComposerState() {
  const sticky = terminalBannerEl.dataset.sticky === 'true';
  const enabled = Boolean(terminalMayInput && terminalProjection && controllerLease && nodeLeaseReady && !sticky && ws && ws.readyState === WebSocket.OPEN);
  terminalInputEl.disabled = !enabled;
  terminalSendTextEl.disabled = !enabled || terminalInputEl.value.length === 0;
  terminalSendEnterEl.disabled = !enabled;
}

function stopLeaseHeartbeat() {
  if (leaseHeartbeatTimer) clearInterval(leaseHeartbeatTimer);
  leaseHeartbeatTimer = null;
  nodeLeaseReady = false;
}

async function refreshRelayLease() {
  if (!terminalProjection || !nodeId) throw new Error('Terminal projection is not ready.');
  const res = await fetch('/relay/member/controller-lease', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-kookr-csrf-token': csrfToken || cookieValue('kookr_relay_csrf_token'),
    },
    credentials: 'include',
    body: JSON.stringify({
      nodeId,
      holderLabel: sanitizeDisplayName(nameEl.value),
      ttlMs: 30000,
      projectionId: terminalProjection.projectionId,
      sessionAlias: 'primary',
      projectionVersion: terminalProjection.projectionVersion,
      policyVersion: terminalProjection.policyVersion,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'controller lease failed');
  }
  const body = await res.json();
  controllerLease = body.lease;
  return body.lease;
}

async function acquireControllerLease() {
  if (!terminalMayInput || !terminalProjection || nodeLeaseReady) return;
  try {
    const lease = await refreshRelayLease();
    await remoteCommand('leaseAcquire', {
      leaseId: lease.leaseId,
      payload: { leaseId: lease.leaseId },
    });
    nodeLeaseReady = true;
    setTerminalBanner('', false);
    renderComposerState();
    startLeaseHeartbeat();
  } catch (err) {
    nodeLeaseReady = false;
    setTerminalBanner(err instanceof Error ? err.message : 'Controller lease failed.', true);
  }
}

function startLeaseHeartbeat() {
  if (leaseHeartbeatTimer) return;
  leaseHeartbeatTimer = setInterval(() => {
    void (async () => {
      if (!controllerLease || !terminalProjection || !terminalMayInput) return;
      try {
        const lease = await refreshRelayLease();
        await remoteCommand('leaseHeartbeat', {
          leaseId: lease.leaseId,
          payload: { leaseId: lease.leaseId },
        });
        nodeLeaseReady = true;
        renderComposerState();
      } catch (err) {
        stopLeaseHeartbeat();
        setTerminalBanner(err instanceof Error ? err.message : 'Controller lease heartbeat failed.', true);
      }
    })();
  }, 10000);
}

async function issueRetryToken(leaseId, payload) {
  const payloadHash = await commandPayloadHash(payload);
  const res = await fetch('/relay/member/retry-tokens', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-kookr-csrf-token': csrfToken || cookieValue('kookr_relay_csrf_token'),
    },
    credentials: 'include',
    body: JSON.stringify({
      nodeId,
      leaseId,
      projectionVersion: terminalProjection?.projectionVersion,
      policyVersion: terminalProjection?.policyVersion,
      payloadHash,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'retry token failed');
  }
  const body = await res.json();
  return body.retryToken;
}

async function submitTerminalInput(appendNewline) {
  const text = terminalInputEl.value;
  if (!appendNewline && !text) return;
  if (!controllerLease || !terminalProjection) return;
  terminalSendTextEl.disabled = true;
  terminalSendEnterEl.disabled = true;
  try {
    const payload = { text, appendNewline };
    const retryToken = await issueRetryToken(controllerLease.leaseId, payload);
    await remoteCommand('submitMessage', {
      leaseId: controllerLease.leaseId,
      baseRevision: 0,
      lastSeenSeq: lastTerminalSeq,
      retryToken,
      payload,
    });
    terminalInputEl.value = '';
    setStatus('Terminal input sent.');
  } catch (err) {
    setTerminalBanner(err instanceof Error ? err.message : 'Terminal input failed.', true);
  } finally {
    renderComposerState();
  }
}

function resetTerminalStream(message) {
  terminalProjection = null;
  terminalStreamKey = '';
  lastTerminalSeq = 0;
  controllerLease = null;
  stopLeaseHeartbeat();
  if (terminalWs) {
    terminalWs.onclose = null;
    terminalWs.close();
    terminalWs = null;
  }
  terminalLiveStateEl.textContent = 'Waiting for terminal projection';
  if (message) setTerminalBanner(message, true);
  renderComposerState();
}

function projectionFromEvent(event) {
  const payload = event && event.payload;
  if (!payload || payload.type !== 'remote.shareSessionProjection.v1') return null;
  const projection = payload.projection || {};
  const primary = projection.primarySharedSession || {};
  if (projection.projectionId && primary.sessionAlias === 'primary') {
    return {
      projectionId: projection.projectionId,
      projectionVersion: projection.projectionVersion || 0,
      policyVersion: projection.policyVersion || 0,
      nodeEpoch: projection.nodeInstanceId || '',
    };
  }
  return null;
}

async function connectTerminalStream() {
  if (!nodeId || !terminalMayView || !terminalProjection) return;
  const key = terminalProjection.projectionId + ':' + terminalProjection.projectionVersion;
  if (terminalWs && terminalStreamKey === key) return;
  if (terminalWs) {
    terminalWs.onclose = null;
    terminalWs.close();
  }
  terminalStreamKey = key;
  ensureTerminal();
  terminalLiveStateEl.textContent = 'Connecting';
  const wsUrl = new URL('/relay/client', location.href);
  wsUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  wsUrl.searchParams.set('nodeId', nodeId);
  wsUrl.searchParams.set('projectionId', terminalProjection.projectionId);
  wsUrl.searchParams.set('sessionAlias', 'primary');
  wsUrl.searchParams.set('afterSeq', String(lastTerminalSeq));
  const nonce = await takeWebSocketNonce();
  if (!nonce) {
    setTerminalBanner('Terminal stream authorization expired. Refresh the page and try again.', true);
    return;
  }
  wsUrl.searchParams.set('wsNonce', nonce);
  const nextTerminalWs = new WebSocket(wsUrl);
  terminalWs = nextTerminalWs;
  nextTerminalWs.onopen = () => {
    if (terminalWs !== nextTerminalWs) return;
    terminalStreamOpenedAtMs = Date.now();
    terminalLiveStateEl.textContent = 'Live';
    if (!terminalBannerEl.hidden && !terminalBannerEl.className.includes('blocked') && terminalBannerEl.dataset.sticky !== 'true') setTerminalBanner('', false);
  };
  nextTerminalWs.onclose = (event) => {
    if (terminalWs !== nextTerminalWs) return;
    terminalWs = null;
    terminalLiveStateEl.textContent = 'Disconnected';
    if (event.code === 4001) {
      setTerminalBanner('Terminal sharing was revoked.', true);
    } else if (event.code === 4002) {
      setTerminalBanner('This share expired.', true);
    } else if (event.code === 4004 || event.code === 1008) {
      resetTerminalStream('Terminal projection changed. Waiting for fresh terminal output.');
    } else {
      setTerminalBanner('Terminal stream disconnected. Reconnecting when the owner node is available.', true);
    }
  };
  nextTerminalWs.onmessage = (msg) => {
    if (terminalWs !== nextTerminalWs) return;
    try { ingest(JSON.parse(msg.data)); } catch {}
  };
}

function ingestTerminal(event) {
  if (!event || typeof event !== 'object') return;
  ensureTerminal();
  if (event.kind === 'terminal.bytes' && event.payload && event.payload.encoding === 'base64') {
    const raw = atob(event.payload.data || '');
    const bytes = Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
    writeTerminal(bytes);
    if (typeof event.seq === 'number') lastTerminalSeq = Math.max(lastTerminalSeq, event.seq);
    terminalLiveStateEl.textContent = 'Live';
    const eventTs = typeof event.ts === 'string' ? Date.parse(event.ts) : NaN;
    const freshAfterReplayGap = terminalBannerEl.dataset.sticky === 'true'
      && (Number.isNaN(eventTs) || eventTs >= terminalStreamOpenedAtMs);
    if (!terminalBannerEl.hidden && !terminalBannerEl.className.includes('blocked') && (terminalBannerEl.dataset.sticky !== 'true' || freshAfterReplayGap)) setTerminalBanner('', false);
    renderComposerState();
  } else if (event.kind === 'terminal.replay-gap' && event.payload) {
    if (typeof event.payload.toSeq === 'number') lastTerminalSeq = Math.max(lastTerminalSeq, event.payload.toSeq);
    writeTerminal('\\r\\n\\x1b[33m[terminal replay gap: missing seq ' + event.payload.fromSeq + '-' + event.payload.toSeq + ']\\x1b[0m\\r\\n');
    terminalLiveStateEl.textContent = 'Replay gap';
    setTerminalBanner('Terminal replay gap detected. Input remains disabled until fresh terminal output arrives.', false);
    terminalBannerEl.dataset.sticky = 'true';
    renderComposerState();
  }
}

function renderMemberShareState(memberState) {
  if (!memberState || memberState.schemaVersion !== 'member-share-state.v1') return;
  if (memberState.nodeId) {
    nodeId = memberState.nodeId;
    sessionStorage.setItem(nodeKey, nodeId);
  }
  const terminal = memberState.terminal || {};
  terminalStatusEl.hidden = false;
  terminalStatusEl.className = terminal.state === 'blocked' ? 'request blocked' : 'request';
  grantRequestEl.hidden = true;
  requestControlEl.disabled = false;
  notifyApprovalEl.disabled = false;
  terminalMayView = terminal.state === 'available' || terminal.state === 'viewOnly';
  terminalMayInput = terminal.state === 'available';
  if (terminal.state === 'available') {
    terminalStatusTitleEl.textContent = 'Terminal input approved';
    terminalStatusCopyEl.textContent = memberState.controllerLease && memberState.controllerLease.state === 'heldByAnotherDevice'
      ? 'Terminal input is approved, but control is held from another device.'
      : 'You can watch this shared task terminal and send semantic input.';
    stopStatePolling();
    ensureTerminal();
    void connectTerminalStream();
    void acquireControllerLease();
  } else if (terminal.state === 'viewOnly') {
    terminalStatusTitleEl.textContent = 'Terminal viewing approved';
    terminalStatusCopyEl.textContent = 'You can watch this shared task terminal. Sending messages still needs owner approval.';
    stopStatePolling();
    stopLeaseHeartbeat();
    ensureTerminal();
    void connectTerminalStream();
  } else if (terminal.state === 'pendingApproval') {
    terminalStatusTitleEl.textContent = 'Terminal request pending';
    terminalStatusCopyEl.textContent = 'Waiting for owner approval.';
    startStatePolling('Polling for approval.');
    stopLeaseHeartbeat();
    resetTerminalStream('');
  } else if (terminal.state === 'denied') {
    terminalStatusTitleEl.textContent = 'Terminal request denied';
    terminalStatusCopyEl.textContent = 'The owner denied terminal input for this share.';
    stopStatePolling();
    grantRequestEl.hidden = false;
    grantRequestCopyEl.textContent = 'You can send another terminal input request after the cooldown.';
    resetTerminalStream('Terminal access is denied for this share.');
  } else if (terminal.state === 'revoked') {
    terminalStatusTitleEl.textContent = 'Share revoked';
    terminalStatusCopyEl.textContent = 'This share is no longer active.';
    stopStatePolling();
    resetTerminalStream('Terminal sharing was revoked.');
  } else if (terminal.state === 'expired') {
    terminalStatusTitleEl.textContent = 'Share expired';
    terminalStatusCopyEl.textContent = 'This share is no longer active.';
    stopStatePolling();
    resetTerminalStream('This share expired.');
  } else {
    terminalStatusTitleEl.textContent = terminal.reason === 'policy.grantRequired' ? 'Terminal input not approved' : 'Terminal sharing unavailable';
    terminalStatusCopyEl.textContent = terminal.message || 'Terminal sharing is not available for this session.';
    resetTerminalStream(terminal.message || 'Terminal sharing is not available for this session.');
    if (terminal.reason === 'policy.grantRequired') {
      stopStatePolling();
      grantRequestEl.hidden = false;
      grantRequestCopyEl.textContent = 'Terminal input requires owner approval.';
    } else if (terminal.reason === 'node.offline' || terminal.reason === 'policy.syncPending' || terminal.reason === 'policy.syncTimedOut' || terminal.reason === 'policy.syncStale' || terminal.reason === 'policy.syncFailed') {
      startStatePolling('Polling for share status.');
    } else {
      stopStatePolling();
    }
    if (terminal.reason === 'node.offline') renderOfflineNode(memberState.node);
  }
  renderComposerState();
}

function ingest(event) {
  if (event && event.type === 'relay.memberShareState') {
    renderMemberShareState(event.state);
    return;
  }
  if (event && event.type === 'remote.command.result' && typeof event.commandId === 'string') {
    const pending = pendingCommands.get(event.commandId);
    if (pending) {
      pendingCommands.delete(event.commandId);
      pending.resolve(event);
    }
    if (event.action === 'submitMessage') {
      setStatus(event.outcome === 'accepted' ? 'Terminal input accepted.' : (event.reason || 'Terminal input rejected.'), event.outcome !== 'accepted');
    }
    return;
  }
  if (event && typeof event === 'object' && String(event.kind || '').startsWith('terminal.')) {
    ingestTerminal(event);
    return;
  }
  const nextProjection = projectionFromEvent(event);
  if (nextProjection) {
    const changed = !terminalProjection
      || terminalProjection.projectionId !== nextProjection.projectionId
      || terminalProjection.projectionVersion !== nextProjection.projectionVersion;
    const replacedExistingProjection = Boolean(terminalProjection) && changed;
    terminalProjection = nextProjection;
    if (changed) {
      lastTerminalSeq = 0;
      terminalLiveStateEl.textContent = 'Terminal projection ready';
      if (replacedExistingProjection) {
        setTerminalBanner('Terminal projection changed. Input remains disabled until fresh terminal output arrives.', true);
      }
    }
    void connectTerminalStream();
    void acquireControllerLease();
    renderComposerState();
    return;
  }
  const payload = event && event.payload;
  if (payload && payload.type === 'remote.taskProjection.v1') {
    renderProjection(payload.projection);
    setStatus('Live view-only task projection');
  }
}

async function loadState() {
  try {
    const memberState = await fetch('/relay/member/share-state', { credentials: 'include' });
    if (memberState.ok) {
      const body = await memberState.json();
      applySecurity(body);
      renderMemberShareState(body.state);
      if (body.state && body.state.nodeId) nodeId = body.state.nodeId;
    }
  } catch {
    // Member state is the richer status path; older/failed relays can still
    // load the legacy dashboard state below.
  }
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

async function resumeExistingSession() {
  if (await loadState()) {
    formEl.hidden = true;
    void connect();
    return true;
  }
  return false;
}

async function connect() {
  if (!nodeId) return;
  if (ws) ws.close();
  const wsUrl = new URL('/relay/client', location.href);
  wsUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  wsUrl.searchParams.set('nodeId', nodeId);
  const nonce = await takeWebSocketNonce();
  if (!nonce) {
    setStatus('Share session authorization expired. Refresh the page and try again.', true);
    return;
  }
  wsUrl.searchParams.set('wsNonce', nonce);
  ws = new WebSocket(wsUrl);
  ws.onopen = () => {
    setStatus('Connected. Waiting for task projection...');
    renderComposerState();
    void acquireControllerLease();
  };
  ws.onclose = () => {
    if (!taskEl.hidden) setStatus('Disconnected. Access may have been revoked or expired.', true);
    stopLeaseHeartbeat();
    renderComposerState();
  };
  ws.onmessage = (msg) => { try { ingest(JSON.parse(msg.data)); } catch {} };
}

async function acceptInvite() {
  const shareId = normalizeShareId(shareIdEl.value);
  const password = sharePasswordEl.value;
  if (!inviteToken && (!shareId || !password)) {
    if (nodeId) {
      if (await loadState()) void connect();
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
  applySecurity(body);
  nodeId = typeof body.nodeId === 'string' ? body.nodeId : '';
  if (nodeId) sessionStorage.setItem(nodeKey, nodeId);
  if (await loadState()) void connect();
  formEl.hidden = true;
}

requestControlEl.addEventListener('click', async () => {
  if (!nodeId) return;
  requestControlEl.disabled = true;
  setStatus('Requesting owner approval...');
  const res = await fetch('/relay/member/grant-requests', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-kookr-csrf-token': csrfToken || cookieValue('kookr_relay_csrf_token'),
    },
    credentials: 'include',
    body: JSON.stringify({
      nodeId,
      grants: ['terminalView', 'terminalInput'],
      comment: sanitizeDisplayName(nameEl.value) + ' requested terminal viewing and input',
    }),
  });
  if (!res.ok) {
    setStatus('Control request failed or expired.', true);
    requestControlEl.disabled = false;
    return;
  }
  grantRequestEl.hidden = true;
  terminalStatusEl.hidden = false;
  terminalStatusEl.className = 'request';
  terminalStatusTitleEl.textContent = 'Terminal request pending';
  terminalStatusCopyEl.textContent = 'Waiting for owner approval.';
  startStatePolling('Polling for approval.');
  setStatus('Waiting for owner approval.');
});

terminalInputEl.addEventListener('input', renderComposerState);
terminalSendTextEl.addEventListener('click', () => {
  void submitTerminalInput(false);
});
terminalSendEnterEl.addEventListener('click', () => {
  void submitTerminalInput(true);
});
notifyApprovalEl.addEventListener('click', () => {
  void enableApprovalNotification();
});

formEl.addEventListener('submit', (event) => {
  event.preventDefault();
  void acceptInvite();
});

if (!inviteToken) {
  void resumeExistingSession().then((resumed) => {
    if (!resumed && nodeId) void acceptInvite();
  });
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

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';

import { WebSocket, WebSocketServer } from 'ws';

import { isNodeHello, makeRelayHello, REMOTE_PROTOCOL_VERSION, type NodeHello } from '../src/remote/handshake.js';
import type { CommandOutcome, CommandResult, RemoteCommandAction } from '../src/remote/command-journal.js';
import { isRemoteControlEvent, type RemoteControlEvent } from '../src/remote/control-events.js';
import { asGrantId, asNodeId, asSeq, asSessionEpoch, asSessionId, type GrantId, type NodeEpoch, type NodeId, type Seq, type SessionEpoch, type SessionId } from '../src/remote/ids.js';
import type { PolicyGrantRecord, PolicyRevokeMessage, ShareGrant, ShareSubject } from '../src/remote/policy-sync.js';
import { grantForRemoteCommandAction, isKnownGrant, type KnownGrant } from '../src/remote/grants.js';
import { isTerminalStreamEvent, type TerminalReplayGapEvent, type TerminalStreamEvent } from '../src/remote/stream-events.js';
import { isPushAlertDeltaPayload, makeRedactedPushPayload } from '../src/remote/push.js';
import { InvitationStore, type InvitationRecord } from './src/invitations/store.js';
import { createPushFanout, type PushDeliveryOutcome, type PushFanout, type PushSender } from './src/push/fanout.js';
import { createPushSubscriptionStore, isPushSubscription, type PushSubscriptionStore, type StoredPushSubscription } from './src/push/subscriptions.js';
import { createVapidKeyStore, type VapidKeyStore } from './src/push/vapid.js';

interface NodeRegistration {
  nodeId: NodeId;
  ownerId: string;
  displayName: string;
  tokenHash: string;
  createdAt: string;
  lastSeen?: string;
}

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
  clientToken?: string;
  ownerId?: string;
  allowInsecureAdmin?: boolean;
  allowInsecureClients?: boolean;
  pushDisabled?: boolean;
  pushSender?: PushSender;
  pushSubject?: string;
  streamBackpressureBytes?: number;
  terminalReplayMaxEvents?: number;
}

export interface RelayServerHandle {
  httpServer: Server;
  url(): string;
  registerNode(opts?: { displayName?: string; ownerId?: string }): { nodeId: NodeId; nodeToken: string };
  createInvitation(opts: { nodeId: NodeId; subject?: ShareSubject; grants: ShareGrant[]; ttlMs?: number }): { invitation: InvitationRecord; token: string };
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

function issueNodeToken(): string {
  return `kookr_tok_v1_${randomBytes(24).toString('base64url')}`;
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
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

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendText(res: ServerResponse, status: number, contentType: string, text: string): void {
  res.writeHead(status, { 'content-type': contentType });
  res.end(text);
}

function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim();
}

function isAuthorizedAdmin(req: IncomingMessage, adminToken: string | undefined): boolean {
  if (!adminToken) return false;
  return bearer(req) === adminToken;
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
  const memberToken = url?.searchParams.get('memberToken') ?? bearer(req);
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

function authAllows(auth: RelayClientAuth, grant: KnownGrant | null): boolean {
  if (auth.kind === 'owner' || auth.grants.includes('admin')) return true;
  if (auth.expiresAt && Date.parse(auth.expiresAt) <= Date.now()) return false;
  if (!grant) return false;
  return auth.grants.some((candidate) => candidate === grant && isKnownGrant(candidate));
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
  const registrations = new Map<NodeId, NodeRegistration>();
  const tokenIndex = new Map<string, NodeRegistration>();
  const nodeSockets = new Map<NodeId, WebSocket>();
  const nodeHello = new Map<NodeId, NodeHello>();
  const subscribers = new Map<NodeId, Set<RelayClientSubscription>>();
  const presence = new Map<NodeId, Map<string, PresenceMember>>();
  const replay = new Map<NodeId, RemoteControlEvent[]>();
  const terminalReplay = new Map<NodeId, Map<string, TerminalStreamEvent[]>>();
  const metadataAudit: RelayMetadataAuditRow[] = [];
  const invitations = new InvitationStore();
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

  const registerNode = (regOpts: { displayName?: string; ownerId?: string } = {}) => {
    const nodeId = asNodeId(`kookr-node-${randomUUID()}`);
    const nodeToken = issueNodeToken();
    const registration: NodeRegistration = {
      nodeId,
      ownerId: regOpts.ownerId ?? ownerId,
      displayName: regOpts.displayName ?? nodeId,
      tokenHash: tokenHash(nodeToken),
      createdAt: new Date().toISOString(),
    };
    registrations.set(nodeId, registration);
    tokenIndex.set(registration.tokenHash, registration);
    return { nodeId, nodeToken };
  };

  const createInvitation = (input: { nodeId: NodeId; subject?: ShareSubject; grants: ShareGrant[]; ttlMs?: number }) => (
    invitations.create(input)
  );

  const acceptInvitation = (token: string, acceptedBy?: string) => {
    const accepted = invitations.accept(token, acceptedBy);
    if (accepted.ok) sendPolicyDelta(accepted.accepted.invitation.nodeId, accepted.accepted.policyGrant);
    return accepted;
  };

  const revokeInvitation = (invitationId: string) => {
    const revoked = invitations.revoke(invitationId);
    if (revoked.ok) {
      closeRevokedSubscribers(revoked.invitation);
      sendPolicyRevoke(revoked.invitation);
    }
    return revoked;
  };

  const sendPolicyDelta = (nodeId: NodeId, grant: PolicyGrantRecord): void => {
    const ws = nodeSockets.get(nodeId);
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({
      type: 'policy.delta',
      nodeId,
      policyVersion: grant.policyVersion,
      upserts: [grant],
      revokes: [],
    }));
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
    ws.send(JSON.stringify(msg));
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

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { status: 'ok', dbReachable: true, tlsExpiresAt: null, version: 'dev' });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/relay/dashboard') {
        sendHtml(res, 200, relayDashboardHtml());
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
        if (!authenticateClient(req, opts, invitations, registrations.get(asNodeId(nodeId))?.ownerId ?? ownerId, asNodeId(nodeId), url)) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const encrypted = Boolean((req.socket as typeof req.socket & { encrypted?: boolean }).encrypted);
        const relayHostFingerprint = createHash('sha256')
          .update(`${req.headers.host ?? 'unknown'}:${encrypted ? 'tls' : 'plain'}`)
          .digest('hex')
          .slice(0, 16);
        const terminal = parseTerminalSubscription(url);
        const afterSeq = parseSeq(url.searchParams.get('afterSeq')) ?? asSeq(0);
        const terminalEvents = terminal
          ? collectTerminalReplayEvents(asNodeId(nodeId), terminal.sessionId, terminal.sessionEpoch, afterSeq)
          : [];
        sendJson(res, 200, {
          nodeId,
          relayHostFingerprint,
          events: replay.get(asNodeId(nodeId)) ?? [],
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
        sendJson(res, 201, {
          invitation: created.invitation,
          token: created.token,
          acceptUrl: `/relay/dashboard?inviteToken=${encodeURIComponent(created.token)}`,
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
        sendJson(res, 200, {
          invitation: accepted.accepted.invitation,
          memberToken: accepted.accepted.memberToken,
        });
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
      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
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
        registration.lastSeen = new Date().toISOString();
        ws.send(JSON.stringify(makeRelayHello({
          outcome: 'accepted',
          acceptedVersion: REMOTE_PROTOCOL_VERSION,
          enabledFeatures: parsed.supportedFeatures,
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
        registration.lastSeen = new Date().toISOString();
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
        registration.lastSeen = new Date().toISOString();
        routeTerminalStreamEvent(parsed);
        return;
      }

      if (
        isRemoteCommandResultMessage(parsed)
        && nodeSockets.get(registration.nodeId) === ws
      ) {
        registration.lastSeen = new Date().toISOString();
        routeCommandResult(registration.nodeId, parsed);
      }
    });
    ws.on('close', () => {
      if (nodeSockets.get(registration.nodeId) === ws) {
        nodeSockets.delete(registration.nodeId);
        registration.lastSeen = new Date().toISOString();
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
    const encoded = JSON.stringify(event);
    for (const sub of [...subscribed]) {
      if (!subscriptionStillAuthorized(event.nodeId, sub)) continue;
      if (sub.ws.readyState === sub.ws.OPEN) sub.ws.send(encoded);
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
    for (const sub of [...subscribed]) {
      if (!subscriptionStillAuthorized(nodeId, sub)) continue;
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
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
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
      if (!authAllows(auth, requiredGrant)) {
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
      for (const ws of [...nodeSockets.values()]) ws.close(1001, 'relay closing');
      for (const set of subscribers.values()) {
        for (const sub of set) sub.ws.close(1001, 'relay closing');
      }
      nodeWss.close();
      clientWss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
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
let nodeId = params.get('nodeId') || '';
const clientToken = params.get('clientToken') || '';
const inviteToken = params.get('inviteToken') || params.get('token') || '';
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
let memberToken = localStorage.getItem('kookr-relay-member-token:' + location.host) || '';
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
  memberToken = body.memberToken || '';
  if (memberToken) localStorage.setItem('kookr-relay-member-token:' + location.host, memberToken);
  if (!nodeId && body.invitation?.nodeId) nodeId = body.invitation.nodeId;
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
  inviteOutputEl.textContent = location.origin + '/relay/dashboard?inviteToken=' + encodeURIComponent(body.token);
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
    if (memberToken) stateUrl.searchParams.set('memberToken', memberToken);
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
  if (memberToken) wsUrl.searchParams.set('memberToken', memberToken);
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

if (process.argv[1]?.endsWith('/relay/server.ts') || process.argv[1]?.endsWith('/relay/server.js')) {
  const port = Number.parseInt(process.env.PORT ?? '8080', 10);
  const adminToken = process.env.KOOKR_RELAY_ADMIN_TOKEN;
  const clientToken = process.env.KOOKR_RELAY_CLIENT_TOKEN;
  const allowInsecureAdmin = process.env.KOOKR_RELAY_INSECURE_DEV === '1';
  if (!adminToken && !allowInsecureAdmin) {
    console.error('[relay] KOOKR_RELAY_ADMIN_TOKEN is required. Set KOOKR_RELAY_INSECURE_DEV=1 only for local development.');
    process.exit(1);
  }
  const relay = createRelayServer({
    adminToken,
    clientToken,
    allowInsecureAdmin,
    allowInsecureClients: allowInsecureAdmin,
  });
  relay.httpServer.listen(port, '0.0.0.0', () => {
    console.log(`[relay] listening on http://0.0.0.0:${port}`);
  });
}

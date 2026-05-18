import { once } from 'node:events';
import { createHash } from 'node:crypto';

import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import { createRelayServer, type RelayServerHandle } from '../server.js';
import { makeNodeHello, type RelayHello } from '../../src/remote/handshake.js';
import { asGrantId, asNodeEpoch, asNodeId, asPolicyVersion } from '../../src/remote/ids.js';
import type { InvitationRecord } from '../src/invitations/store.js';
import type { PersistedNodeRegistration, RelayStateSnapshot } from '../src/state/sqlite.js';

let openHandle: RelayServerHandle | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) {
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
  }
  if (openHandle) {
    await openHandle.close();
    openHandle = null;
  }
});

async function startRelay(opts: Parameters<typeof createRelayServer>[0] = {}): Promise<RelayServerHandle> {
  const relay = createRelayServer({ adminToken: 'admin-secret', ...opts });
  openHandle = relay;
  await new Promise<void>((resolve) => relay.httpServer.listen(0, '127.0.0.1', () => resolve()));
  return relay;
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      void Promise.resolve(predicate()).then((matched) => {
        if (matched) {
          clearInterval(timer);
          resolve();
          return;
        }
        if (Date.now() - started > 2_000) {
          clearInterval(timer);
          reject(new Error('timed out waiting for condition'));
        }
      }).catch((err: unknown) => {
        clearInterval(timer);
        reject(err);
      });
    }, 10);
  });
}

function nodeHeaders(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` };
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function cookieHeaderFromSetCookie(setCookie: string): string {
  return setCookie
    .split(/,\s*(?=kookr_relay_)/)
    .map((part) => part.split(';')[0])
    .join('; ');
}

function cookieValue(header: string, name: string): string {
  const match = new RegExp(`${name}=([^;]+)`).exec(header);
  return match ? decodeURIComponent(match[1] ?? '') : '';
}

async function memberWebSocketNonce(relay: RelayServerHandle, cookie: string): Promise<string> {
  const res = await fetch(new URL('/relay/member/share-state', relay.url()), { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = await res.json() as { security?: { webSocketNonce?: string } };
  expect(body.security?.webSocketNonce).toBeTruthy();
  return body.security!.webSocketNonce!;
}

async function connectMember(relay: RelayServerHandle, nodeId: string, memberToken: string, cookie?: string): Promise<WebSocket> {
  const memberCookie = cookie ?? `kookr_relay_member_token=${memberToken}`;
  const nonce = await memberWebSocketNonce(relay, memberCookie);
  const wsUrl = new URL('/relay/client', relay.url());
  wsUrl.protocol = 'ws:';
  wsUrl.searchParams.set('nodeId', nodeId);
  wsUrl.searchParams.set('wsNonce', nonce);
  const ws = new WebSocket(wsUrl, { headers: { origin: relay.url(), cookie: memberCookie } });
  sockets.push(ws);
  await once(ws, 'open');
  return ws;
}

async function connectNode(relay: RelayServerHandle, nodeId: string, token: string): Promise<WebSocket> {
  const wsUrl = new URL('/relay/node', relay.url());
  wsUrl.protocol = 'ws:';
  const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } });
  sockets.push(ws);
  await once(ws, 'open');
  ws.send(JSON.stringify(makeNodeHello({
    nodeId: nodeId as ReturnType<typeof makeNodeHello>['nodeId'],
    nodeEpoch: asNodeEpoch('1'),
    softwareVersion: 'test',
  })));
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for relay hello')), 1_000);
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as RelayHello;
      if (msg.type === 'relay.hello') {
        clearTimeout(timeout);
        expect(msg.outcome).toBe('accepted');
        resolve();
      }
    });
  });
  return ws;
}

function ackPolicyMessages(ws: WebSocket, nodeId: string): void {
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString()) as {
      type?: string;
      policyVersion?: number;
      upserts?: Array<{ grantId: string }>;
      grants?: Array<{ grantId: string }>;
      revokes?: string[];
      revokedGrantIds?: string[];
    };
    if (msg.type !== 'policy.delta' && msg.type !== 'policy.sync' && msg.type !== 'policy.revoke') return;
    ws.send(JSON.stringify({
      type: 'policy.delta.ack',
      nodeId,
      policyVersion: msg.policyVersion,
      appliedGrantIds: (msg.upserts ?? msg.grants ?? []).map((grant) => grant.grantId),
      revokedGrantIds: msg.revokes ?? msg.revokedGrantIds ?? [],
    }));
  });
}

function publishSessionProjection(ws: WebSocket, opts: { nodeId: string; invitationId: string; policyVersion: number }): void {
  ws.send(JSON.stringify({
    nodeId: opts.nodeId,
    nodeEpoch: '1',
    serverRevision: 1,
    ts: new Date().toISOString(),
    kind: 'snapshot',
    payload: {
      type: 'remote.shareSessionProjection.v1',
      invitationId: opts.invitationId,
      projection: {
        schemaVersion: 'share-session-projection.v1',
        nodeId: opts.nodeId,
        nodeInstanceId: '1',
        projectionId: 'proj-primary',
        projectionVersion: 1,
        policyVersion: opts.policyVersion,
        generatedAt: new Date().toISOString(),
        primarySharedSession: {
          sessionAlias: 'primary',
          sessionId: 'session-1',
          sessionEpoch: '1',
        },
      },
    },
  }));
}

describe('relay node-scoped task-share endpoints', () => {
  it('returns the node ID bound to a node token', async () => {
    const relay = await startRelay();
    const { nodeId, nodeToken } = relay.registerNode({ displayName: 'Desktop' });

    const res = await fetch(new URL('/relay/node/status', relay.url()), {
      headers: nodeHeaders(nodeToken),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ nodeId, displayName: 'Desktop' });
  });

  it('rejects node status reads without a valid node token', async () => {
    const relay = await startRelay();
    relay.registerNode();

    const res = await fetch(new URL('/relay/node/status', relay.url()), {
      headers: nodeHeaders('not-a-real-token'),
    });

    expect(res.status).toBe(401);
  });

  it('requires admin auth for pairing and rotates node tokens by invalidating the old token', async () => {
    const relay = await startRelay();

    const anonymousPair = await fetch(new URL('/relay/admin/nodes', relay.url()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Anonymous' }),
    });
    expect(anonymousPair.status).toBe(401);

    const paired = await fetch(new URL('/relay/admin/nodes', relay.url()), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer admin-secret' },
      body: JSON.stringify({ displayName: 'Desktop' }),
    });
    expect(paired.status).toBe(201);
    const issued = await paired.json() as { nodeId: string; nodeToken: string };
    expect(issued.nodeId).toMatch(/^kookr-node-/);
    expect(issued.nodeToken).toMatch(/^kookr_tok_v1_/);

    const rotated = await fetch(new URL(`/relay/admin/nodes/${issued.nodeId}/token/rotate`, relay.url()), {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret' },
    });
    expect(rotated.status).toBe(200);
    const newCredential = await rotated.json() as { nodeId: string; nodeToken: string };
    expect(newCredential.nodeId).toBe(issued.nodeId);
    expect(newCredential.nodeToken).not.toBe(issued.nodeToken);

    const oldTokenStatus = await fetch(new URL('/relay/node/status', relay.url()), {
      headers: nodeHeaders(issued.nodeToken),
    });
    expect(oldTokenStatus.status).toBe(401);

    const newTokenStatus = await fetch(new URL('/relay/node/status', relay.url()), {
      headers: nodeHeaders(newCredential.nodeToken),
    });
    expect(newTokenStatus.status).toBe(200);
    expect(await newTokenStatus.json()).toEqual({ nodeId: issued.nodeId, displayName: 'Desktop' });
  });

  it('supports hosted account/device pairing without relay admin credentials', async () => {
    const relay = createRelayServer({
      accountToken: 'account-secret',
      accountId: 'acct-1',
      hostedRelay: {
        enabled: true,
        operationalGatesMet: true,
        mode: 'available',
      },
    });
    openHandle = relay;
    await new Promise<void>((resolve) => relay.httpServer.listen(0, '127.0.0.1', () => resolve()));

    const anonymousPair = await fetch(new URL('/relay/account/nodes', relay.url()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Anonymous' }),
    });
    expect(anonymousPair.status).toBe(401);

    const paired = await fetch(new URL('/relay/account/nodes', relay.url()), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer account-secret' },
      body: JSON.stringify({ displayName: 'Hosted Desktop', deviceId: 'device-1' }),
    });
    expect(paired.status).toBe(201);
    const issued = await paired.json() as { nodeId: string; nodeToken: string };
    expect(issued.nodeId).toMatch(/^kookr-node-/);
    expect(issued.nodeToken).toMatch(/^kookr_tok_v1_/);

    const status = await fetch(new URL('/relay/node/status', relay.url()), {
      headers: nodeHeaders(issued.nodeToken),
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ nodeId: issued.nodeId, displayName: 'Hosted Desktop' });

    const rotated = await fetch(new URL(`/relay/account/nodes/${issued.nodeId}/token/rotate`, relay.url()), {
      method: 'POST',
      headers: { authorization: 'Bearer account-secret' },
    });
    expect(rotated.status).toBe(200);
    const newCredential = await rotated.json() as { nodeId: string; nodeToken: string };
    expect(newCredential.nodeId).toBe(issued.nodeId);
    expect(newCredential.nodeToken).not.toBe(issued.nodeToken);

    const oldTokenStatus = await fetch(new URL('/relay/node/status', relay.url()), {
      headers: nodeHeaders(issued.nodeToken),
    });
    expect(oldTokenStatus.status).toBe(401);

    const newTokenStatus = await fetch(new URL('/relay/node/status', relay.url()), {
      headers: nodeHeaders(newCredential.nodeToken),
    });
    expect(newTokenStatus.status).toBe(200);
    expect(await newTokenStatus.json()).toEqual({ nodeId: issued.nodeId, displayName: 'Hosted Desktop' });
  });

  it('keeps hosted account pairing inert until the operational gate is enabled', async () => {
    const relay = createRelayServer({ accountToken: 'account-secret' });
    openHandle = relay;
    await new Promise<void>((resolve) => relay.httpServer.listen(0, '127.0.0.1', () => resolve()));

    const paired = await fetch(new URL('/relay/account/nodes', relay.url()), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer account-secret' },
      body: JSON.stringify({ displayName: 'Hosted Desktop' }),
    });

    expect(paired.status).toBe(503);
    expect(await paired.json()).toEqual({ error: 'hosted-relay-unavailable' });
  });

  it('reports hosted ops status and metrics for tickets, rate limits, sockets, and 5xx modes', async () => {
    const relay = createRelayServer({
      adminToken: 'admin-secret',
      accountToken: 'account-secret',
      hostedRelay: {
        enabled: true,
        operationalGatesMet: true,
        mode: 'available',
        shareCreateLimitPerMinute: 1,
        deploymentOwner: 'ops@example.com',
        environment: 'production',
        tlsExpiresAt: '2026-08-01T00:00:00.000Z',
        relayUrl: 'https://relay.example.test',
      },
    });
    openHandle = relay;
    await new Promise<void>((resolve) => relay.httpServer.listen(0, '127.0.0.1', () => resolve()));
    const { nodeId, nodeToken } = relay.registerNode();
    await connectNode(relay, nodeId, nodeToken);

    const ops = await fetch(new URL('/relay/ops/status', relay.url()));
    expect(ops.status).toBe(200);
    const opsBody = await ops.json() as { guestLinkPosture?: { checkedAt?: string } };
    expect(opsBody).toMatchObject({
      configured: true,
      mode: 'available',
      deploymentOwner: 'ops@example.com',
      environment: 'production',
      tlsExpiresAt: '2026-08-01T00:00:00.000Z',
      guestLinkPosture: {
        checkedAt: expect.any(String),
        publicOrigin: { url: 'https://relay.example.test', https: true },
        securityHeaders: {
          cacheControlNoStore: true,
          referrerPolicyNoReferrer: true,
          contentTypeNosniff: true,
          frameAncestorsDenied: true,
        },
        webSocket: {
          originRequired: true,
          memberNonceRequired: true,
          nonceTtlMs: 60_000,
          compression: 'disabled',
          unknownMessageCloses: true,
          maxPayloadBytes: 16 * 1024,
        },
      },
    });
    expect(Number.isNaN(Date.parse(opsBody.guestLinkPosture?.checkedAt ?? ''))).toBe(false);

    const created = await fetch(new URL('/relay/node/invitations', relay.url()), {
      method: 'POST',
      headers: nodeHeaders(nodeToken),
      body: JSON.stringify({ subject: { kind: 'task', taskId: 'task-metrics' }, grants: ['view'] }),
    });
    expect(created.status).toBe(201);
    const rateLimited = await fetch(new URL('/relay/node/invitations', relay.url()), {
      method: 'POST',
      headers: nodeHeaders(nodeToken),
      body: JSON.stringify({ subject: { kind: 'task', taskId: 'task-rate' }, grants: ['view'] }),
    });
    expect(rateLimited.status).toBe(429);

    const metrics = await fetch(new URL('/relay/admin/metrics', relay.url()), {
      headers: { authorization: 'Bearer admin-secret' },
    });
    expect(metrics.status).toBe(200);
    expect(await metrics.json()).toEqual({
      metrics: expect.objectContaining({
        ticketsCreated: 1,
        rateLimitHits: 1,
        activeNodeSockets: 1,
        maxNodeHeartbeatAgeMs: expect.any(Number),
        policySyncFailures: 0,
        http5xxCount: 0,
      }),
      alerts: expect.arrayContaining([expect.objectContaining({ code: 'rate-limit-hits' })]),
    });
  });

  it('emergency-disables new shares without rejecting local relay status reads', async () => {
    const relay = createRelayServer({
      accountToken: 'account-secret',
      hostedRelay: {
        enabled: true,
        operationalGatesMet: true,
        mode: 'emergencyDisabled',
      },
    });
    openHandle = relay;
    await new Promise<void>((resolve) => relay.httpServer.listen(0, '127.0.0.1', () => resolve()));
    const { nodeToken } = relay.registerNode();

    const status = await fetch(new URL('/relay/node/status', relay.url()), {
      headers: nodeHeaders(nodeToken),
    });
    expect(status.status).toBe(200);

    const create = await fetch(new URL('/relay/node/invitations', relay.url()), {
      method: 'POST',
      headers: nodeHeaders(nodeToken),
      body: JSON.stringify({ subject: { kind: 'task', taskId: 'task-disabled' }, grants: ['view'] }),
    });
    expect(create.status).toBe(503);
    expect(await create.json()).toEqual({ error: 'hosted-relay-emergency-disabled' });

    const ops = await fetch(new URL('/relay/ops/status', relay.url()));
    expect(await ops.json()).toMatchObject({ mode: 'emergencyDisabled' });
  });

  it('closes an active node WebSocket authenticated with the old token after rotation', async () => {
    const relay = await startRelay();
    const { nodeId, nodeToken } = relay.registerNode({ displayName: 'Desktop' });
    const ws = await connectNode(relay, nodeId, nodeToken);

    const closeEvent = once(ws, 'close') as Promise<[number, Buffer]>;
    const rotated = await fetch(new URL(`/relay/admin/nodes/${nodeId}/token/rotate`, relay.url()), {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret' },
    });
    expect(rotated.status).toBe(200);

    const [code, reason] = await closeEvent;
    expect(code).toBe(4003);
    expect(reason.toString()).toBe('node token rotated');
  });

  it('creates a view-only task invitation authenticated by the node token', async () => {
    const relay = await startRelay();
    const { nodeId, nodeToken } = relay.registerNode();

    const res = await fetch(new URL('/relay/node/invitations', relay.url()), {
      method: 'POST',
      headers: nodeHeaders(nodeToken),
      body: JSON.stringify({ subject: { kind: 'task', taskId: 'task-42' }, grants: ['view'], ttlMs: 600_000 }),
    });

    expect(res.status).toBe(201);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const body = await res.json() as { invitation: Record<string, unknown>; token: string; shareTicket?: Record<string, unknown> };
    expect(body.token).toMatch(/^kookr_inv_v1_/);
    expect(body.shareTicket).toMatchObject({
      shareId: expect.stringMatching(/^\d{3}-\d{3}$/),
      password: expect.any(String),
      redactedShareLabel: expect.stringMatching(/^\d{3}-\*\*\*$/),
    });
    expect(body.invitation.nodeId).toBe(nodeId);
    expect(body.invitation.taskId).toBe('task-42');
    expect(body.invitation.grants).toEqual(['view']);
    expect(body.invitation.shareId).toBe(body.shareTicket?.shareId);
    expect(typeof body.invitation.invitationId).toBe('string');
    expect(typeof body.invitation.expiresAt).toBe('string');
    expect(body.invitation).not.toHaveProperty('password');
    // The safe node view must not leak relay-internal secrets/hashes.
    expect(body.invitation).not.toHaveProperty('tokenHash');
    expect(body.invitation).not.toHaveProperty('memberTokenHash');
    expect(body.invitation).not.toHaveProperty('grantId');
    expect(body.invitation.policyVersion).toBe(1);
    // The node endpoint never returns a query-string accept URL.
    expect(body).not.toHaveProperty('acceptUrl');
  });

  it('accepts a node-created share ticket without returning secrets in the response body', async () => {
    const relay = await startRelay();
    const { nodeId, nodeToken } = relay.registerNode();
    const created = await fetch(new URL('/relay/node/invitations', relay.url()), {
      method: 'POST',
      headers: nodeHeaders(nodeToken),
      body: JSON.stringify({ subject: { kind: 'task', taskId: 'task-ticket' }, grants: ['view'] }),
    });
    const body = await created.json() as { shareTicket: { shareId: string; password: string } };

    const accepted = await fetch(new URL('/relay/share-tickets/accept', relay.url()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shareId: body.shareTicket.shareId, password: body.shareTicket.password, displayName: 'viewer' }),
    });

    expect(accepted.status).toBe(200);
    expect(accepted.headers.get('set-cookie')).toContain('kookr_relay_member_token=');
    expect(accepted.headers.get('set-cookie')).toContain('Max-Age=');
    expect(await accepted.json()).toEqual(expect.objectContaining({ nodeId }));

    const second = await fetch(new URL('/relay/share-tickets/accept', relay.url()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shareId: body.shareTicket.shareId, password: body.shareTicket.password, displayName: 'viewer-2' }),
    });
    expect(second.status).toBe(200);
    expect(second.headers.get('set-cookie')).toContain('kookr_relay_member_token=');
    expect(second.headers.get('set-cookie')).toContain('Max-Age=');
    expect(await second.json()).toEqual(expect.objectContaining({ nodeId }));
  });

  it('locks bad share-ticket guesses without distinguishing unknown IDs from wrong passwords', async () => {
    const relay = await startRelay();
    const { nodeToken } = relay.registerNode();
    const created = await fetch(new URL('/relay/node/invitations', relay.url()), {
      method: 'POST',
      headers: nodeHeaders(nodeToken),
      body: JSON.stringify({ subject: { kind: 'task', taskId: 'task-lock' }, grants: ['view'] }),
    });
    const body = await created.json() as { invitation: { invitationId: string }; shareTicket: { shareId: string; password: string } };

    const wrongPassword = async (shareId: string) => fetch(new URL('/relay/share-tickets/accept', relay.url()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shareId, password: 'wrong-password', displayName: 'viewer' }),
    });

    const unknown = await wrongPassword('111-222');
    expect(unknown.status).toBe(409);
    expect(await unknown.json()).toEqual({ error: 'ticket-unavailable' });

    for (let i = 0; i < 5; i += 1) {
      const res = await wrongPassword(body.shareTicket.shareId);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'ticket-unavailable' });
    }

    const list = await fetch(new URL('/relay/node/invitations', relay.url()), {
      headers: { authorization: `Bearer ${nodeToken}` },
    });
    expect(await list.json()).toEqual({
      invitations: [expect.objectContaining({
        invitationId: body.invitation.invitationId,
        failedAcceptCount: 5,
        lockedUntil: expect.any(String),
        redactedShareLabel: expect.stringMatching(/^\d{3}-\*\*\*$/),
      })],
    });

    const correctAfterLock = await fetch(new URL('/relay/share-tickets/accept', relay.url()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shareId: body.shareTicket.shareId, password: body.shareTicket.password }),
    });
    expect(correctAfterLock.status).toBe(409);
    expect(await correctAfterLock.json()).toEqual({ error: 'ticket-unavailable' });

    const diagnostic = await fetch(new URL(`/relay/node/invitations/${body.invitation.invitationId}`, relay.url()), {
      headers: { authorization: `Bearer ${nodeToken}` },
    });
    expect(diagnostic.status).toBe(200);
    expect(await diagnostic.json()).toMatchObject({
      invitation: {
        invitationId: body.invitation.invitationId,
        failedAcceptCount: 5,
        lockedUntil: expect.any(String),
      },
      node: { connected: false },
    });

    const reset = await fetch(new URL(`/relay/node/invitations/${body.invitation.invitationId}/share-ticket/reset`, relay.url()), {
      method: 'POST',
      headers: nodeHeaders(nodeToken),
    });
    expect(reset.status).toBe(200);
    const resetBody = await reset.json() as { invitation: { failedAcceptCount?: number; lockedUntil?: string }; shareTicket: { shareId: string; password: string } };
    expect(resetBody.invitation.failedAcceptCount).toBe(0);
    expect(resetBody.invitation.lockedUntil).toBeUndefined();
    expect(resetBody.shareTicket.shareId).toBe(body.shareTicket.shareId);

    const acceptedAfterReset = await fetch(new URL('/relay/share-tickets/accept', relay.url()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shareId: resetBody.shareTicket.shareId, password: resetBody.shareTicket.password }),
    });
    expect(acceptedAfterReset.status).toBe(200);
  });

  it('protects share-ticket reset by node ownership and task-share scope', async () => {
    const relay = await startRelay();
    const nodeA = relay.registerNode();
    const nodeB = relay.registerNode();
    const created = await fetch(new URL('/relay/node/invitations', relay.url()), {
      method: 'POST',
      headers: nodeHeaders(nodeA.nodeToken),
      body: JSON.stringify({ subject: { kind: 'task', taskId: 'task-reset' }, grants: ['view'] }),
    });
    const body = await created.json() as { invitation: { invitationId: string } };
    const resetUrl = new URL(`/relay/node/invitations/${body.invitation.invitationId}/share-ticket/reset`, relay.url());

    const anonymous = await fetch(resetUrl, { method: 'POST' });
    expect(anonymous.status).toBe(401);

    const crossNode = await fetch(resetUrl, { method: 'POST', headers: nodeHeaders(nodeB.nodeToken) });
    expect(crossNode.status).toBe(404);

    const adminInvite = relay.createInvitation({
      nodeId: nodeA.nodeId,
      subject: { kind: 'task', nodeId: nodeA.nodeId, taskId: 'admin-task' },
      grants: ['view', 'comment'],
      shareTicket: true,
    });
    const nonA0 = await fetch(
      new URL(`/relay/node/invitations/${adminInvite.invitation.invitationId}/share-ticket/reset`, relay.url()),
      { method: 'POST', headers: nodeHeaders(nodeA.nodeToken) },
    );
    expect(nonA0.status).toBe(404);

    const owner = await fetch(resetUrl, { method: 'POST', headers: nodeHeaders(nodeA.nodeToken) });
    expect(owner.status).toBe(200);
  });

  it('uses trusted proxy client IP for share-ticket source lockout', async () => {
    const relay = createRelayServer({ adminToken: 'admin-secret', bindHost: '127.0.0.1' });
    openHandle = relay;
    await new Promise<void>((resolve) => relay.httpServer.listen(0, '127.0.0.1', () => resolve()));

    const attempt = async (xff: string) => fetch(new URL('/relay/share-tickets/accept', relay.url()), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': xff,
      },
      body: JSON.stringify({ shareId: '111-222', password: 'wrong-password' }),
    });

    for (let i = 0; i < 10; i += 1) {
      expect((await attempt('198.51.100.10')).status).toBe(409);
    }
    expect((await attempt('198.51.100.10')).status).toBe(409);
    expect((await attempt('198.51.100.11')).status).toBe(409);

    const metrics = await fetch(new URL('/relay/admin/metrics', relay.url()), {
      headers: { authorization: 'Bearer admin-secret' },
    });
    expect(metrics.status).toBe(200);
    const body = await metrics.json() as { metrics: { rateLimitHits: number; recent?: { rateLimitHits: number } } };
    expect(body.metrics.rateLimitHits).toBe(1);
    expect(body.metrics.recent?.rateLimitHits).toBe(1);
  });

  it('rejects requests with a missing or unknown node token', async () => {
    const relay = await startRelay();
    relay.registerNode();

    const noToken = await fetch(new URL('/relay/node/invitations', relay.url()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject: { kind: 'task', taskId: 't' }, grants: ['view'] }),
    });
    expect(noToken.status).toBe(401);

    const badToken = await fetch(new URL('/relay/node/invitations', relay.url()), {
      method: 'POST',
      headers: nodeHeaders('not-a-real-token'),
      body: JSON.stringify({ subject: { kind: 'task', taskId: 't' }, grants: ['view'] }),
    });
    expect(badToken.status).toBe(401);
  });

  it('rejects bad subjects and non-view grants', async () => {
    const relay = await startRelay();
    const { nodeToken } = relay.registerNode();

    const badBodies: unknown[] = [
      { subject: { kind: 'node' }, grants: ['view'] },
      { subject: { kind: 'task', taskId: '' }, grants: ['view'] },
      { subject: { kind: 'task', taskId: 't' }, grants: ['view', 'comment'] },
      { subject: { kind: 'task', taskId: 't' }, grants: ['comment'] },
      { subject: { kind: 'task', taskId: 't' }, grants: [] },
    ];
    for (const body of badBodies) {
      const res = await fetch(new URL('/relay/node/invitations', relay.url()), {
        method: 'POST',
        headers: nodeHeaders(nodeToken),
        body: JSON.stringify(body),
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('rejects out-of-range TTLs and accepts the boundary values', async () => {
    const relay = await startRelay();
    const { nodeToken } = relay.registerNode();

    for (const ttlMs of [10, -1, 48 * 60 * 60 * 1000]) {
      const res = await fetch(new URL('/relay/node/invitations', relay.url()), {
        method: 'POST',
        headers: nodeHeaders(nodeToken),
        body: JSON.stringify({ subject: { kind: 'task', taskId: 't' }, grants: ['view'], ttlMs }),
      });
      expect(res.status, `ttlMs=${ttlMs}`).toBe(400);
    }
    // Exact min/max bounds must be accepted (guards an off-by-one to <=/>=).
    // These literals mirror NODE_SHARE_MIN/MAX_TTL_MS in relay/server.ts,
    // which are module-private (the import boundary forbids sharing them).
    for (const ttlMs of [60_000, 24 * 60 * 60 * 1000]) {
      const res = await fetch(new URL('/relay/node/invitations', relay.url()), {
        method: 'POST',
        headers: nodeHeaders(nodeToken),
        body: JSON.stringify({ subject: { kind: 'task', taskId: 't' }, grants: ['view'], ttlMs }),
      });
      expect(res.status, `ttlMs=${ttlMs}`).toBe(201);
    }
  });

  it('honors an operator-configured max TTL up to the 31-day hard cap', async () => {
    const thirtyOneDays = 31 * 24 * 60 * 60 * 1000;
    const relay = await startRelay({ shareMaxTtlMs: 45 * 24 * 60 * 60 * 1000 });
    const { nodeId, nodeToken } = relay.registerNode();

    const wsUrl = new URL('/relay/node', relay.url());
    wsUrl.protocol = 'ws:';
    const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${nodeToken}` } });
    sockets.push(ws);
    await once(ws, 'open');
    const helloPromise = new Promise<RelayHello>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as RelayHello;
        if (msg.type === 'relay.hello') resolve(msg);
      });
    });
    ws.send(JSON.stringify(makeNodeHello({
      nodeId: nodeId as ReturnType<typeof makeNodeHello>['nodeId'],
      nodeEpoch: asNodeEpoch('1'),
      softwareVersion: 'test',
    })));
    const hello = await helloPromise;
    expect(hello.shareMaxTtlMs).toBe(thirtyOneDays);

    const overHardCap = await fetch(new URL('/relay/node/invitations', relay.url()), {
      method: 'POST',
      headers: nodeHeaders(nodeToken),
      body: JSON.stringify({ subject: { kind: 'task', taskId: 't' }, grants: ['view'], ttlMs: thirtyOneDays + 1 }),
    });
    expect(overHardCap.status).toBe(400);

    const atHardCap = await fetch(new URL('/relay/node/invitations', relay.url()), {
      method: 'POST',
      headers: nodeHeaders(nodeToken),
      body: JSON.stringify({ subject: { kind: 'task', taskId: 't' }, grants: ['view'], ttlMs: thirtyOneDays }),
    });
    expect(atHardCap.status).toBe(201);
  });

  it('parses KOOKR_RELAY_SHARE_MAX_TTL_MS from the startup environment', async () => {
    const previous = process.env.KOOKR_RELAY_SHARE_MAX_TTL_MS;
    process.env.KOOKR_RELAY_SHARE_MAX_TTL_MS = String(7 * 24 * 60 * 60 * 1000);
    try {
      const relay = await startRelay();
      const { nodeToken } = relay.registerNode();
      const accepted = await fetch(new URL('/relay/node/invitations', relay.url()), {
        method: 'POST',
        headers: nodeHeaders(nodeToken),
        body: JSON.stringify({ subject: { kind: 'task', taskId: 't' }, grants: ['view'], ttlMs: 7 * 24 * 60 * 60 * 1000 }),
      });
      expect(accepted.status).toBe(201);
      const rejected = await fetch(new URL('/relay/node/invitations', relay.url()), {
        method: 'POST',
        headers: nodeHeaders(nodeToken),
        body: JSON.stringify({ subject: { kind: 'task', taskId: 't' }, grants: ['view'], ttlMs: 8 * 24 * 60 * 60 * 1000 }),
      });
      expect(rejected.status).toBe(400);
    } finally {
      if (previous === undefined) delete process.env.KOOKR_RELAY_SHARE_MAX_TTL_MS;
      else process.env.KOOKR_RELAY_SHARE_MAX_TTL_MS = previous;
    }
  });

  it('revokes only the calling node\'s own invitations', async () => {
    const relay = await startRelay();
    const nodeA = relay.registerNode();
    const nodeB = relay.registerNode();

    const created = await fetch(new URL('/relay/node/invitations', relay.url()), {
      method: 'POST',
      headers: nodeHeaders(nodeA.nodeToken),
      body: JSON.stringify({ subject: { kind: 'task', taskId: 'task-7' }, grants: ['view'] }),
    });
    const { invitation } = await created.json() as { invitation: { invitationId: string } };

    // Node B must not be able to revoke node A's invitation — answered 404
    // so a node cannot probe for other nodes' invitation IDs.
    const crossNode = await fetch(
      new URL(`/relay/node/invitations/${invitation.invitationId}/revoke`, relay.url()),
      { method: 'POST', headers: nodeHeaders(nodeB.nodeToken) },
    );
    expect(crossNode.status).toBe(404);

    // The invitation is still active for node A.
    const owner = await fetch(
      new URL(`/relay/node/invitations/${invitation.invitationId}/revoke`, relay.url()),
      { method: 'POST', headers: nodeHeaders(nodeA.nodeToken) },
    );
    expect(owner.status).toBe(200);
    const revoked = await owner.json() as { invitation: { revokedAt?: string }; alreadyRevoked: boolean };
    expect(revoked.alreadyRevoked).toBe(false);
    expect(typeof revoked.invitation.revokedAt).toBe('string');
  });

  it('returns 404 for an unknown invitation id on revoke', async () => {
    const relay = await startRelay();
    const { nodeToken } = relay.registerNode();
    const res = await fetch(
      new URL('/relay/node/invitations/inv-does-not-exist/revoke', relay.url()),
      { method: 'POST', headers: nodeHeaders(nodeToken) },
    );
    expect(res.status).toBe(404);
  });

  it('reports alreadyRevoked on a repeated revoke', async () => {
    const relay = await startRelay();
    const { nodeToken } = relay.registerNode();
    const created = await fetch(new URL('/relay/node/invitations', relay.url()), {
      method: 'POST',
      headers: nodeHeaders(nodeToken),
      body: JSON.stringify({ subject: { kind: 'task', taskId: 'task-x' }, grants: ['view'] }),
    });
    const { invitation } = await created.json() as { invitation: { invitationId: string } };
    const revokeUrl = new URL(`/relay/node/invitations/${invitation.invitationId}/revoke`, relay.url());

    const first = await fetch(revokeUrl, { method: 'POST', headers: nodeHeaders(nodeToken) });
    expect((await first.json() as { alreadyRevoked: boolean }).alreadyRevoked).toBe(false);

    const second = await fetch(revokeUrl, { method: 'POST', headers: nodeHeaders(nodeToken) });
    expect(second.status).toBe(200);
    expect((await second.json() as { alreadyRevoked: boolean }).alreadyRevoked).toBe(true);
  });

  it('does not let the node endpoint revoke a non-A0 invitation', async () => {
    const relay = await startRelay();
    const { nodeId, nodeToken } = relay.registerNode();

    // An admin-minted multi-grant task invitation for this node is outside
    // the Phase A0 surface — the node endpoint must answer 404 rather than
    // revoke it (its capability would otherwise be misrepresented by the
    // view-only projection).
    const adminInvite = relay.createInvitation({
      nodeId,
      subject: { kind: 'task', nodeId, taskId: 'admin-task' },
      grants: ['view', 'comment'],
    });

    const revoke = await fetch(
      new URL(`/relay/node/invitations/${adminInvite.invitation.invitationId}/revoke`, relay.url()),
      { method: 'POST', headers: nodeHeaders(nodeToken) },
    );
    expect(revoke.status).toBe(404);
  });

  it('lists the calling node task shares with coarse connected state', async () => {
    const relay = await startRelay();
    const { nodeId, nodeToken } = relay.registerNode();
    const created = await fetch(new URL('/relay/node/invitations', relay.url()), {
      method: 'POST',
      headers: nodeHeaders(nodeToken),
      body: JSON.stringify({ subject: { kind: 'task', taskId: 'task-list' }, grants: ['view'] }),
    });
    const body = await created.json() as { invitation: { invitationId: string }; token: string };

    const waiting = await fetch(new URL('/relay/node/invitations', relay.url()), {
      headers: { authorization: `Bearer ${nodeToken}` },
    });
    expect(waiting.status).toBe(200);
    expect(await waiting.json()).toEqual({
      invitations: [expect.objectContaining({
        invitationId: body.invitation.invitationId,
        taskId: 'task-list',
        connectedViewerCount: 0,
      })],
    });

    const accepted = relay.acceptInvitation(body.token, 'viewer');
    if (!accepted.ok) throw new Error('expected accept');
    await connectMember(relay, nodeId, accepted.accepted.memberToken);

    const connected = await fetch(new URL('/relay/node/invitations', relay.url()), {
      headers: { authorization: `Bearer ${nodeToken}` },
    });
    expect(await connected.json()).toEqual({
      invitations: [expect.objectContaining({
        invitationId: body.invitation.invitationId,
        connectedViewerCount: 1,
        acceptedAt: expect.any(String),
      })],
    });
  });

  it('redacts member projection labels and reports offline nodes without stale projections', async () => {
    const relay = await startRelay();
    const { nodeId, nodeToken } = relay.registerNode();
    const nodeWs = await connectNode(relay, nodeId, nodeToken);
    const createdRes = await fetch(new URL('/relay/node/invitations', relay.url()), {
      method: 'POST',
      headers: nodeHeaders(nodeToken),
      body: JSON.stringify({
        subject: { kind: 'task', taskId: 'task-secret' },
        grants: ['view'],
        ttlMs: 24 * 60 * 60 * 1000,
        displayLabel: 'Review-safe label',
      }),
    });
    expect(createdRes.status).toBe(201);
    const created = await createdRes.json() as { token: string; invitation: { invitationId: string } };
    const accepted = relay.acceptInvitation(created.token, 'viewer');
    if (!accepted.ok) throw new Error('expected accept');

    nodeWs.send(JSON.stringify({
      nodeId,
      nodeEpoch: asNodeEpoch('1'),
      serverRevision: 1,
      ts: new Date().toISOString(),
      kind: 'snapshot',
      payload: {
        type: 'remote.taskProjection.v1',
        invitationId: created.invitation.invitationId,
        projection: {
          schemaVersion: 'remote-task-projection.v1',
          nodeId,
          taskId: 'task-secret',
          taskLabel: 'Secret payment incident',
          status: 'open',
          hasFinding: true,
          needsInput: false,
          updatedAt: '2026-05-17T00:00:00.000Z',
        },
      },
    }));

    const stateUrl = new URL('/relay/dashboard/state', relay.url());
    stateUrl.searchParams.set('nodeId', nodeId);
    await waitFor(async () => {
      const res = await fetch(stateUrl, {
        headers: { cookie: `kookr_relay_member_token=${accepted.accepted.memberToken}` },
      });
      const body = await res.json() as { events: Array<{ payload?: { projection?: { taskLabel?: string } } }> };
      return body.events.some((event) => event.payload?.projection?.taskLabel === 'Review-safe label');
    });

    const memberUrl = new URL('/relay/client', relay.url());
    memberUrl.protocol = 'ws:';
    memberUrl.searchParams.set('nodeId', nodeId);
    const memberCookie = `kookr_relay_member_token=${accepted.accepted.memberToken}`;
    memberUrl.searchParams.set('wsNonce', await memberWebSocketNonce(relay, memberCookie));
    const memberWs = new WebSocket(memberUrl, { headers: { origin: relay.url(), cookie: memberCookie } });
    sockets.push(memberWs);
    const replayed = await new Promise<{ payload?: { projection?: { taskLabel?: string } } }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for member replay')), 1_000);
      memberWs.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as { payload?: { projection?: { taskLabel?: string } } };
        if (msg.payload?.projection?.taskLabel) {
          clearTimeout(timeout);
          resolve(msg);
        }
      });
    });
    expect(replayed.payload?.projection?.taskLabel).toBe('Review-safe label');

    nodeWs.close();
    await waitFor(async () => {
      const res = await fetch(stateUrl, {
        headers: { cookie: `kookr_relay_member_token=${accepted.accepted.memberToken}` },
      });
      const body = await res.json() as { node?: { connected?: boolean; lastSeen?: string }; events: unknown[] };
      return body.node?.connected === false && typeof body.node.lastSeen === 'string' && body.events.length === 0;
    });

    const joinPage = await fetch(new URL('/relay/join', relay.url()));
    await expect(joinPage.text()).resolves.toContain("The shared task's machine is currently offline.");
  });

  it('blocks terminal input and control escalation for node-created Guest Links', async () => {
    const relay = await startRelay();
    const { nodeId, nodeToken } = relay.registerNode();
    const nodeWs = await connectNode(relay, nodeId, nodeToken);
    ackPolicyMessages(nodeWs, nodeId);
    const nodeMessages: unknown[] = [];
    nodeWs.on('message', (data) => nodeMessages.push(JSON.parse(data.toString()) as unknown));

    const createdRes = await fetch(new URL('/relay/node/invitations', relay.url()), {
      method: 'POST',
      headers: nodeHeaders(nodeToken),
      body: JSON.stringify({ subject: { kind: 'task', taskId: 'task-1' }, grants: ['view'] }),
    });
    expect(createdRes.status).toBe(201);
    const created = await createdRes.json() as { token: string; invitation: { invitationId: string } };
    const acceptRes = await fetch(new URL('/relay/invitations/accept', relay.url()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: created.token, displayName: 'Alice\u202e<script>' }),
    });
    expect(acceptRes.status).toBe(200);
    const cookie = cookieHeaderFromSetCookie(acceptRes.headers.get('set-cookie') ?? '');
    const csrfToken = cookieValue(cookie, 'kookr_relay_csrf_token');
    const member = await connectMember(relay, nodeId, cookieValue(cookie, 'kookr_relay_member_token'), cookie);
    const memberMessages: unknown[] = [];
    member.on('message', (data) => memberMessages.push(JSON.parse(data.toString()) as unknown));

    member.send(JSON.stringify({
      type: 'remote.command',
      commandId: 'cmd-before-approval',
      nodeId,
      nodeEpoch: '1',
      sessionId: 'session-1',
      sessionEpoch: '1',
      idempotencyKey: 'idem-before',
      action: 'submitMessage',
    }));
    await waitFor(() => memberMessages.some((msg) => (msg as { commandId?: string }).commandId === 'cmd-before-approval'));
    expect(memberMessages).toContainEqual(expect.objectContaining({
      commandId: 'cmd-before-approval',
      outcome: 'rejected-pre-audit',
      reason: 'missing terminalInput grant',
    }));
    expect(nodeMessages.some((msg) => (msg as { commandId?: string }).commandId === 'cmd-before-approval')).toBe(false);

    const stateRes = await fetch(new URL('/relay/member/share-state', relay.url()), {
      headers: { cookie },
    });
    expect(stateRes.status).toBe(200);
    await expect(stateRes.json()).resolves.toEqual(expect.objectContaining({
      state: expect.objectContaining({
        terminal: {
          state: 'blocked',
          reason: 'policy.grantRequired',
          message: 'Terminal viewing requires owner approval.',
        },
      }),
    }));

    const requestRes = await fetch(new URL('/relay/member/grant-requests', relay.url()), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-kookr-csrf-token': csrfToken },
      body: JSON.stringify({
        nodeId,
        grants: ['terminalInput'],
        comment: 'Alice\u202e wants control\n<script>alert(1)</script>',
      }),
    });
    expect(requestRes.status).toBe(403);
    await expect(requestRes.json()).resolves.toEqual({ error: 'guest-terminal-disabled' });
    expect(nodeMessages.some((msg) => (
      (msg as { type?: string; upserts?: Array<{ grants?: string[] }> }).type === 'policy.delta'
      && (msg as { upserts?: Array<{ grants?: string[] }> }).upserts?.some((grant) => grant.grants?.includes('terminalInput'))
    ))).toBe(false);

    const permissionRequestRes = await fetch(new URL('/relay/member/grant-requests', relay.url()), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-kookr-csrf-token': csrfToken },
      body: JSON.stringify({ nodeId, grants: ['permissionApprove'] }),
    });
    expect(permissionRequestRes.status).toBe(403);
    await expect(permissionRequestRes.json()).resolves.toEqual({ error: 'guest-link-view-only' });

    const revoked = await fetch(new URL(`/relay/node/invitations/${created.invitation.invitationId}/revoke`, relay.url()), {
      method: 'POST',
      headers: nodeHeaders(nodeToken),
    });
    expect(revoked.status).toBe(200);
    const revokedRequest = await fetch(new URL('/relay/member/grant-requests', relay.url()), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-kookr-csrf-token': csrfToken },
      body: JSON.stringify({ nodeId, grants: ['permissionApprove'] }),
    });
    expect(revokedRequest.status).toBe(401);
  });

  it('blocks owner approval of persisted Guest Link grant requests', async () => {
    const nodeToken = 'kookr_tok_v1_legacy_node_secret';
    const memberToken = 'kookr_mem_v1_legacy_member_secret';
    const nodeId = asNodeId('kookr-node-legacy');
    const registration: PersistedNodeRegistration = {
      nodeId,
      ownerId: 'owner',
      displayName: 'Legacy desktop',
      tokenHash: tokenHash(nodeToken),
      createdAt: '2026-05-18T00:00:00.000Z',
    };
    const invitation: InvitationRecord = {
      invitationId: 'inv-legacy-terminal',
      nodeId,
      subject: { kind: 'task', nodeId, taskId: 'task-1' },
      grants: ['view', 'terminalView', 'terminalInput'],
      grantId: asGrantId('grant-legacy-terminal'),
      tokenHash: 'legacy-invitation-token-hash',
      createdAt: '2026-05-18T00:00:00.000Z',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      shareId: '123-456',
      passwordVerifier: 'scrypt:fixture',
      redactedShareLabel: '123-***',
      acceptedAt: '2026-05-18T00:01:00.000Z',
      acceptedBy: 'legacy guest',
      memberTokenHash: tokenHash(memberToken),
      memberId: 'member-legacy',
      memberDeviceId: 'device-legacy',
      policyVersion: asPolicyVersion(1),
      grantRequests: [{
        requestId: 'grant-req-terminal',
        invitationId: 'inv-legacy-terminal',
        requestedGrants: ['terminalView', 'terminalInput'],
        status: 'pending',
        requestedAt: '2026-05-18T00:02:00.000Z',
      }],
    };
    let saveInvitationCalled = false;
    const relay = await startRelay({
      stateStore: {
        load: (): RelayStateSnapshot => ({
          registrations: [registration],
          invitations: [invitation],
          contactShareEnvelopes: [],
          quarantinedRows: 0,
        }),
        saveRegistration: () => undefined,
        saveInvitation: () => { saveInvitationCalled = true; },
        saveContactShareEnvelope: () => undefined,
        probe: () => true,
        close: () => undefined,
      },
    });
    const nodeUrl = new URL('/relay/node', relay.url());
    nodeUrl.protocol = 'ws:';
    const nodeWs = new WebSocket(nodeUrl, { headers: { authorization: `Bearer ${nodeToken}` } });
    sockets.push(nodeWs);
    const nodeMessages: unknown[] = [];
    nodeWs.on('message', (data) => nodeMessages.push(JSON.parse(data.toString()) as unknown));
    await once(nodeWs, 'open');
    nodeWs.send(JSON.stringify(makeNodeHello({
      nodeId,
      nodeEpoch: asNodeEpoch('1'),
      softwareVersion: 'test',
    })));
    await waitFor(() => nodeMessages.some((msg) => (msg as { type?: string }).type === 'relay.hello'));
    await waitFor(() => nodeMessages.some((msg) => (msg as { type?: string }).type === 'policy.sync'));
    const policySync = nodeMessages.find((msg) => (msg as { type?: string }).type === 'policy.sync') as {
      grants?: Array<{ grants?: string[] }>;
    };
    expect(policySync.grants).toEqual([expect.objectContaining({ grants: ['view'] })]);

    const nodeListRes = await fetch(new URL('/relay/node/invitations', relay.url()), {
      headers: nodeHeaders(nodeToken),
    });
    expect(nodeListRes.status).toBe(200);
    await expect(nodeListRes.json()).resolves.toEqual({
      invitations: [expect.objectContaining({
        invitationId: 'inv-legacy-terminal',
        grants: ['view'],
        grantRequests: [],
      })],
    });
    const nodeDetailRes = await fetch(new URL('/relay/node/invitations/inv-legacy-terminal', relay.url()), {
      headers: nodeHeaders(nodeToken),
    });
    expect(nodeDetailRes.status).toBe(200);
    const nodeDetailBody = await nodeDetailRes.json();
    expect(nodeDetailBody).toEqual(expect.objectContaining({
      invitation: expect.objectContaining({
        invitationId: 'inv-legacy-terminal',
        grants: ['view'],
        grantRequests: [],
      }),
    }));
    expect(JSON.stringify(nodeDetailBody)).not.toContain('legacy-invitation-token-hash');
    expect(JSON.stringify(nodeDetailBody)).not.toContain('legacy-member-token-hash');
    expect(JSON.stringify(nodeDetailBody)).not.toContain('grant-legacy-terminal');

    const approveRes = await fetch(
      new URL('/relay/node/invitations/inv-legacy-terminal/grant-requests/grant-req-terminal/approve', relay.url()),
      { method: 'POST', headers: nodeHeaders(nodeToken) },
    );

    expect(approveRes.status).toBe(403);
    await expect(approveRes.json()).resolves.toEqual({ error: 'guest-terminal-disabled' });
    expect(saveInvitationCalled).toBe(false);
    expect(nodeMessages.some((msg) => (
      (msg as { type?: string; upserts?: Array<{ grants?: string[] }> }).type === 'policy.delta'
      && (msg as { upserts?: Array<{ grants?: string[] }> }).upserts?.some((grant) => grant.grants?.includes('terminalInput'))
    ))).toBe(false);

    const cookie = `kookr_relay_member_token=${memberToken}; kookr_relay_device_id=device-legacy`;
    const stateRes = await fetch(new URL('/relay/member/share-state', relay.url()), { headers: { cookie } });
    expect(stateRes.status).toBe(200);
    await expect(stateRes.json()).resolves.toEqual(expect.objectContaining({
      state: expect.objectContaining({
        grants: ['view'],
        grantRequests: [],
        terminal: {
          state: 'blocked',
          reason: 'policy.grantRequired',
          message: 'Terminal viewing requires owner approval.',
        },
      }),
    }));

    const member = await connectMember(relay, nodeId, memberToken, cookie);
    const memberMessages: unknown[] = [];
    member.on('message', (data) => memberMessages.push(JSON.parse(data.toString()) as unknown));
    member.send(JSON.stringify({
      type: 'remote.command',
      commandId: 'cmd-legacy-terminal-grant',
      nodeId,
      nodeEpoch: '1',
      sessionId: 'session-1',
      sessionEpoch: '1',
      idempotencyKey: 'idem-legacy-terminal-grant',
      action: 'submitMessage',
    }));
    await waitFor(() => memberMessages.some((msg) => (msg as { commandId?: string }).commandId === 'cmd-legacy-terminal-grant'));
    expect(memberMessages).toContainEqual(expect.objectContaining({
      commandId: 'cmd-legacy-terminal-grant',
      outcome: 'rejected-pre-audit',
      reason: 'missing terminalInput grant',
    }));
    expect(nodeMessages.some((msg) => (msg as { commandId?: string }).commandId === 'cmd-legacy-terminal-grant')).toBe(false);
  });

  it('blocks duplicate terminal-input requests before owner denial cooldowns apply', async () => {
    const relay = await startRelay();
    const { nodeId, nodeToken } = relay.registerNode();
    const createdRes = await fetch(new URL('/relay/node/invitations', relay.url()), {
      method: 'POST',
      headers: nodeHeaders(nodeToken),
      body: JSON.stringify({ subject: { kind: 'task', taskId: 'task-1' }, grants: ['view'] }),
    });
    expect(createdRes.status).toBe(201);
    const created = await createdRes.json() as { token: string; invitation: { invitationId: string } };
    const acceptRes = await fetch(new URL('/relay/invitations/accept', relay.url()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: created.token, displayName: 'Alice' }),
    });
    expect(acceptRes.status).toBe(200);
    const cookie = cookieHeaderFromSetCookie(acceptRes.headers.get('set-cookie') ?? '');
    const csrfToken = cookieValue(cookie, 'kookr_relay_csrf_token');

    const requestRes = await fetch(new URL('/relay/member/grant-requests', relay.url()), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-kookr-csrf-token': csrfToken },
      body: JSON.stringify({ nodeId, grants: ['terminalInput'] }),
    });
    expect(requestRes.status).toBe(403);
    await expect(requestRes.json()).resolves.toEqual({ error: 'guest-terminal-disabled' });

    const retryRes = await fetch(new URL('/relay/member/grant-requests', relay.url()), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-kookr-csrf-token': csrfToken },
      body: JSON.stringify({ nodeId, grants: ['terminalInput'] }),
    });
    expect(retryRes.status).toBe(403);
    await expect(retryRes.json()).resolves.toEqual({ error: 'guest-terminal-disabled' });
  });
});

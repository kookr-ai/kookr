import { once } from 'node:events';

import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import { createRelayServer, type RelayServerHandle } from '../server.js';
import { makeNodeHello, type RelayHello } from '../../src/remote/handshake.js';
import { asNodeEpoch } from '../../src/remote/ids.js';

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

async function startRelay(): Promise<RelayServerHandle> {
  const relay = createRelayServer({ adminToken: 'admin-secret' });
  openHandle = relay;
  await new Promise<void>((resolve) => relay.httpServer.listen(0, '127.0.0.1', () => resolve()));
  return relay;
}

function nodeHeaders(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` };
}

async function connectMember(relay: RelayServerHandle, nodeId: string, memberToken: string): Promise<WebSocket> {
  const wsUrl = new URL('/relay/client', relay.url());
  wsUrl.protocol = 'ws:';
  wsUrl.searchParams.set('nodeId', nodeId);
  const ws = new WebSocket(wsUrl, { headers: { cookie: `kookr_relay_member_token=${memberToken}` } });
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
      },
    });
    openHandle = relay;
    await new Promise<void>((resolve) => relay.httpServer.listen(0, '127.0.0.1', () => resolve()));
    const { nodeId, nodeToken } = relay.registerNode();
    await connectNode(relay, nodeId, nodeToken);

    const ops = await fetch(new URL('/relay/ops/status', relay.url()));
    expect(ops.status).toBe(200);
    expect(await ops.json()).toMatchObject({
      configured: true,
      mode: 'available',
      deploymentOwner: 'ops@example.com',
      environment: 'production',
      tlsExpiresAt: '2026-08-01T00:00:00.000Z',
    });

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
    expect(body.invitation).not.toHaveProperty('policyVersion');
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
    expect(await accepted.json()).toEqual({ nodeId });

    const second = await fetch(new URL('/relay/share-tickets/accept', relay.url()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shareId: body.shareTicket.shareId, password: body.shareTicket.password, displayName: 'viewer-2' }),
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'ticket-unavailable' });
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
});

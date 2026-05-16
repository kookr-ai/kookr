import { once } from 'node:events';

import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import { createRelayServer, type RelayServerHandle } from '../server.js';

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

describe('relay node-scoped task-share endpoints', () => {
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
    const body = await res.json() as { invitation: Record<string, unknown>; token: string };
    expect(body.token).toMatch(/^kookr_inv_v1_/);
    expect(body.invitation.nodeId).toBe(nodeId);
    expect(body.invitation.taskId).toBe('task-42');
    expect(body.invitation.grants).toEqual(['view']);
    expect(typeof body.invitation.invitationId).toBe('string');
    expect(typeof body.invitation.expiresAt).toBe('string');
    // The safe node view must not leak relay-internal secrets/hashes.
    expect(body.invitation).not.toHaveProperty('tokenHash');
    expect(body.invitation).not.toHaveProperty('memberTokenHash');
    expect(body.invitation).not.toHaveProperty('grantId');
    expect(body.invitation).not.toHaveProperty('policyVersion');
    // The node endpoint never returns a query-string accept URL.
    expect(body).not.toHaveProperty('acceptUrl');
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

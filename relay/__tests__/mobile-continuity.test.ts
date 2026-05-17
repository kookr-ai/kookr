import { once } from 'node:events';

import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { makeNodeHello } from '../../src/remote/handshake.js';
import { asNodeEpoch } from '../../src/remote/ids.js';
import { createRelayServer } from '../server.js';

async function listen(relay: ReturnType<typeof createRelayServer>): Promise<void> {
  await new Promise<void>((resolve) => relay.httpServer.listen(0, '127.0.0.1', () => resolve()));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('timed out waiting for condition'));
      }
    }, 10);
  });
}

function cookieHeader(res: Response): string {
  const raw = res.headers.getSetCookie?.() ?? [];
  return raw.map((cookie) => cookie.split(';')[0]).join('; ');
}

function replaceCookie(cookies: string, name: string, value: string): string {
  const filtered = cookies
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${name}=`));
  return [...filtered, `${name}=${encodeURIComponent(value)}`].join('; ');
}

async function connectNode(relay: ReturnType<typeof createRelayServer>, nodeId: string, nodeToken: string): Promise<WebSocket> {
  const wsUrl = new URL('/relay/node', relay.url());
  wsUrl.protocol = 'ws:';
  const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${nodeToken}` } });
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString()) as { type?: string; policyVersion?: number; upserts?: Array<{ grantId: string }>; grants?: Array<{ grantId: string }>; revokes?: string[]; revokedGrantIds?: string[] };
    if (msg.type !== 'policy.delta' && msg.type !== 'policy.sync' && msg.type !== 'policy.revoke') return;
    ws.send(JSON.stringify({
      type: 'policy.delta.ack',
      nodeId,
      policyVersion: msg.policyVersion,
      appliedGrantIds: (msg.upserts ?? msg.grants ?? []).map((grant) => grant.grantId),
      revokedGrantIds: msg.revokes ?? msg.revokedGrantIds ?? [],
    }));
  });
  await once(ws, 'open');
  ws.send(JSON.stringify(makeNodeHello({
    nodeId: nodeId as ReturnType<typeof makeNodeHello>['nodeId'],
    nodeEpoch: asNodeEpoch('1'),
    softwareVersion: 'test',
    supportedFeatures: ['policy-sync', 'terminal-stream', 'terminal-input'],
  })));
  return ws;
}

describe('relay member continuity and approval notifications', () => {
  it('registers a member approval notification and sends a redacted push when the owner approves', async () => {
    const sent: string[] = [];
    const relay = createRelayServer({
      adminToken: 'admin',
      pushSender: async (_subscription, payload) => {
        sent.push(payload);
      },
    });
    await listen(relay);
    const node = relay.registerNode({ displayName: 'Owner desktop' });
    const nodeWs = await connectNode(relay, node.nodeId, node.nodeToken);
    try {
      const created = relay.createInvitation({
        nodeId: node.nodeId,
        subject: { kind: 'task', nodeId: node.nodeId, taskId: 'task-a' },
        grants: ['view'],
        shareTicket: true,
        displayLabel: 'Shared task label',
      });
      expect(created.shareTicket).toBeTruthy();

      const accept = await fetch(`${relay.url()}/relay/share-tickets/accept`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          shareId: created.shareTicket!.shareId,
          password: created.shareTicket!.password,
          displayName: 'phone',
        }),
      });
      expect(accept.status).toBe(200);
      const cookies = cookieHeader(accept);
      const state = await fetch(`${relay.url()}/relay/member/share-state`, { headers: { cookie: cookies } });
      const stateBody = await state.json() as { security?: { csrfToken?: string } };
      expect(stateBody.security?.csrfToken).toBeTruthy();

      const request = await fetch(`${relay.url()}/relay/member/grant-requests`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: cookies,
          'x-kookr-csrf-token': stateBody.security!.csrfToken!,
        },
        body: JSON.stringify({ nodeId: node.nodeId, grants: ['terminalInput'] }),
      });
      expect(request.status).toBe(201);
      const requestBody = await request.json() as { request: { requestId: string } };

      const subscription = await fetch(`${relay.url()}/relay/member/approval-notifications`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: cookies,
          'x-kookr-csrf-token': stateBody.security!.csrfToken!,
        },
        body: JSON.stringify({
          nodeId: node.nodeId,
          subscription: {
            endpoint: 'https://push.example/member-device',
            keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
          },
        }),
      });
      expect(subscription.status).toBe(201);

      const approve = await fetch(
        `${relay.url()}/relay/node/invitations/${encodeURIComponent(created.invitation.invitationId)}/grant-requests/${encodeURIComponent(requestBody.request.requestId)}/approve`,
        { method: 'POST', headers: { authorization: `Bearer ${node.nodeToken}` } },
      );
      expect(approve.status).toBe(200);
      expect(sent).toHaveLength(1);
      const payload = JSON.parse(sent[0]) as Record<string, unknown>;
      expect(payload).toEqual(expect.objectContaining({
        redactor: 'redactor.v1',
        nodeDisplayName: 'Owner desktop',
        taskShortLabel: 'Shared task label',
        alertKind: 'approval-updated',
      }));
      expect(JSON.stringify(payload)).not.toContain(created.shareTicket!.password);
    } finally {
      nodeWs.close();
      await relay.close();
    }
  });

  it('registers polling-only approval notification fallback without a push subscription', async () => {
    const relay = createRelayServer({ adminToken: 'admin' });
    await listen(relay);
    const node = relay.registerNode({ displayName: 'Owner desktop' });
    const nodeWs = await connectNode(relay, node.nodeId, node.nodeToken);
    try {
      const created = relay.createInvitation({
        nodeId: node.nodeId,
        subject: { kind: 'task', nodeId: node.nodeId, taskId: 'task-a' },
        grants: ['view'],
        shareTicket: true,
      });
      expect(created.shareTicket).toBeTruthy();
      const accept = await fetch(`${relay.url()}/relay/share-tickets/accept`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          shareId: created.shareTicket!.shareId,
          password: created.shareTicket!.password,
          displayName: 'phone',
        }),
      });
      const cookies = cookieHeader(accept);
      const state = await fetch(`${relay.url()}/relay/member/share-state`, { headers: { cookie: cookies } });
      const stateBody = await state.json() as { security?: { csrfToken?: string } };
      const fallback = await fetch(`${relay.url()}/relay/member/approval-notifications`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: cookies,
          'x-kookr-csrf-token': stateBody.security!.csrfToken!,
        },
        body: JSON.stringify({ nodeId: node.nodeId }),
      });

      expect(fallback.status).toBe(202);
      await expect(fallback.json()).resolves.toEqual(expect.objectContaining({
        mode: 'poll',
        deviceId: expect.any(String),
      }));
    } finally {
      nodeWs.close();
      await relay.close();
    }
  });

  it('does not let a caller impersonate another device by editing the device cookie', async () => {
    const relay = createRelayServer({ adminToken: 'admin' });
    await listen(relay);
    const node = relay.registerNode({ displayName: 'Owner desktop' });
    const nodeWs = await connectNode(relay, node.nodeId, node.nodeToken);
    try {
      const created = relay.createInvitation({
        nodeId: node.nodeId,
        subject: { kind: 'session', nodeId: node.nodeId, sessionId: 'session-a' },
        grants: ['view', 'terminalView', 'terminalInput'],
        shareTicket: true,
      });
      expect(created.shareTicket).toBeTruthy();
      const phoneAccept = await fetch(`${relay.url()}/relay/share-tickets/accept`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          shareId: created.shareTicket!.shareId,
          password: created.shareTicket!.password,
          displayName: 'phone',
        }),
      });
      const phoneCookies = cookieHeader(phoneAccept);
      const phoneState = await fetch(`${relay.url()}/relay/member/share-state`, { headers: { cookie: phoneCookies } });
      const phoneStateBody = await phoneState.json() as { security?: { csrfToken?: string; deviceId?: string } };
      expect(phoneStateBody.security?.deviceId).toBeTruthy();
      await waitFor(() => relay.nodeStatuses()[0]?.policySyncStatus === 'acked');
      const phoneLease = await fetch(`${relay.url()}/relay/member/controller-lease`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: phoneCookies,
          'x-kookr-csrf-token': phoneStateBody.security!.csrfToken!,
        },
        body: JSON.stringify({ nodeId: node.nodeId, holderLabel: 'phone' }),
      });
      expect(phoneLease.status).toBe(200);

      const laptopAccept = await fetch(`${relay.url()}/relay/share-tickets/accept`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          shareId: created.shareTicket!.shareId,
          password: created.shareTicket!.password,
          displayName: 'laptop',
        }),
      });
      const laptopCookies = cookieHeader(laptopAccept);
      const laptopState = await fetch(`${relay.url()}/relay/member/share-state`, { headers: { cookie: laptopCookies } });
      const laptopStateBody = await laptopState.json() as { security?: { csrfToken?: string; deviceId?: string } };
      expect(laptopStateBody.security?.deviceId).toBeTruthy();
      expect(laptopStateBody.security!.deviceId).not.toBe(phoneStateBody.security!.deviceId);

      const forgedCookies = replaceCookie(laptopCookies, 'kookr_relay_device_id', phoneStateBody.security!.deviceId!);
      const forgedLease = await fetch(`${relay.url()}/relay/member/controller-lease`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: forgedCookies,
          'x-kookr-csrf-token': laptopStateBody.security!.csrfToken!,
        },
        body: JSON.stringify({ nodeId: node.nodeId, holderLabel: 'laptop' }),
      });
      expect(forgedLease.status).toBe(409);
      await expect(forgedLease.json()).resolves.toEqual(expect.objectContaining({
        error: 'held-by-another-device',
        lease: expect.objectContaining({ deviceId: phoneStateBody.security!.deviceId }),
      }));
    } finally {
      nodeWs.close();
      await relay.close();
    }
  });
});

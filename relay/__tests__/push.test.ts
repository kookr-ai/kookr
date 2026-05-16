import { once } from 'node:events';

import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRelayServer, type RelayServerHandle } from '../server.js';
import { makeNodeHello } from '../../src/remote/handshake.js';
import { asNodeEpoch, asServerRevision } from '../../src/remote/ids.js';
import type { RemoteControlEvent } from '../../src/remote/control-events.js';
import type { RedactedPushPayload } from '../../src/remote/push.js';

const SUBSCRIPTION = {
  endpoint: 'https://push.example.test/send/device-a',
  keys: {
    p256dh: 'p256dh',
    auth: 'auth',
  },
};

async function listen(relay: RelayServerHandle): Promise<void> {
  await new Promise<void>((resolve) => relay.httpServer.listen(0, '127.0.0.1', () => resolve()));
}

async function fetchJson<T>(relay: RelayServerHandle, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(new URL(path, relay.url()), init);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return await res.json() as T;
}

async function connectNode(relay: RelayServerHandle, nodeId: string, nodeToken: string): Promise<WebSocket> {
  const wsUrl = new URL('/relay/node', relay.url());
  wsUrl.protocol = 'ws:';
  const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${nodeToken}` } });
  await once(ws, 'open');
  ws.send(JSON.stringify(makeNodeHello({
    nodeId: nodeId as ReturnType<typeof makeNodeHello>['nodeId'],
    nodeEpoch: asNodeEpoch('1'),
    softwareVersion: 'test',
  })));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for relay hello')), 1_000);
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as { type?: string; outcome?: string };
      if (msg.type === 'relay.hello') {
        clearTimeout(timer);
        expect(msg.outcome).toBe('accepted');
        resolve();
      }
    });
  });
  return ws;
}

describe('relay Web Push', () => {
  let relay: RelayServerHandle | null = null;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.close();
    await relay?.close();
    relay = null;
  });

  it('provisions VAPID keys and invalidates stale subscriptions on rotation', async () => {
    relay = createRelayServer({ allowInsecureAdmin: true, allowInsecureClients: true });
    await listen(relay);
    const node = relay.registerNode();
    const key = await fetchJson<{ publicKey: string; version: number }>(relay, '/relay/push/vapid-public-key');

    expect(key.publicKey).toEqual(expect.any(String));
    expect(key.version).toBe(1);

    await fetchJson(relay, '/relay/push/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'device-a', nodeId: node.nodeId, vapidKeyVersion: 1, subscription: SUBSCRIPTION }),
    });
    expect(relay.pushSubscriptions()).toHaveLength(1);

    const rotated = await fetchJson<{ publicKey: string; version: number; invalidated: number }>(relay, '/relay/admin/push/vapid/rotate', {
      method: 'POST',
    });
    expect(rotated.version).toBe(2);
    expect(rotated.publicKey).not.toBe(key.publicKey);
    expect(rotated.invalidated).toBe(1);
    expect(relay.pushSubscriptions()).toHaveLength(0);
  });

  it('rejects subscription cache mismatches without removing the client-visible current version', async () => {
    relay = createRelayServer({ allowInsecureAdmin: true, allowInsecureClients: true });
    await listen(relay);
    const node = relay.registerNode();

    const res = await fetch(new URL('/relay/push/subscriptions', relay.url()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'device-a', nodeId: node.nodeId, vapidKeyVersion: 999, subscription: SUBSCRIPTION }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ currentVersion: 1 });
    expect(relay.pushSubscriptions()).toHaveLength(0);
  });

  it('fans out only the redacted push payload from node state deltas', async () => {
    const sent: Array<{ endpoint: string; payload: RedactedPushPayload }> = [];
    relay = createRelayServer({
      allowInsecureAdmin: true,
      allowInsecureClients: true,
      pushSender: vi.fn(async (subscription, payload) => {
        sent.push({
          endpoint: subscription.endpoint,
          payload: JSON.parse(payload) as RedactedPushPayload,
        });
      }),
    });
    await listen(relay);
    const node = relay.registerNode();
    await fetchJson(relay, '/relay/push/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'device-a', nodeId: node.nodeId, subscription: SUBSCRIPTION }),
    });

    const ws = await connectNode(relay, node.nodeId, node.nodeToken);
    sockets.push(ws);
    const event: RemoteControlEvent = {
      nodeId: node.nodeId,
      nodeEpoch: asNodeEpoch('1'),
      serverRevision: asServerRevision(1),
      ts: new Date('2026-05-15T00:00:00.000Z').toISOString(),
      kind: 'state.delta',
      payload: {
        type: 'push.alert',
        payload: {
          redactor: 'redactor.v1',
          nodeDisplayName: 'Kookr',
          taskShortLabel: 'Task abcdef01',
          alertKind: 'permission-requested',
          alertId: 'alert-a',
        },
      },
    };
    ws.send(JSON.stringify(event));

    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (sent.length > 0) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - started > 1_000) {
          clearInterval(timer);
          reject(new Error('timed out waiting for push'));
        }
      }, 10);
    });

    expect(sent).toEqual([{
      endpoint: SUBSCRIPTION.endpoint,
      payload: {
        redactor: 'redactor.v1',
        nodeDisplayName: 'Kookr',
        taskShortLabel: 'Task abcdef01',
        alertKind: 'permission-requested',
        alertId: 'alert-a',
      },
    }]);
  });

  it('rejects push alert deltas with extra payload fields before delivery', async () => {
    const sender = vi.fn();
    relay = createRelayServer({
      allowInsecureAdmin: true,
      allowInsecureClients: true,
      pushSender: sender,
    });
    await listen(relay);
    const node = relay.registerNode();
    await fetchJson(relay, '/relay/push/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'device-a', nodeId: node.nodeId, subscription: SUBSCRIPTION }),
    });

    const ws = await connectNode(relay, node.nodeId, node.nodeToken);
    sockets.push(ws);
    ws.send(JSON.stringify({
      nodeId: node.nodeId,
      nodeEpoch: asNodeEpoch('1'),
      serverRevision: asServerRevision(1),
      ts: new Date('2026-05-15T00:00:00.000Z').toISOString(),
      kind: 'state.delta',
      payload: {
        type: 'push.alert',
        payload: {
          redactor: 'redactor.v1',
          nodeDisplayName: 'Kookr',
          taskShortLabel: 'Task abcdef01',
          alertKind: 'permission-requested',
          alertId: 'alert-a',
          fullBlockReason: 'secret should not ride in push payloads',
        },
      },
    } satisfies RemoteControlEvent));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sender).not.toHaveBeenCalled();
  });

  it('skips delivery when KOOKR_PUSH_DISABLED=true', async () => {
    const sender = vi.fn();
    relay = createRelayServer({ allowInsecureAdmin: true, allowInsecureClients: true, pushDisabled: true, pushSender: sender });
    await listen(relay);
    const node = relay.registerNode();
    await fetchJson(relay, '/relay/push/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'device-a', nodeId: node.nodeId, subscription: SUBSCRIPTION }),
    });

    await expect(fetchJson(relay, '/relay/admin/push/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'device-a' }),
    })).resolves.toMatchObject({ result: 'skipped-disabled' });
    expect(sender).not.toHaveBeenCalled();
  });

  it('replays cached task projections to reconnecting relay clients', async () => {
    relay = createRelayServer({ allowInsecureAdmin: true, allowInsecureClients: true });
    await listen(relay);
    const node = relay.registerNode();
    const nodeWs = await connectNode(relay, node.nodeId, node.nodeToken);
    sockets.push(nodeWs);
    nodeWs.send(JSON.stringify({
      nodeId: node.nodeId,
      nodeEpoch: asNodeEpoch('1'),
      serverRevision: asServerRevision(1),
      ts: new Date('2026-05-15T00:00:00.000Z').toISOString(),
      kind: 'snapshot',
      payload: {
        tasks: [{ taskId: 'task-a', taskShortLabel: 'Task A', status: 'inProgress' }],
      },
    } satisfies RemoteControlEvent));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const clientUrl = new URL('/relay/client', relay.url());
    clientUrl.protocol = 'ws:';
    clientUrl.searchParams.set('nodeId', node.nodeId);
    const client = new WebSocket(clientUrl);
    sockets.push(client);
    const replayed = await new Promise<RemoteControlEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for replay')), 1_000);
      client.on('message', (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()) as RemoteControlEvent);
      });
    });

    expect(replayed).toMatchObject({
      kind: 'snapshot',
      payload: { tasks: [{ taskId: 'task-a', taskShortLabel: 'Task A' }] },
    });
  });

  it('serves dashboard state and WebSocket replay with a browser client token in secure mode', async () => {
    relay = createRelayServer({ clientToken: 'client-secret' });
    await listen(relay);
    const node = relay.registerNode();
    const nodeWs = await connectNode(relay, node.nodeId, node.nodeToken);
    sockets.push(nodeWs);
    nodeWs.send(JSON.stringify({
      nodeId: node.nodeId,
      nodeEpoch: asNodeEpoch('1'),
      serverRevision: asServerRevision(1),
      ts: new Date('2026-05-15T00:00:00.000Z').toISOString(),
      kind: 'snapshot',
      payload: {
        tasks: [{ taskId: 'task-a', taskShortLabel: 'Task A', status: 'inProgress' }],
      },
    } satisfies RemoteControlEvent));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const page = await fetch(new URL(`/relay/dashboard?nodeId=${node.nodeId}&clientToken=client-secret`, relay.url()));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Kookr Relay');
    expect(html).toContain('clientToken');

    await expect(fetchJson(relay, `/relay/dashboard/state?nodeId=${node.nodeId}&clientToken=client-secret`))
      .resolves.toMatchObject({
        nodeId: node.nodeId,
        events: [expect.objectContaining({ kind: 'snapshot' })],
      });

    const clientUrl = new URL('/relay/client', relay.url());
    clientUrl.protocol = 'ws:';
    clientUrl.searchParams.set('nodeId', node.nodeId);
    clientUrl.searchParams.set('clientToken', 'client-secret');
    const client = new WebSocket(clientUrl);
    sockets.push(client);
    const replayed = await new Promise<RemoteControlEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for replay')), 1_000);
      client.on('message', (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()) as RemoteControlEvent);
      });
    });
    expect(replayed).toMatchObject({ payload: { tasks: [{ taskId: 'task-a' }] } });
  });

  it('keeps secure dashboard state and WebSocket closed without a valid browser token', async () => {
    relay = createRelayServer({ clientToken: 'client-secret' });
    await listen(relay);
    const node = relay.registerNode();

    const state = await fetch(new URL(`/relay/dashboard/state?nodeId=${node.nodeId}`, relay.url()));
    expect(state.status).toBe(401);

    const clientUrl = new URL('/relay/client', relay.url());
    clientUrl.protocol = 'ws:';
    clientUrl.searchParams.set('nodeId', node.nodeId);
    const client = new WebSocket(clientUrl);
    sockets.push(client);
    await new Promise<void>((resolve) => {
      client.once('error', () => resolve());
      client.once('close', () => resolve());
    });
    expect([WebSocket.CLOSING, WebSocket.CLOSED]).toContain(client.readyState);
  });
});

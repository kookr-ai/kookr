import { once } from 'node:events';

import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import { createRelayServer, type RelayServerHandle } from '../server.js';
import { makeNodeHello, type RelayHello } from '../../src/remote/handshake.js';
import { asNodeEpoch, asServerRevision } from '../../src/remote/ids.js';
import type { RemoteControlEvent } from '../../src/remote/control-events.js';

async function listen(relay: RelayServerHandle): Promise<void> {
  await new Promise<void>((resolve) => relay.httpServer.listen(0, '127.0.0.1', () => resolve()));
}

async function connectNode(relayUrl: string, nodeId: string, token: string): Promise<{ ws: WebSocket; messages: unknown[] }> {
  const wsUrl = new URL('/relay/node', relayUrl);
  wsUrl.protocol = 'ws:';
  const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } });
  await once(ws, 'open');
  const messages: unknown[] = [];
  ws.on('message', (data) => {
    messages.push(JSON.parse(data.toString()) as unknown);
  });
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
  return { ws, messages };
}

async function connectClient(relayUrl: string, nodeId: string): Promise<{ ws: WebSocket; messages: unknown[] }> {
  const wsUrl = new URL('/relay/client', relayUrl);
  wsUrl.protocol = 'ws:';
  wsUrl.searchParams.set('nodeId', nodeId);
  const ws = new WebSocket(wsUrl);
  const messages: unknown[] = [];
  ws.on('message', (data) => {
    messages.push(JSON.parse(data.toString()) as unknown);
  });
  await once(ws, 'open');
  return { ws, messages };
}

describe('relay two-node isolation fixture', () => {
  let relay: RelayServerHandle | null = null;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets.splice(0)) {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
    }
    await relay?.close();
    relay = null;
  });

  it('routes node events and commands only to the subscribed/target node', async () => {
    relay = createRelayServer({ allowInsecureClients: true });
    await listen(relay);
    const nodeA = relay.registerNode({ displayName: 'A' });
    const nodeB = relay.registerNode({ displayName: 'B' });
    const nodeConnA = await connectNode(relay.url(), nodeA.nodeId, nodeA.nodeToken);
    const nodeConnB = await connectNode(relay.url(), nodeB.nodeId, nodeB.nodeToken);
    sockets.push(nodeConnA.ws, nodeConnB.ws);

    const clientA = await connectClient(relay.url(), nodeA.nodeId);
    const clientB = await connectClient(relay.url(), nodeB.nodeId);
    sockets.push(clientA.ws, clientB.ws);

    const eventA: RemoteControlEvent = {
      nodeId: nodeA.nodeId,
      nodeEpoch: asNodeEpoch('1'),
      serverRevision: asServerRevision(1),
      ts: new Date().toISOString(),
      kind: 'snapshot',
      payload: { taskIds: ['a-task'] },
    };
    nodeConnA.ws.send(JSON.stringify(eventA));

    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (clientA.messages.some((msg) => (msg as { nodeId?: string }).nodeId === nodeA.nodeId)) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - started > 1_000) {
          clearInterval(timer);
          reject(new Error('timed out waiting for node A event'));
        }
      }, 10);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(clientA.messages).toContainEqual(expect.objectContaining({ nodeId: nodeA.nodeId, kind: 'snapshot' }));
    expect(clientB.messages).not.toContainEqual(expect.objectContaining({ nodeId: nodeA.nodeId }));

    nodeConnA.ws.send(JSON.stringify({
      ...eventA,
      nodeId: nodeB.nodeId,
      payload: { taskIds: ['spoofed-from-a'] },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(clientB.messages).not.toContainEqual(expect.objectContaining({
      nodeId: nodeB.nodeId,
      payload: { taskIds: ['spoofed-from-a'] },
    }));

    clientA.ws.send(JSON.stringify({
      type: 'remote.command',
      nodeId: nodeB.nodeId,
      payload: { commandId: 'spoof-b' },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(nodeConnB.messages).not.toContainEqual(expect.objectContaining({
      type: 'remote.command',
      payload: { commandId: 'spoof-b' },
    }));

    clientB.ws.send(JSON.stringify({
      type: 'remote.command',
      nodeId: nodeB.nodeId,
      payload: { commandId: 'cmd-b' },
    }));
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (nodeConnB.messages.some((msg) => (msg as { type?: string }).type === 'remote.command')) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - started > 1_000) {
          clearInterval(timer);
          reject(new Error('timed out waiting for command forwarded to node B'));
        }
      }, 10);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(nodeConnB.messages).toContainEqual(expect.objectContaining({
      type: 'remote.command',
      nodeId: nodeB.nodeId,
    }));
    expect(nodeConnA.messages).not.toContainEqual(expect.objectContaining({
      type: 'remote.command',
      nodeId: nodeB.nodeId,
    }));
  });
});

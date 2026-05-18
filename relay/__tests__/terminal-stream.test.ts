import { once } from 'node:events';

import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import { createRelayServer, type RelayServerHandle } from '../server.js';
import { makeNodeHello, PHASE1_SUPPORTED_FEATURES, type RemoteFeature } from '../../src/remote/handshake.js';
import { asNodeEpoch, asSeq, asSessionEpoch, asSessionId } from '../../src/remote/ids.js';
import type { TerminalStreamEvent } from '../../src/remote/stream-events.js';

async function listen(relay: RelayServerHandle): Promise<void> {
  await new Promise<void>((resolve) => relay.httpServer.listen(0, '127.0.0.1', () => resolve()));
}

async function connectNode(
  relayUrl: string,
  nodeId: string,
  token: string,
  opts: { terminalStream?: boolean; nodeEpoch?: string } = { terminalStream: true },
): Promise<WebSocket> {
  const wsUrl = new URL('/relay/node', relayUrl);
  wsUrl.protocol = 'ws:';
  const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } });
  await once(ws, 'open');
  ws.send(JSON.stringify(makeNodeHello({
    nodeId: nodeId as ReturnType<typeof makeNodeHello>['nodeId'],
    nodeEpoch: asNodeEpoch(opts.nodeEpoch ?? '1'),
    softwareVersion: 'test',
    supportedFeatures: opts.terminalStream !== false
      ? [...PHASE1_SUPPORTED_FEATURES, 'terminal-stream', 'terminal-publication-gate.v1'] satisfies RemoteFeature[]
      : PHASE1_SUPPORTED_FEATURES,
  })));
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for relay hello')), 1_000);
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as { type?: string; outcome?: string };
      if (msg.type === 'relay.hello') {
        clearTimeout(timeout);
        expect(msg.outcome).toBe('accepted');
        resolve();
      }
    });
  });
  return ws;
}

async function connectClient(relayUrl: string, nodeId: string, params: Record<string, string> = {}): Promise<{ ws: WebSocket; messages: unknown[] }> {
  const wsUrl = new URL('/relay/client', relayUrl);
  wsUrl.protocol = 'ws:';
  wsUrl.searchParams.set('nodeId', nodeId);
  for (const [key, value] of Object.entries(params)) wsUrl.searchParams.set(key, value);
  const ws = new WebSocket(wsUrl);
  const messages: unknown[] = [];
  ws.on('message', (data) => {
    messages.push(JSON.parse(data.toString()) as unknown);
  });
  await once(ws, 'open');
  return { ws, messages };
}

function terminalBytes(nodeId: string, seq: number, text: string, opts: { nodeEpoch?: string; publicationScopeId?: string } = {}): TerminalStreamEvent {
  return {
    nodeId: nodeId as TerminalStreamEvent['nodeId'],
    nodeEpoch: asNodeEpoch(opts.nodeEpoch ?? '1'),
    sessionId: asSessionId('s1'),
    sessionEpoch: asSessionEpoch('1'),
    seq: asSeq(seq),
    ts: new Date().toISOString(),
    kind: 'terminal.bytes',
    payload: {
      encoding: 'base64',
      data: Buffer.from(text).toString('base64'),
      byteLength: Buffer.byteLength(text),
    },
    publication: {
      publicationScopeId: opts.publicationScopeId ?? 'scope-test',
      principal: { kind: 'guest-member', invitationId: 'inv-1', memberSessionId: 'member-1', deviceId: 'device-1' },
      policyVersion: 1 as TerminalStreamEvent['publication']['policyVersion'],
    },
  };
}

describe('relay terminal stream fanout', () => {
  let relay: RelayServerHandle | null = null;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets.splice(0)) {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
    }
    await relay?.close();
    relay = null;
  });

  it('fans out live stream bytes without public replay on reconnect', async () => {
    relay = createRelayServer({ allowInsecureClients: true });
    await listen(relay);
    const node = relay.registerNode();
    const nodeWs = await connectNode(relay.url(), node.nodeId, node.nodeToken);
    sockets.push(nodeWs);

    nodeWs.send(JSON.stringify(terminalBytes(node.nodeId, 1, 'one')));
    nodeWs.send(JSON.stringify(terminalBytes(node.nodeId, 2, 'two')));
    nodeWs.send(JSON.stringify(terminalBytes(node.nodeId, 3, 'three')));

    const client = await connectClient(relay.url(), node.nodeId, {
      terminalSessionId: 's1',
      terminalSessionEpoch: '1',
      afterSeq: '0',
    });
    const otherSessionClient = await connectClient(relay.url(), node.nodeId, {
      terminalSessionId: 's2',
      terminalSessionEpoch: '1',
      afterSeq: '0',
    });
    sockets.push(client.ws, otherSessionClient.ws);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.messages).not.toContainEqual(expect.objectContaining({ kind: 'terminal.replay-gap' }));
    expect(client.messages).not.toContainEqual(expect.objectContaining({ kind: 'terminal.bytes' }));
    expect(otherSessionClient.messages).not.toContainEqual(expect.objectContaining({ kind: 'terminal.bytes' }));

    nodeWs.send(JSON.stringify(terminalBytes(node.nodeId, 4, 'four')));
    await waitFor(() => client.messages.some((msg) => (msg as { seq?: number }).seq === 4));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(otherSessionClient.messages).not.toContainEqual(expect.objectContaining({ seq: 4 }));
  });

  it('drops terminal bytes from nodes that did not negotiate terminal-stream', async () => {
    relay = createRelayServer({ allowInsecureClients: true });
    await listen(relay);
    const node = relay.registerNode();
    const nodeWs = await connectNode(relay.url(), node.nodeId, node.nodeToken, { terminalStream: false });
    const client = await connectClient(relay.url(), node.nodeId, {
      terminalSessionId: 's1',
      terminalSessionEpoch: '1',
      afterSeq: '0',
    });
    sockets.push(nodeWs, client.ws);

    nodeWs.send(JSON.stringify(terminalBytes(node.nodeId, 1, 'blocked')));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(client.messages).not.toContainEqual(expect.objectContaining({ kind: 'terminal.bytes' }));
  });

  it('rejects terminal bytes from nodes without terminal-publication-gate.v1', async () => {
    relay = createRelayServer({ allowInsecureClients: true });
    await listen(relay);
    const node = relay.registerNode();
    const wsUrl = new URL('/relay/node', relay.url());
    wsUrl.protocol = 'ws:';
    const nodeWs = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${node.nodeToken}` } });
    sockets.push(nodeWs);
    await once(nodeWs, 'open');
    nodeWs.send(JSON.stringify(makeNodeHello({
      nodeId: node.nodeId as ReturnType<typeof makeNodeHello>['nodeId'],
      nodeEpoch: asNodeEpoch('1'),
      softwareVersion: 'test',
      supportedFeatures: [...PHASE1_SUPPORTED_FEATURES, 'terminal-stream'] satisfies RemoteFeature[],
    })));
    await waitFor(() => nodeWs.readyState === nodeWs.OPEN);
    const legacyBytes = terminalBytes(node.nodeId, 1, 'legacy') as TerminalStreamEvent;
    delete legacyBytes.publication;
    nodeWs.send(JSON.stringify(legacyBytes));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for gate close')), 1_000);
      nodeWs.on('close', (_code, reason) => {
        clearTimeout(timeout);
        expect(reason.toString()).toContain('terminal publication gate required');
        resolve();
      });
    });
  });

  it('rejects negotiated terminal bytes when publication metadata is missing', async () => {
    relay = createRelayServer({ allowInsecureClients: true });
    await listen(relay);
    const node = relay.registerNode();
    const nodeWs = await connectNode(relay.url(), node.nodeId, node.nodeToken);
    sockets.push(nodeWs);
    const legacyBytes = terminalBytes(node.nodeId, 1, 'metadata-missing') as TerminalStreamEvent;
    delete legacyBytes.publication;
    nodeWs.send(JSON.stringify(legacyBytes));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for gate close')), 1_000);
      nodeWs.on('close', (_code, reason) => {
        clearTimeout(timeout);
        expect(reason.toString()).toContain('terminal publication gate required');
        resolve();
      });
    });
  });

  it('keeps dashboard terminal state live-only even when afterSeq is requested', async () => {
    relay = createRelayServer({ allowInsecureClients: true });
    await listen(relay);
    const node = relay.registerNode();
    const firstNodeWs = await connectNode(relay.url(), node.nodeId, node.nodeToken, { nodeEpoch: '1' });
    sockets.push(firstNodeWs);
    firstNodeWs.send(JSON.stringify(terminalBytes(node.nodeId, 1, 'old-epoch', { nodeEpoch: '1' })));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const secondNodeWs = await connectNode(relay.url(), node.nodeId, node.nodeToken, { nodeEpoch: '2' });
    sockets.push(secondNodeWs);
    secondNodeWs.send(JSON.stringify(terminalBytes(node.nodeId, 1, 'new-one', { nodeEpoch: '2' })));
    secondNodeWs.send(JSON.stringify(terminalBytes(node.nodeId, 2, 'new-two', { nodeEpoch: '2' })));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const stateUrl = new URL('/relay/dashboard/state', relay.url());
    stateUrl.searchParams.set('nodeId', node.nodeId);
    stateUrl.searchParams.set('terminalSessionId', 's1');
    stateUrl.searchParams.set('terminalSessionEpoch', '1');
    stateUrl.searchParams.set('afterSeq', '1');
    const state = await fetch(stateUrl);
    expect(state.ok).toBe(true);
    const body = await state.json() as { terminalEvents: TerminalStreamEvent[] };

    expect(body.terminalEvents).toHaveLength(0);
    expect(body.terminalEvents).not.toContainEqual(expect.objectContaining({ nodeEpoch: '1' }));
  });

  it('drops slow clients and records the backpressure metric', async () => {
    relay = createRelayServer({
      allowInsecureClients: true,
      streamBackpressureBytes: -1,
    });
    await listen(relay);
    const node = relay.registerNode();
    const nodeWs = await connectNode(relay.url(), node.nodeId, node.nodeToken);
    const client = await connectClient(relay.url(), node.nodeId, {
      terminalSessionId: 's1',
      terminalSessionEpoch: '1',
    });
    sockets.push(nodeWs, client.ws);

    nodeWs.send(JSON.stringify(terminalBytes(node.nodeId, 1, 'one')));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for backpressure close')), 1_000);
      client.ws.on('close', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    expect(relay.streamMetrics().clientDropped.backpressure).toBe(1);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > 1_000) {
        clearInterval(timer);
        reject(new Error('timed out waiting for condition'));
      }
    }, 10);
  });
}

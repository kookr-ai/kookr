import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import { makeRelayHello, type NodeHello } from '../handshake.js';
import { createRemoteNodeClient, type RemoteNodeClient } from '../node-client.js';

async function listen(wss: WebSocketServer): Promise<number> {
  return await new Promise((resolve) => {
    wss.on('listening', () => {
      const address = wss.address();
      if (!address || typeof address === 'string') throw new Error('unexpected address');
      resolve(address.port);
    });
  });
}

describe('RemoteNodeClient', () => {
  let client: RemoteNodeClient | null = null;
  let wss: WebSocketServer | null = null;

  afterEach(async () => {
    await client?.stop();
    client = null;
    await new Promise<void>((resolve) => wss?.close(() => resolve()) ?? resolve());
    wss = null;
  });

  it('persists nodeEpoch before sending node.hello', async () => {
    const kookrDir = await mkdtemp(join(tmpdir(), 'kookr-node-client-'));
    let observedHello: NodeHello | null = null;
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1', path: '/relay/node' });
    wss.on('connection', (ws) => {
      ws.once('message', (data) => {
        observedHello = JSON.parse(data.toString()) as NodeHello;
        ws.send(JSON.stringify(makeRelayHello({
          outcome: 'accepted',
          acceptedVersion: 1,
          enabledFeatures: observedHello.supportedFeatures,
        })));
      });
    });
    const port = await listen(wss);

    client = await createRemoteNodeClient({
      relayUrl: `http://127.0.0.1:${port}`,
      token: 'token',
      kookrDir,
      softwareVersion: 'test',
      reconnectBaseMs: 10_000,
    });
    client.start();

    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (client?.status.relayConnected && observedHello) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - started > 2_000) {
          clearInterval(timer);
          reject(new Error('timed out waiting for relay handshake'));
        }
      }, 10);
    });

    expect(observedHello).toMatchObject({ type: 'node.hello', nodeEpoch: '1' });
    await expect(readFile(join(kookrDir, 'node-epoch'), 'utf8')).resolves.toBe('1\n');
    await expect(readFile(join(kookrDir, 'node-id'), 'utf8')).resolves.toContain(observedHello!.nodeId);
  });

  it('does not open a socket when stopped during async startup', async () => {
    const kookrDir = await mkdtemp(join(tmpdir(), 'kookr-node-client-race-'));
    let constructed = 0;

    client = await createRemoteNodeClient({
      relayUrl: 'http://127.0.0.1:1',
      token: 'token',
      kookrDir,
      softwareVersion: 'test',
      reconnectBaseMs: 10_000,
      wsImporter: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        class FakeWebSocket {
          readonly readyState = 0;
          constructor() {
            constructed += 1;
          }
          on(): void {}
          once(): void {}
          close(): void {}
          send(): void {}
        }
        return { WebSocket: FakeWebSocket } as unknown as typeof import('ws');
      },
    });

    client.start();
    await client.stop();

    expect(client.status.connectionState).toBe('stopped');
    expect(client.status.relayConnected).toBe(false);
    expect(constructed).toBe(0);
  });

  it('delivers policy messages to the handler and acknowledges them', async () => {
    const kookrDir = await mkdtemp(join(tmpdir(), 'kookr-node-client-policy-'));
    const policyMessages: unknown[] = [];
    const acks: unknown[] = [];
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1', path: '/relay/node' });
    wss.on('connection', (ws) => {
      ws.once('message', (data) => {
        const hello = JSON.parse(data.toString()) as NodeHello;
        ws.send(JSON.stringify(makeRelayHello({
          outcome: 'accepted',
          acceptedVersion: 1,
          enabledFeatures: hello.supportedFeatures,
        })));
        ws.on('message', (ack) => {
          acks.push(JSON.parse(ack.toString()) as unknown);
        });
        ws.send(JSON.stringify({
          type: 'policy.sync',
          nodeId: hello.nodeId,
          policyVersion: 1,
          grants: [{
            grantId: 'grant-sync',
            subject: { kind: 'task', nodeId: hello.nodeId, taskId: 'task-1' },
            grants: ['view'],
            policyVersion: 1,
          }],
          revokedGrantIds: ['grant-old'],
        }));
        ws.send(JSON.stringify({
          type: 'policy.delta',
          nodeId: hello.nodeId,
          policyVersion: 2,
          upserts: [{
            grantId: 'grant-delta',
            subject: { kind: 'task', nodeId: hello.nodeId, taskId: 'task-1' },
            grants: ['view', 'terminalInput'],
            policyVersion: 2,
          }],
          revokes: ['grant-sync'],
        }));
        ws.send(JSON.stringify({
          type: 'policy.revoke',
          nodeId: hello.nodeId,
          grantId: 'grant-1',
          policyVersion: 3,
        }));
        ws.send(JSON.stringify({
          type: 'policy.delta.ack',
          nodeId: hello.nodeId,
          policyVersion: 4,
          appliedGrantIds: [],
          revokedGrantIds: [],
        }));
      });
    });
    const port = await listen(wss);

    client = await createRemoteNodeClient({
      relayUrl: `http://127.0.0.1:${port}`,
      token: 'token',
      kookrDir,
      softwareVersion: 'test',
      reconnectBaseMs: 10_000,
      onPolicyMessage: (message) => {
        policyMessages.push(message);
      },
    });
    client.start();

    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (policyMessages.length === 4 && acks.length === 3) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - started > 2_000) {
          clearInterval(timer);
          reject(new Error('timed out waiting for policy message'));
        }
      }, 10);
    });

    expect(policyMessages).toContainEqual(expect.objectContaining({
      type: 'policy.revoke',
      grantId: 'grant-1',
      policyVersion: 3,
    }));
    expect(acks).toContainEqual({
      type: 'policy.delta.ack',
      nodeId: expect.any(String),
      policyVersion: 1,
      appliedGrantIds: ['grant-sync'],
      revokedGrantIds: ['grant-old'],
    });
    expect(acks).toContainEqual({
      type: 'policy.delta.ack',
      nodeId: expect.any(String),
      policyVersion: 2,
      appliedGrantIds: ['grant-delta'],
      revokedGrantIds: ['grant-sync'],
    });
    expect(acks).toContainEqual({
      type: 'policy.delta.ack',
      nodeId: expect.any(String),
      policyVersion: 3,
      appliedGrantIds: [],
      revokedGrantIds: ['grant-1'],
    });
    expect(acks).not.toContainEqual(expect.objectContaining({ policyVersion: 4 }));
  });
});

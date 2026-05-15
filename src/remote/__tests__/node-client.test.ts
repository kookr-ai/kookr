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

  it('delivers policy revoke messages to the policy handler', async () => {
    const kookrDir = await mkdtemp(join(tmpdir(), 'kookr-node-client-policy-'));
    const policyMessages: unknown[] = [];
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1', path: '/relay/node' });
    wss.on('connection', (ws) => {
      ws.once('message', (data) => {
        const hello = JSON.parse(data.toString()) as NodeHello;
        ws.send(JSON.stringify(makeRelayHello({
          outcome: 'accepted',
          acceptedVersion: 1,
          enabledFeatures: hello.supportedFeatures,
        })));
        ws.send(JSON.stringify({
          type: 'policy.revoke',
          nodeId: hello.nodeId,
          grantId: 'grant-1',
          policyVersion: 2,
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
        if (policyMessages.length > 0) {
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
      policyVersion: 2,
    }));
  });
});

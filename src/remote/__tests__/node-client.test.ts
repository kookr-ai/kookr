import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import { makeRelayHello, type NodeHello } from '../handshake.js';
import { asSessionEpoch, asSessionId } from '../ids.js';
import {
  createRemoteNodeClient,
  isPublishBufferOverloaded,
  type RemoteNodeClient,
} from '../node-client.js';
import type { TerminalStreamEvent } from '../stream-events.js';

async function listen(wss: WebSocketServer): Promise<number> {
  return await new Promise((resolve) => {
    wss.on('listening', () => {
      const address = wss.address();
      if (!address || typeof address === 'string') throw new Error('unexpected address');
      resolve(address.port);
    });
  });
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > 2_000) {
        clearInterval(timer);
        reject(new Error(message));
      }
    }, 10);
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
          enabledFeatures: [...observedHello.supportedFeatures, 'scoped-terminal-delivery.v1'],
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

  it('refuses trusted relay terminal mode when the relay lacks scoped delivery', async () => {
    const previousTrusted = process.env.KOOKR_RELAY_TRUSTED;
    process.env.KOOKR_RELAY_TRUSTED = 'true';
    try {
      const kookrDir = await mkdtemp(join(tmpdir(), 'kookr-node-client-scoped-delivery-'));
      let observedHello: NodeHello | null = null;
      wss = new WebSocketServer({ port: 0, host: '127.0.0.1', path: '/relay/node' });
      wss.on('connection', (ws) => {
        ws.once('message', (data) => {
          observedHello = JSON.parse(data.toString()) as NodeHello;
          ws.send(JSON.stringify(makeRelayHello({
            outcome: 'accepted',
            acceptedVersion: 1,
            enabledFeatures: observedHello.supportedFeatures.filter((feature) => feature !== 'scoped-terminal-delivery.v1'),
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
          if (client?.status.connectionState === 'backing-off') {
            clearInterval(timer);
            resolve();
          } else if (Date.now() - started > 2_000) {
            clearInterval(timer);
            reject(new Error('timed out waiting for scoped delivery refusal'));
          }
        }, 10);
      });

      expect(observedHello?.supportedFeatures).toContain('terminal-publication-gate.v1');
    expect(client.status.relayConnected).toBe(false);
    } finally {
      if (previousTrusted === undefined) delete process.env.KOOKR_RELAY_TRUSTED;
      else process.env.KOOKR_RELAY_TRUSTED = previousTrusted;
    }
  });

  it('delivers valid terminal publication demand messages to the handler', async () => {
    const kookrDir = await mkdtemp(join(tmpdir(), 'kookr-node-client-demand-'));
    let observedHello: NodeHello | null = null;
    const demands: unknown[] = [];
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1', path: '/relay/node' });
    wss.on('connection', (ws) => {
      ws.once('message', (data) => {
        observedHello = JSON.parse(data.toString()) as NodeHello;
        ws.send(JSON.stringify(makeRelayHello({
          outcome: 'accepted',
          acceptedVersion: 1,
          enabledFeatures: [...observedHello.supportedFeatures, 'scoped-terminal-delivery.v1'],
        })));
        ws.send(JSON.stringify({
          type: 'terminal.publicationDemand.v1',
          nodeId: observedHello.nodeId,
          principal: {
            kind: 'guest-member',
            invitationId: 'inv-1',
            memberSessionId: 'member-1',
            deviceId: 'device-a',
          },
          sessionId: 'session-1',
          sessionEpoch: '4',
          proof: {
            kind: 'guest-relay-presence',
            expiresAt: '2026-05-18T00:00:05.000Z',
          },
        }));
        ws.send(JSON.stringify({
          type: 'terminal.publicationDemand.v1',
          nodeId: observedHello.nodeId,
          principal: {
            kind: 'guest-member',
            invitationId: 'inv-1',
            memberSessionId: 'member-1',
            deviceId: 'device-a',
          },
          sessionId: 'session-1',
          sessionEpoch: '4',
          proof: {
            kind: 'guest-relay-presence',
            expiresAt: 'not-a-date',
          },
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
      onTerminalDemandProof: (message) => {
        demands.push(message);
      },
    });
    client.start();

    await waitFor(() => demands.length === 1, 'timed out waiting for terminal publication demand');

    expect(demands).toEqual([
      expect.objectContaining({
        type: 'terminal.publicationDemand.v1',
        nodeId: observedHello?.nodeId,
        principal: {
          kind: 'guest-member',
          invitationId: 'inv-1',
          memberSessionId: 'member-1',
          deviceId: 'device-a',
        },
        sessionId: asSessionId('session-1'),
        sessionEpoch: asSessionEpoch('4'),
        proof: { kind: 'guest-relay-presence', expiresAt: '2026-05-18T00:00:05.000Z' },
      }),
    ]);
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
          enabledFeatures: [...hello.supportedFeatures, 'scoped-terminal-delivery.v1'],
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

  it('isPublishBufferOverloaded only trips when bufferedAmount exceeds the limit', () => {
    expect(isPublishBufferOverloaded(null, 10)).toBe(false);
    expect(isPublishBufferOverloaded({ bufferedAmount: 0 }, 10)).toBe(false);
    expect(isPublishBufferOverloaded({ bufferedAmount: 10 }, 10)).toBe(false);
    expect(isPublishBufferOverloaded({ bufferedAmount: 11 }, 10)).toBe(true);
    expect(isPublishBufferOverloaded({ bufferedAmount: Number.NaN }, 10)).toBe(false);
    expect(isPublishBufferOverloaded({ bufferedAmount: 5 }, Number.NaN)).toBe(false);
  });

  it('returns false from publish without send when bufferedAmount exceeds the limit', async () => {
    const kookrDir = await mkdtemp(join(tmpdir(), 'kookr-node-client-backpressure-'));
    const sent: string[] = [];
    let fakeWs: {
      readyState: number;
      bufferedAmount: number;
      OPEN: number;
      on: (event: string, handler: (...args: unknown[]) => void) => void;
      once: (event: string, handler: (...args: unknown[]) => void) => void;
      close: () => void;
      send: (data: string) => void;
    } | null = null;
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>();

    client = await createRemoteNodeClient({
      relayUrl: 'http://127.0.0.1:9',
      token: 'token',
      kookrDir,
      softwareVersion: 'test',
      reconnectBaseMs: 10_000,
      publishBufferedAmountLimit: 10,
      wsImporter: async () => {
        class ControllableWebSocket {
          static readonly OPEN = 1;
          static readonly CLOSED = 3;
          readonly OPEN = 1;
          readonly CLOSED = 3;
          readyState = 0;
          bufferedAmount = 0;
          constructor() {
            fakeWs = this;
            queueMicrotask(() => {
              this.readyState = ControllableWebSocket.OPEN;
              for (const handler of handlers.get('open') ?? []) handler();
            });
          }
          on(event: string, handler: (...args: unknown[]) => void): this {
            const list = handlers.get(event) ?? [];
            list.push(handler);
            handlers.set(event, list);
            return this;
          }
          once(event: string, handler: (...args: unknown[]) => void): this {
            return this.on(event, handler);
          }
          close(): void {
            this.readyState = ControllableWebSocket.CLOSED;
            for (const handler of handlers.get('close') ?? []) handler(1000, Buffer.from(''));
          }
          send(data: string): void {
            sent.push(data);
            // After node.hello, the real client expects relay.hello before publish works.
            if (data.includes('"type":"node.hello"')) {
              const hello = JSON.parse(data) as NodeHello;
              queueMicrotask(() => {
                for (const handler of handlers.get('message') ?? []) {
                  handler(Buffer.from(JSON.stringify(makeRelayHello({
                    outcome: 'accepted',
                    acceptedVersion: 1,
                    enabledFeatures: [...hello.supportedFeatures, 'scoped-terminal-delivery.v1'],
                  }))));
                }
              });
            }
          }
        }
        return { WebSocket: ControllableWebSocket } as unknown as typeof import('ws');
      },
    });
    client.start();
    await waitFor(() => client?.status.relayConnected === true, 'timed out waiting for fake relay connect');

    const terminalEvent = {
      nodeId: client.status.nodeId,
      nodeEpoch: client.status.nodeEpoch,
      sessionId: asSessionId('s1'),
      sessionEpoch: asSessionEpoch('1'),
      seq: 1,
      ts: new Date().toISOString(),
      kind: 'terminal.bytes',
      payload: { encoding: 'base64', data: '', byteLength: 0 },
    } as TerminalStreamEvent;

    const controlEvent = {
      nodeId: client.status.nodeId,
      nodeEpoch: client.status.nodeEpoch,
      serverRevision: 1,
      ts: new Date().toISOString(),
      kind: 'snapshot' as const,
      payload: {},
    };

    // Below threshold: terminal send proceeds.
    if (!fakeWs) throw new Error('fake websocket not constructed');
    fakeWs.bufferedAmount = 10;
    const before = sent.length;
    expect(client.publish(terminalEvent)).toBe(true);
    expect(sent.length).toBe(before + 1);

    // Above threshold: terminal frames are dropped without send.
    fakeWs.bufferedAmount = 11;
    expect(client.publish(terminalEvent)).toBe(false);
    expect(sent.length).toBe(before + 1);

    // Control-plane events still send while the soft limit is elevated.
    expect(client.publish(controlEvent)).toBe(true);
    expect(sent.length).toBe(before + 2);
  });
});

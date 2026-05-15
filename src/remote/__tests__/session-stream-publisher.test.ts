import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import WebSocket from 'ws';
import { describe, expect, it, vi } from 'vitest';

import { FakeTerminalBackend } from '../../adapters/fake-terminal-backend.js';
import { createSessionStreamPublisher } from '../session-stream-publisher.js';
import { asNodeEpoch, asNodeId } from '../ids.js';
import type { TerminalStreamEvent } from '../stream-events.js';
import { createRemoteNodeClient } from '../node-client.js';
import { createRelayServer } from '../../../relay/server.js';

function makeRemoteClient(events: TerminalStreamEvent[] = []) {
  return {
    status: {
      relayConnected: true,
      protocolVersion: 1,
      nodeId: asNodeId('node-1'),
      nodeEpoch: asNodeEpoch('1'),
      nodeMode: 'active' as const,
      connectionState: 'connected' as const,
      features: { enabled: [], disabled: [] },
    },
    publish(event: TerminalStreamEvent): boolean {
      events.push(event);
      return true;
    },
  };
}

describe('SessionStreamPublisher', () => {
  it('does not subscribe or publish unless KOOKR_RELAY_TRUSTED is true', async () => {
    const backend = new FakeTerminalBackend();
    await backend.createSession({ id: 's1', command: 'agent', args: [] });
    const events: TerminalStreamEvent[] = [];
    const warn = vi.fn();
    const publisher = createSessionStreamPublisher({
      terminalBackend: backend,
      remoteNodeClient: makeRemoteClient(events),
      env: { KOOKR_RELAY_TRUSTED: '' },
      logger: { warn },
    });

    await publisher.start();
    backend.emit('s1', 'secret');

    expect(publisher.trusted).toBe(false);
    expect(events).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('remote terminal viewing disabled'));
  });

  it('publishes terminal bytes with per-session sequence numbers', async () => {
    const backend = new FakeTerminalBackend();
    await backend.createSession({ id: 's1', command: 'agent', args: [] });
    await backend.createSession({ id: 's2', command: 'agent', args: [] });
    const events: TerminalStreamEvent[] = [];
    const publisher = createSessionStreamPublisher({
      terminalBackend: backend,
      remoteNodeClient: makeRemoteClient(events),
      env: { KOOKR_RELAY_TRUSTED: 'true' },
    });
    await publisher.start();

    backend.emit('s1', 'abcd');
    backend.emit('s1', 'efgh');
    backend.emit('s2', 'wxyz');

    const s1Events = events.filter((event) => event.sessionId === 's1');
    const s2Events = events.filter((event) => event.sessionId === 's2');
    expect(s1Events.map((event) => event.seq)).toEqual([1, 2]);
    expect(s2Events.map((event) => event.seq)).toEqual([1]);
    expect(s1Events[0]).toMatchObject({
      nodeId: 'node-1',
      nodeEpoch: '1',
      sessionId: 's1',
      sessionEpoch: '1',
      kind: 'terminal.bytes',
      payload: { encoding: 'base64', byteLength: 4 },
    });
    expect(s2Events[0]).toMatchObject({
      sessionId: 's2',
      sessionEpoch: '1',
      kind: 'terminal.bytes',
    });

    await backend.killSession('s1');
    await publisher.syncSessions();
    await backend.createSession({ id: 's1', command: 'agent', args: [] });
    await publisher.syncSessions();
    backend.emit('s1', 'reset');

    const restartedS1 = events.find((event) => event.sessionId === 's1' && event.sessionEpoch === '2');
    expect(restartedS1).toMatchObject({
      sessionId: 's1',
      sessionEpoch: '2',
      seq: 1,
      kind: 'terminal.bytes',
    });
    publisher.stop();
  });

  it('publishes backend bytes through RemoteNodeClient to a relay client', async () => {
    const relay = createRelayServer({ allowInsecureClients: true });
    const sockets: WebSocket[] = [];
    const previousTrusted = process.env.KOOKR_RELAY_TRUSTED;
    try {
      await new Promise<void>((resolve) => relay.httpServer.listen(0, '127.0.0.1', () => resolve()));
      const issued = relay.registerNode();
      const clientWsUrl = new URL('/relay/client', relay.url());
      clientWsUrl.protocol = 'ws:';
      clientWsUrl.searchParams.set('nodeId', issued.nodeId);
      clientWsUrl.searchParams.set('terminalSessionId', 's1');
      clientWsUrl.searchParams.set('terminalSessionEpoch', '1');
      const relayClient = new WebSocket(clientWsUrl);
      const relayMessages: unknown[] = [];
      relayClient.on('message', (data) => {
        relayMessages.push(JSON.parse(data.toString()) as unknown);
      });
      sockets.push(relayClient);
      await once(relayClient, 'open');

      process.env.KOOKR_RELAY_TRUSTED = 'true';
      const kookrDir = await mkdtemp(join(tmpdir(), 'kookr-stream-runtime-'));
      await writeFile(join(kookrDir, 'node-id'), `${issued.nodeId}\n`, 'utf8');
      const remoteNodeClient = await createRemoteNodeClient({
        relayUrl: relay.url(),
        token: issued.nodeToken,
        kookrDir,
        softwareVersion: 'test',
        reconnectBaseMs: 10_000,
      });
      remoteNodeClient.start();
      await waitFor(() => remoteNodeClient.status.relayConnected);

      const backend = new FakeTerminalBackend();
      await backend.createSession({ id: 's1', command: 'agent', args: [] });
      const publisher = createSessionStreamPublisher({
        terminalBackend: backend,
        remoteNodeClient,
        env: { KOOKR_RELAY_TRUSTED: 'true' },
      });
      await publisher.start();
      backend.emit('s1', 'runtime-path');

      await waitFor(() => relayMessages.some((msg) => (msg as { kind?: string }).kind === 'terminal.bytes'));
      expect(relayMessages).toContainEqual(expect.objectContaining({
        kind: 'terminal.bytes',
        sessionId: 's1',
        seq: 1,
        payload: expect.objectContaining({
          data: Buffer.from('runtime-path').toString('base64'),
        }),
      }));

      publisher.stop();
      await remoteNodeClient.stop();
    } finally {
      if (previousTrusted === undefined) delete process.env.KOOKR_RELAY_TRUSTED;
      else process.env.KOOKR_RELAY_TRUSTED = previousTrusted;
      for (const socket of sockets) {
        if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.close();
      }
      await relay.close();
    }
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > 2_000) {
        clearInterval(timer);
        reject(new Error('timed out waiting for condition'));
      }
    }, 10);
  });
}

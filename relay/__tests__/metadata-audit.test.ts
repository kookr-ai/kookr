import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import { createRelayServer, type RelayServerHandle } from '../server.js';
import { executeWithPipeline } from '../../src/remote/command-pipeline.js';
import { CommandJournal } from '../../src/remote/command-journal.js';
import { makeNodeHello, PHASE1_SUPPORTED_FEATURES } from '../../src/remote/handshake.js';
import { asActorId, asClientId, asCommandId, asGrantId, asIdempotencyKey, asNodeEpoch, asSessionEpoch, asSessionId } from '../../src/remote/ids.js';
import { createRemoteNodeClient, type RemoteNodeClient } from '../../src/remote/node-client.js';

async function listen(relay: RelayServerHandle): Promise<void> {
  await new Promise<void>((resolve) => relay.httpServer.listen(0, '127.0.0.1', () => resolve()));
}

describe('relay command metadata audit', () => {
  let relay: RelayServerHandle | null = null;
  let remoteNodeClient: RemoteNodeClient | null = null;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets.splice(0)) {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
    }
    await remoteNodeClient?.stop();
    remoteNodeClient = null;
    await relay?.close();
    relay = null;
  });

  it('records terminal command outcomes joinable by commandId', async () => {
    relay = createRelayServer({ allowInsecureClients: true });
    await listen(relay);
    const node = relay.registerNode();

    const nodeUrl = new URL('/relay/node', relay.url());
    nodeUrl.protocol = 'ws:';
    const nodeWs = new WebSocket(nodeUrl, { headers: { authorization: `Bearer ${node.nodeToken}` } });
    sockets.push(nodeWs);
    await once(nodeWs, 'open');
    nodeWs.send(JSON.stringify(makeNodeHello({
      nodeId: node.nodeId,
      nodeEpoch: asNodeEpoch('1'),
      softwareVersion: 'test',
      supportedFeatures: PHASE1_SUPPORTED_FEATURES,
    })));
    await once(nodeWs, 'message');

    const clientUrl = new URL('/relay/client', relay.url());
    clientUrl.protocol = 'ws:';
    clientUrl.searchParams.set('nodeId', node.nodeId);
    const clientWs = new WebSocket(clientUrl);
    sockets.push(clientWs);
    await once(clientWs, 'open');

    const seenByNode = new Promise<void>((resolve) => {
      nodeWs.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as { type?: string; commandId?: string; action?: string };
        if (msg.type === 'remote.command') {
          expect(msg.commandId).toBe('cmd-1');
          nodeWs.send(JSON.stringify({
            type: 'remote.command.result',
            commandId: msg.commandId,
            action: msg.action,
            outcome: 'accepted',
          }));
          resolve();
        }
      });
    });

    clientWs.send(JSON.stringify({
      type: 'remote.command',
      commandId: 'cmd-1',
      action: 'presetReply',
      nodeEpoch: '1',
    }));
    await seenByNode;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(relay.metadataAuditRows()).toEqual([
      expect.objectContaining({ type: 'relay.metadata-audit', commandId: 'cmd-1', outcome: 'forwarded' }),
      expect.objectContaining({ type: 'relay.metadata-audit', commandId: 'cmd-1', outcome: 'accepted' }),
    ]);
  });

  it('joins node intent/result audit rows with relay metadata rows by commandId', async () => {
    relay = createRelayServer({ allowInsecureClients: true });
    await listen(relay);
    const node = relay.registerNode();
    const kookrDir = await mkdtemp(join(tmpdir(), 'kookr-relay-audit-'));
    await writeFile(join(kookrDir, 'node-id'), `${node.nodeId}\n`, 'utf8');
    const journal = await CommandJournal.open({
      kookrDir,
      nodeId: node.nodeId,
      nodeEpoch: asNodeEpoch('1'),
    });
    remoteNodeClient = await createRemoteNodeClient({
      relayUrl: relay.url(),
      token: node.nodeToken,
      kookrDir,
      softwareVersion: 'test',
      reconnectBaseMs: 10_000,
      onCommand: async (command) => await executeWithPipeline({
        journal,
        request: command,
        isOwnerLocal: () => true,
        handler: {
          action: 'presetReply',
          authorize: () => ({ ok: true as const }),
          validate: () => ({ ok: true as const }),
          execute: async () => ({ preview: 'continue' }),
        },
      }),
    });
    remoteNodeClient.start();
    await waitFor(() => remoteNodeClient?.status.relayConnected === true);

    const clientUrl = new URL('/relay/client', relay.url());
    clientUrl.protocol = 'ws:';
    clientUrl.searchParams.set('nodeId', node.nodeId);
    const clientWs = new WebSocket(clientUrl);
    sockets.push(clientWs);
    const messages: unknown[] = [];
    clientWs.on('message', (data) => messages.push(JSON.parse(data.toString()) as unknown));
    await once(clientWs, 'open');

    clientWs.send(JSON.stringify({
      type: 'remote.command',
      commandId: asCommandId('cmd-join'),
      actorId: asActorId('local-owner'),
      clientId: asClientId('client-1'),
      nodeId: node.nodeId,
      nodeEpoch: asNodeEpoch('1'),
      sessionId: asSessionId('session-1'),
      sessionEpoch: asSessionEpoch('1'),
      grantId: asGrantId('grant-1'),
      idempotencyKey: asIdempotencyKey('idem-1'),
      action: 'presetReply',
      payload: { presetId: 'continue' },
    }));

    await waitFor(() => messages.some((msg) => (msg as { commandId?: string }).commandId === 'cmd-join'));
    const audit = await readFile(join(kookrDir, 'audit.jsonl'), 'utf8');
    expect(audit).toContain('"type":"command.intent"');
    expect(audit).toContain('"type":"command.result"');
    expect(audit).toContain('"commandId":"cmd-join"');
    expect(relay.metadataAuditRows().filter((row) => row.commandId === 'cmd-join')).toEqual([
      expect.objectContaining({ outcome: 'forwarded' }),
      expect.objectContaining({ outcome: 'accepted' }),
    ]);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > 1_500) {
        clearInterval(timer);
        reject(new Error('timed out waiting for condition'));
      }
    }, 10);
  });
}

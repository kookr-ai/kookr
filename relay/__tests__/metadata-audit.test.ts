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
import { asActorId, asClientId, asCommandId, asGrantId, asIdempotencyKey, asNodeEpoch, asPolicyVersion, asSeq, asSessionEpoch, asSessionId } from '../../src/remote/ids.js';
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

  it('records terminal publication metadata without terminal payloads', async () => {
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
      supportedFeatures: [...PHASE1_SUPPORTED_FEATURES, 'terminal-stream', 'terminal-publication-gate.v1'],
    })));
    await once(nodeWs, 'message');

    nodeWs.send(JSON.stringify({
      nodeId: node.nodeId,
      nodeEpoch: asNodeEpoch('1'),
      sessionId: asSessionId('session-1'),
      sessionEpoch: asSessionEpoch('1'),
      seq: asSeq(7),
      ts: new Date().toISOString(),
      kind: 'terminal.bytes',
      payload: {
        encoding: 'base64',
        data: Buffer.from('SECRET_TERMINAL_PAYLOAD').toString('base64'),
        byteLength: Buffer.byteLength('SECRET_TERMINAL_PAYLOAD'),
      },
      publication: {
        publicationScopeId: 'scope-audit',
        principal: { kind: 'guest-member', invitationId: 'inv-1', memberSessionId: 'member-1', deviceId: 'device-1' },
        policyVersion: asPolicyVersion(2),
        streamEncryption: { kind: 'guest-transport', memberSessionId: 'member-1' },
      },
    }));
    await waitFor(() => relay!.metadataAuditRows().some((row) => row.publicationScopeId === 'scope-audit'));

    const rows = relay.metadataAuditRows().filter((row) => row.publicationScopeId === 'scope-audit');
    expect(rows).toEqual([
      expect.objectContaining({
        outcome: 'forwarded',
        nodeId: node.nodeId,
        relayId: 'hosted-owner',
        principalKind: 'guest-member',
        pseudonymousMemberId: expect.stringMatching(/^[a-f0-9]{24}$/),
        pseudonymousSessionId: expect.stringMatching(/^[a-f0-9]{24}$/),
        policyVersion: asPolicyVersion(2),
        byteCount: Buffer.byteLength('SECRET_TERMINAL_PAYLOAD'),
        seqFrom: 7,
        seqTo: 7,
        revocationAckState: 'not-revoked',
      }),
    ]);
    expect(JSON.stringify(rows)).not.toContain('SECRET_TERMINAL_PAYLOAD');
    expect(JSON.stringify(rows)).not.toContain(Buffer.from('SECRET_TERMINAL_PAYLOAD').toString('base64'));
    expect(JSON.stringify(rows)).not.toContain('member-1');
    expect(JSON.stringify(rows)).not.toContain('device-1');
    expect(JSON.stringify(rows)).not.toContain('inv-1');
    expect(JSON.stringify(rows)).not.toContain('session-1');
  });

  it('bounds metadataAudit as a ring buffer and discloses truncation on the admin route', async () => {
    const cap = 5;
    relay = createRelayServer({
      allowInsecureClients: true,
      allowInsecureAdmin: true,
      adminToken: 'admin',
      metadataAuditCap: cap,
    });
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
      supportedFeatures: [...PHASE1_SUPPORTED_FEATURES, 'terminal-stream', 'terminal-publication-gate.v1'],
    })));
    await once(nodeWs, 'message');

    const sendTerminalFrame = (seq: number): void => {
      nodeWs.send(JSON.stringify({
        nodeId: node.nodeId,
        nodeEpoch: asNodeEpoch('1'),
        sessionId: asSessionId('session-1'),
        sessionEpoch: asSessionEpoch('1'),
        seq: asSeq(seq),
        ts: new Date().toISOString(),
        kind: 'terminal.bytes',
        payload: {
          encoding: 'base64',
          data: Buffer.from(`frame-${seq}`).toString('base64'),
          byteLength: Buffer.byteLength(`frame-${seq}`),
        },
        publication: {
          publicationScopeId: `scope-${seq}`,
          principal: { kind: 'guest-member', invitationId: 'inv-1', memberSessionId: 'member-1', deviceId: 'device-1' },
          policyVersion: asPolicyVersion(1),
          streamEncryption: { kind: 'guest-transport', memberSessionId: 'member-1' },
        },
      }));
    };

    // Under-cap baseline: no ring drops, full history is complete.
    for (let seq = 1; seq <= 3; seq += 1) sendTerminalFrame(seq);
    await waitFor(() => relay!.metadataAuditRows().some((row) => row.publicationScopeId === 'scope-3'));

    const underCap = await fetch(new URL('/relay/admin/metadata-audit', relay.url()), {
      headers: { authorization: 'Bearer admin' },
    });
    expect(underCap.status).toBe(200);
    const underCapBody = await underCap.json() as {
      rows: Array<{ publicationScopeId?: string }>;
      cap: number;
      retained: number;
      droppedCount: number;
      truncated: boolean;
      limit?: number;
    };
    expect(underCapBody).toMatchObject({
      cap,
      retained: 3,
      droppedCount: 0,
      truncated: false,
    });
    expect(underCapBody).not.toHaveProperty('limit');
    expect(underCapBody.rows.map((row) => row.publicationScopeId)).toEqual(['scope-1', 'scope-2', 'scope-3']);

    // Limit-only truncation with no ring overflow.
    const limitOnly = await fetch(new URL('/relay/admin/metadata-audit?limit=2', relay.url()), {
      headers: { authorization: 'Bearer admin' },
    });
    const limitOnlyBody = await limitOnly.json() as {
      rows: Array<{ publicationScopeId?: string }>;
      limit: number;
      retained: number;
      droppedCount: number;
      truncated: boolean;
    };
    expect(limitOnlyBody).toMatchObject({
      limit: 2,
      retained: 3,
      droppedCount: 0,
      truncated: true,
    });
    expect(limitOnlyBody.rows.map((row) => row.publicationScopeId)).toEqual(['scope-2', 'scope-3']);

    // Overflow the ring: cap + 3 total events (3 already present + 5 more = 8).
    for (let seq = 4; seq <= 8; seq += 1) sendTerminalFrame(seq);
    await waitFor(() => relay!.metadataAuditRows().some((row) => row.publicationScopeId === 'scope-8'));
    const retained = relay.metadataAuditRows();
    expect(retained).toHaveLength(cap);
    // Oldest (seq 1..3) evicted; newest (seq 4..8) retained.
    expect(retained.map((row) => row.publicationScopeId)).toEqual(
      Array.from({ length: cap }, (_, i) => `scope-${i + 4}`),
    );

    const full = await fetch(new URL('/relay/admin/metadata-audit', relay.url()), {
      headers: { authorization: 'Bearer admin' },
    });
    expect(full.status).toBe(200);
    const fullBody = await full.json() as {
      rows: Array<{ publicationScopeId?: string }>;
      cap: number;
      retained: number;
      droppedCount: number;
      truncated: boolean;
    };
    expect(fullBody).toMatchObject({
      cap,
      retained: cap,
      droppedCount: 3,
      truncated: true,
    });
    expect(fullBody.rows).toHaveLength(cap);
    expect(fullBody.rows.map((row) => row.publicationScopeId)).toEqual(['scope-4', 'scope-5', 'scope-6', 'scope-7', 'scope-8']);

    const limited = await fetch(new URL('/relay/admin/metadata-audit?limit=2', relay.url()), {
      headers: { authorization: 'Bearer admin' },
    });
    expect(limited.status).toBe(200);
    const limitedBody = await limited.json() as {
      rows: Array<{ publicationScopeId?: string }>;
      limit: number;
      truncated: boolean;
      droppedCount: number;
      retained: number;
    };
    expect(limitedBody).toMatchObject({
      limit: 2,
      retained: cap,
      droppedCount: 3,
      truncated: true,
    });
    expect(limitedBody.rows).toHaveLength(2);
    expect(limitedBody.rows.map((row) => row.publicationScopeId)).toEqual(['scope-7', 'scope-8']);
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

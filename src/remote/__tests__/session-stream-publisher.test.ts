import { once } from 'node:events';
import { createDecipheriv, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import WebSocket from 'ws';
import { describe, expect, it, vi } from 'vitest';

import { FakeTerminalBackend } from '../../adapters/fake-terminal-backend.js';
import { createSessionStreamPublisher } from '../session-stream-publisher.js';
import { asNodeEpoch, asNodeId, asPolicyVersion, asSessionEpoch, asSessionId } from '../ids.js';
import type { TerminalBytesPayload, TerminalPublicationMetadata, TerminalStreamEvent } from '../stream-events.js';
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

    expect(publisher.installPublicationRule({
      publicationScopeId: 'scope-s1',
      principal: { kind: 'guest-member', invitationId: 'inv-1', memberSessionId: 'member-1', deviceId: 'device-1' },
      sessionId: asSessionId('s1'),
      sessionEpoch: asSessionEpoch('1'),
      approvedAt: new Date().toISOString(),
      policyVersion: asPolicyVersion(1),
    })).toEqual(expect.objectContaining({ ok: true }));
    publisher.recordDemandProof({
      principal: { kind: 'guest-member', invitationId: 'inv-1', memberSessionId: 'member-1', deviceId: 'device-1' },
      sessionId: asSessionId('s1'),
      sessionEpoch: asSessionEpoch('1'),
      proof: { kind: 'guest-relay-presence', expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });
    expect(publisher.installPublicationRule({
      publicationScopeId: 'scope-s2',
      principal: { kind: 'guest-member', invitationId: 'inv-2', memberSessionId: 'member-2', deviceId: 'device-2' },
      sessionId: asSessionId('s2'),
      sessionEpoch: asSessionEpoch('1'),
      approvedAt: new Date().toISOString(),
      policyVersion: asPolicyVersion(1),
    })).toEqual(expect.objectContaining({ ok: true }));
    publisher.recordDemandProof({
      principal: { kind: 'guest-member', invitationId: 'inv-2', memberSessionId: 'member-2', deviceId: 'device-2' },
      sessionId: asSessionId('s2'),
      sessionEpoch: asSessionEpoch('1'),
      proof: { kind: 'guest-relay-presence', expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });

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
      publication: {
        publicationScopeId: 'scope-s1',
        principal: { kind: 'guest-member', invitationId: 'inv-1', memberSessionId: 'member-1', deviceId: 'device-1' },
        policyVersion: asPolicyVersion(1),
      },
      payload: { encoding: 'base64', byteLength: 4 },
    });
    expect(s2Events[0]).toMatchObject({
      sessionId: 's2',
      sessionEpoch: '1',
      kind: 'terminal.bytes',
      publication: {
        publicationScopeId: 'scope-s2',
        principal: { kind: 'guest-member', invitationId: 'inv-2', memberSessionId: 'member-2', deviceId: 'device-2' },
        policyVersion: asPolicyVersion(1),
      },
    });

    await backend.killSession('s1');
    await publisher.syncSessions();
    await backend.createSession({ id: 's1', command: 'agent', args: [] });
    await publisher.syncSessions();
    publisher.installPublicationRule({
      publicationScopeId: 'scope-s1-restarted',
      principal: { kind: 'guest-member', invitationId: 'inv-1', memberSessionId: 'member-1', deviceId: 'device-1' },
      sessionId: asSessionId('s1'),
      sessionEpoch: asSessionEpoch('2'),
      approvedAt: new Date().toISOString(),
      policyVersion: asPolicyVersion(2),
    });
    publisher.recordDemandProof({
      principal: { kind: 'guest-member', invitationId: 'inv-1', memberSessionId: 'member-1', deviceId: 'device-1' },
      sessionId: asSessionId('s1'),
      sessionEpoch: asSessionEpoch('2'),
      proof: { kind: 'guest-relay-presence', expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });
    backend.emit('s1', 'reset');

    const restartedS1 = events.find((event) => event.sessionId === 's1' && event.sessionEpoch === '2');
    expect(restartedS1).toMatchObject({
      sessionId: 's1',
      sessionEpoch: '2',
      seq: 1,
      kind: 'terminal.bytes',
      publication: expect.objectContaining({ publicationScopeId: 'scope-s1-restarted' }),
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
      publisher.installPublicationRule({
        publicationScopeId: 'scope-runtime',
        principal: { kind: 'guest-member', invitationId: 'inv-runtime', memberSessionId: 'member-runtime', deviceId: 'device-runtime' },
        sessionId: asSessionId('s1'),
        sessionEpoch: asSessionEpoch('1'),
        approvedAt: new Date().toISOString(),
        policyVersion: asPolicyVersion(1),
      });
      publisher.recordDemandProof({
        principal: { kind: 'guest-member', invitationId: 'inv-runtime', memberSessionId: 'member-runtime', deviceId: 'device-runtime' },
        sessionId: asSessionId('s1'),
        sessionEpoch: asSessionEpoch('1'),
        proof: { kind: 'guest-relay-presence', expiresAt: new Date(Date.now() + 60_000).toISOString() },
      });
      backend.emit('s1', 'runtime-path');

      await waitFor(() => relayMessages.some((msg) => (msg as { kind?: string }).kind === 'terminal.bytes'));
      expect(relayMessages).toContainEqual(expect.objectContaining({
        kind: 'terminal.bytes',
        sessionId: 's1',
        seq: 1,
        publication: expect.objectContaining({ publicationScopeId: 'scope-runtime' }),
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

  it('encrypts contact-device terminal frames so only the recipient device key decrypts them', async () => {
    const recipient = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const wrongRecipient = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const recipientPublicKey = recipient.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const recipientPrivateKey = recipient.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const wrongPrivateKey = wrongRecipient.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const backend = new FakeTerminalBackend();
    await backend.createSession({ id: 's1', command: 'agent', args: [] });
    const events: TerminalStreamEvent[] = [];
    const publisher = createSessionStreamPublisher({
      terminalBackend: backend,
      remoteNodeClient: makeRemoteClient(events),
      env: { KOOKR_RELAY_TRUSTED: 'true' },
    });
    await publisher.start();
    expect(publisher.installPublicationRule({
      publicationScopeId: 'scope-contact',
      principal: { kind: 'contact-device', contactId: 'contact-1', deviceId: 'device-1' },
      sessionId: asSessionId('s1'),
      sessionEpoch: asSessionEpoch('1'),
      approvedAt: new Date().toISOString(),
      policyVersion: asPolicyVersion(1),
      streamEncryption: {
        kind: 'contact-e2ee',
        recipientDeviceId: 'device-1',
        recipientPublicKey,
        streamKeyId: 'stream-key-1',
      },
    })).toEqual(expect.objectContaining({ ok: true }));
    publisher.recordDemandProof({
      principal: { kind: 'contact-device', contactId: 'contact-1', deviceId: 'device-1' },
      sessionId: asSessionId('s1'),
      sessionEpoch: asSessionEpoch('1'),
      proof: { kind: 'recipient-signed-heartbeat', heartbeatKeyId: 'heartbeat-1', expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });

    backend.emit('s1', 'CONTACT_SECRET_OUTPUT');

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(Buffer.from(event.payload.data, 'base64').toString('utf8')).not.toContain('CONTACT_SECRET_OUTPUT');
    expect(event.publication?.streamEncryption).toEqual(expect.objectContaining({
      kind: 'contact-e2ee',
      recipientDeviceId: 'device-1',
      streamKeyId: 'stream-key-1',
      alg: 'RSA-OAEP-SHA256+A256GCM',
    }));
    const aad = `${event.nodeId}:${event.sessionId}:${event.sessionEpoch}:${event.seq}`;
    expect(decryptContactTerminalPayload(event.payload, event.publication?.streamEncryption, recipientPrivateKey, aad).toString('utf8'))
      .toBe('CONTACT_SECRET_OUTPUT');
    expect(() => decryptContactTerminalPayload(event.payload, event.publication?.streamEncryption, wrongPrivateKey, aad)).toThrow();
    publisher.stop();
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

function decryptContactTerminalPayload(
  payload: TerminalBytesPayload,
  streamEncryption: TerminalPublicationMetadata['streamEncryption'],
  recipientPrivateKey: string,
  aad?: string,
): Buffer {
  if (!streamEncryption || streamEncryption.kind !== 'contact-e2ee') {
    throw new Error('contact terminal frame encryption metadata required');
  }
  const key = privateDecrypt(
    { key: recipientPrivateKey, oaepHash: 'sha256' },
    Buffer.from(streamEncryption.wrappedKey, 'base64'),
  );
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(streamEncryption.iv, 'base64'));
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(streamEncryption.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]);
}

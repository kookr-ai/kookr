import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeNodeHello } from '../../src/remote/handshake.js';
import { asNodeEpoch } from '../../src/remote/ids.js';
import { createRelayServer, type RelayServerHandle } from '../server.js';
import { RelaySqliteStateStore } from '../src/state/sqlite.js';
import type { InvitationRecord } from '../src/invitations/store.js';
import type { PersistedNodeRegistration, RelayStateSnapshot } from '../src/state/sqlite.js';

async function listen(relay: RelayServerHandle): Promise<void> {
  await new Promise<void>((resolve) => relay.httpServer.listen(0, '127.0.0.1', () => resolve()));
}

async function connectNode(relay: RelayServerHandle, nodeId: string, token: string): Promise<WebSocket> {
  const wsUrl = new URL('/relay/node', relay.url());
  wsUrl.protocol = 'ws:';
  const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(JSON.stringify(makeNodeHello({
    nodeId: nodeId as ReturnType<typeof makeNodeHello>['nodeId'],
    nodeEpoch: asNodeEpoch('1'),
    softwareVersion: 'test',
  })));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for relay hello')), 1_500);
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as { type?: string; outcome?: string };
      if (msg.type === 'relay.hello' && msg.outcome === 'accepted') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return ws;
}

describe('relay SQLite state', () => {
  let relay: RelayServerHandle | null = null;
  let tmp: string | null = null;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.close();
    await relay?.close();
    relay = null;
    if (tmp) await rm(tmp, { recursive: true, force: true });
    tmp = null;
    vi.restoreAllMocks();
  });

  it('reloads node registrations, share tickets, and per-share lockout counters after restart', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kookr-relay-state-'));
    const dbPath = join(tmp, 'relay.sqlite');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    relay = createRelayServer({ adminToken: 'admin', stateDbPath: dbPath });
    await listen(relay);
    const node = relay.registerNode({ displayName: 'desktop' });
    const created = relay.createInvitation({
      nodeId: node.nodeId,
      subject: { kind: 'task', nodeId: node.nodeId, taskId: 'task-a' },
      grants: ['view'],
      ttlMs: 60_000,
      shareTicket: true,
    });
    if (!created.shareTicket) throw new Error('expected share ticket');
    for (let i = 0; i < 5; i += 1) {
      const res = await fetch(`${relay.url()}/relay/share-tickets/accept`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${i + 1}` },
        body: JSON.stringify({ shareId: created.shareTicket.shareId, password: `wrong-${i}` }),
      });
      expect(res.status).toBe(409);
    }
    const metricsRes = await fetch(`${relay.url()}/relay/admin/metrics`, {
      headers: { authorization: 'Bearer admin' },
    });
    expect(metricsRes.status).toBe(200);
    const metricsBody = await metricsRes.json() as { metrics: { perShareLockCount: number; recent?: { perShareLockCount: number } }; alerts: Array<{ code: string }> };
    expect(metricsBody.metrics.perShareLockCount).toBe(1);
    expect(metricsBody.metrics.recent?.perShareLockCount).toBe(1);
    expect(metricsBody.alerts).toContainEqual(expect.objectContaining({ code: 'per-share-lockout' }));
    await relay.close();
    relay = null;

    relay = createRelayServer({ adminToken: 'admin', stateDbPath: dbPath });
    await listen(relay);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"event":"relay.state.loaded"'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"invitations":1'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"registrations":1'));

    const ws = await connectNode(relay, node.nodeId, node.nodeToken);
    sockets.push(ws);

    const diagnostic = await fetch(`${relay.url()}/relay/node/invitations/${encodeURIComponent(created.invitation.invitationId)}`, {
      headers: { authorization: `Bearer ${node.nodeToken}` },
    });
    expect(diagnostic.status).toBe(200);
    const body = await diagnostic.json() as {
      invitation: { failedAcceptCount?: number; lockedUntil?: string };
      node: { connected: boolean };
    };
    expect(body.invitation.failedAcceptCount).toBe(5);
    expect(body.invitation.lockedUntil).toBeTruthy();
    expect(body.node.connected).toBe(true);
  });

  it('quarantines invalid rows and skips them at startup', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kookr-relay-state-'));
    const dbPath = join(tmp, 'relay.sqlite');
    const store = new RelaySqliteStateStore(dbPath);
    store.close();
    const db = new Database(dbPath);
    db.prepare('INSERT INTO relay_invitations (invitation_id, record_json, updated_at) VALUES (?, ?, ?)').run(
      'inv-corrupt',
      '{"invitationId":"other","grants":"not-array"}',
      new Date().toISOString(),
    );
    db.close();

    relay = createRelayServer({ adminToken: 'admin', stateDbPath: dbPath });
    expect(relay.invitations()).toEqual([]);
    const inspect = new Database(dbPath, { readonly: true });
    const quarantineCount = inspect.prepare('SELECT COUNT(*) AS count FROM relay_quarantine').get() as { count: number };
    inspect.close();
    expect(quarantineCount.count).toBe(1);
  });

  it('persists token rotation, share-ticket reset, and revoke mutations across restart', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kookr-relay-state-'));
    const dbPath = join(tmp, 'relay.sqlite');
    relay = createRelayServer({ adminToken: 'admin', stateDbPath: dbPath });
    await listen(relay);
    const node = relay.registerNode({ displayName: 'desktop' });
    const created = relay.createInvitation({
      nodeId: node.nodeId,
      subject: { kind: 'task', nodeId: node.nodeId, taskId: 'task-a' },
      grants: ['view'],
      ttlMs: 60_000,
      shareTicket: true,
    });
    const reset = await fetch(`${relay.url()}/relay/node/invitations/${encodeURIComponent(created.invitation.invitationId)}/share-ticket/reset`, {
      method: 'POST',
      headers: { authorization: `Bearer ${node.nodeToken}` },
    });
    expect(reset.status).toBe(200);
    const rotated = await fetch(`${relay.url()}/relay/admin/nodes/${encodeURIComponent(node.nodeId)}/token/rotate`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin' },
    });
    expect(rotated.status).toBe(200);
    const rotatedBody = await rotated.json() as { nodeToken: string };
    const revoked = await fetch(`${relay.url()}/relay/node/invitations/${encodeURIComponent(created.invitation.invitationId)}/revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${rotatedBody.nodeToken}` },
    });
    expect(revoked.status).toBe(200);
    await relay.close();
    relay = null;

    relay = createRelayServer({ adminToken: 'admin', stateDbPath: dbPath });
    await listen(relay);
    const oldTokenStatus = await fetch(`${relay.url()}/relay/node/status`, {
      headers: { authorization: `Bearer ${node.nodeToken}` },
    });
    expect(oldTokenStatus.status).toBe(401);
    const newTokenStatus = await fetch(`${relay.url()}/relay/node/status`, {
      headers: { authorization: `Bearer ${rotatedBody.nodeToken}` },
    });
    expect(newTokenStatus.status).toBe(200);
    const diagnostic = await fetch(`${relay.url()}/relay/node/invitations/${encodeURIComponent(created.invitation.invitationId)}`, {
      headers: { authorization: `Bearer ${rotatedBody.nodeToken}` },
    });
    expect(diagnostic.status).toBe(200);
    await expect(diagnostic.json()).resolves.toMatchObject({
      invitation: {
        invitationId: created.invitation.invitationId,
        failedAcceptCount: 0,
        revokedAt: expect.any(String),
      },
    });
  });

  it('keeps 31-day share metadata available across a relay restart', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kookr-relay-state-'));
    const dbPath = join(tmp, 'relay.sqlite');
    const thirtyOneDays = 31 * 24 * 60 * 60 * 1000;
    relay = createRelayServer({ adminToken: 'admin', stateDbPath: dbPath, shareMaxTtlMs: thirtyOneDays });
    await listen(relay);
    const node = relay.registerNode({ displayName: 'desktop' });
    const created = await fetch(`${relay.url()}/relay/node/invitations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${node.nodeToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        subject: { kind: 'task', taskId: 'task-month' },
        grants: ['view'],
        ttlMs: thirtyOneDays,
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as {
      invitation: { invitationId: string; expiresAt: string };
      shareTicket: { shareId: string; password: string };
    };
    const expiresAt = Date.parse(createdBody.invitation.expiresAt);
    expect(expiresAt - Date.now()).toBeGreaterThan(30 * 24 * 60 * 60 * 1000);
    await relay.close();
    relay = null;

    relay = createRelayServer({ adminToken: 'admin', stateDbPath: dbPath, shareMaxTtlMs: thirtyOneDays });
    await listen(relay);
    expect(relay.invitations()).toContainEqual(expect.objectContaining({
      invitationId: createdBody.invitation.invitationId,
      expiresAt: createdBody.invitation.expiresAt,
      shareId: createdBody.shareTicket.shareId,
    }));
    const accepted = await fetch(`${relay.url()}/relay/share-tickets/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        shareId: createdBody.shareTicket.shareId,
        password: createdBody.shareTicket.password,
      }),
    });
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toEqual(expect.objectContaining({ nodeId: node.nodeId }));
  });

  it('persists Contact Share envelopes as ciphertext-only mailbox records', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kookr-relay-state-'));
    const dbPath = join(tmp, 'relay.sqlite');
    relay = createRelayServer({ adminToken: 'admin', stateDbPath: dbPath });
    await listen(relay);
    const sender = relay.registerNode({ displayName: 'sender', deviceId: 'sender-device' });
    const recipient = relay.registerNode({ displayName: 'recipient', deviceId: 'recipient-device-a' });

    const accepted = await fetch(`${relay.url()}/relay/node/contact-share/envelopes`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sender.nodeToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 'contact-share-envelope.v1',
        envelopeId: 'env-contact-1',
        shareId: 'share-contact-1',
        decisionVersion: 1,
        senderContactId: 'contact-owner',
        recipientContactId: 'contact-recipient',
        recipientDeviceId: 'recipient-device-a',
        kind: 'share.invite',
        createdAt: '2026-05-18T10:00:00.000Z',
        ciphertext: 'sealed-box-ciphertext',
        senderSignature: 'signature',
      }),
    });
    expect(accepted.status).toBe(201);

    const rejected = await fetch(`${relay.url()}/relay/node/contact-share/envelopes`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sender.nodeToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 'contact-share-envelope.v1',
        envelopeId: 'env-contact-plaintext',
        shareId: 'share-contact-1',
        decisionVersion: 1,
        senderContactId: 'contact-owner',
        recipientContactId: 'contact-recipient',
        recipientDeviceId: 'recipient-device-a',
        kind: 'share.accept',
        createdAt: '2026-05-18T10:01:00.000Z',
        ciphertext: 'sealed-decision',
        senderSignature: 'signature',
        taskLabel: 'Plaintext task label must not persist',
      }),
    });
    expect(rejected.status).toBe(400);

    const rejectedNestedPlaintext = await fetch(`${relay.url()}/relay/node/contact-share/envelopes`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sender.nodeToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 'contact-share-envelope.v1',
        envelopeId: 'env-contact-nested-plaintext',
        shareId: 'share-contact-1',
        decisionVersion: 1,
        senderContactId: 'contact-owner',
        recipientContactId: 'contact-recipient',
        recipientDeviceId: 'recipient-device-a',
        kind: 'share.accept',
        createdAt: '2026-05-18T10:02:00.000Z',
        ciphertext: 'sealed-decision',
        senderSignature: 'signature',
        metadata: { taskLabel: 'Nested plaintext must not persist' },
      }),
    });
    expect(rejectedNestedPlaintext.status).toBe(400);

    await relay.close();
    relay = null;

    const inspect = new Database(dbPath, { readonly: true });
    const rows = inspect.prepare('SELECT record_json FROM relay_contact_share_envelopes').all() as Array<{ record_json: string }>;
    inspect.close();
    expect(rows).toHaveLength(1);
    const persisted = rows[0].record_json;
    expect(persisted).toContain('sealed-box-ciphertext');
    expect(persisted).not.toContain('Plaintext task label');
    expect(persisted).not.toContain('Nested plaintext');
    expect(persisted).not.toContain('Fix auth regression');
    expect(persisted).not.toContain('acceptDetails');

    relay = createRelayServer({ adminToken: 'admin', stateDbPath: dbPath });
    await listen(relay);
    const listedBySender = await fetch(`${relay.url()}/relay/node/contact-share/envelopes?recipientDeviceId=recipient-device-a`, {
      headers: { authorization: `Bearer ${sender.nodeToken}` },
    });
    expect(listedBySender.status).toBe(403);

    const listed = await fetch(`${relay.url()}/relay/node/contact-share/envelopes?recipientDeviceId=recipient-device-a`, {
      headers: { authorization: `Bearer ${recipient.nodeToken}` },
    });
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual({
      envelopes: [expect.objectContaining({
        envelopeId: 'env-contact-1',
        ciphertext: 'sealed-box-ciphertext',
        recipientDeviceId: 'recipient-device-a',
      })],
    });
  });

  it('returns 503 after a Contact Share envelope state write failure and recovers health on a successful probe', async () => {
    let probeOk = false;
    const stateStore = {
      load: (): RelayStateSnapshot => ({
        registrations: [],
        invitations: [],
        contactShareEnvelopes: [],
        terminalViewingDisabledTenants: [],
        quarantinedRows: 0,
      }),
      saveRegistration: (_registration: PersistedNodeRegistration): void => undefined,
      saveInvitation: (_invitation: InvitationRecord): void => undefined,
      saveContactShareEnvelope: (): void => {
        throw new Error('disk full');
      },
      saveTerminalViewingDisabledTenant: (): void => undefined,
      deleteTerminalViewingDisabledTenant: (): void => undefined,
      probe: (): boolean => probeOk,
      close: (): void => undefined,
    };
    relay = createRelayServer({ adminToken: 'admin', stateStore });
    await listen(relay);
    const sender = relay.registerNode({ displayName: 'sender', deviceId: 'sender-device' });

    const accepted = await fetch(`${relay.url()}/relay/node/contact-share/envelopes`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sender.nodeToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 'contact-share-envelope.v1',
        envelopeId: 'env-contact-1',
        shareId: 'share-contact-1',
        decisionVersion: 1,
        senderContactId: 'contact-owner',
        recipientContactId: 'contact-recipient',
        recipientDeviceId: 'recipient-device-a',
        kind: 'share.invite',
        createdAt: '2026-05-18T10:00:00.000Z',
        ciphertext: 'sealed-box-ciphertext',
        senderSignature: 'signature',
      }),
    });
    expect(accepted.status).toBe(503);
    await expect(accepted.json()).resolves.toEqual({
      error: 'relay-state-write-failed',
      operation: 'saveContactShareEnvelope',
    });

    const degraded = await fetch(`${relay.url()}/health`);
    await expect(degraded.json()).resolves.toMatchObject({
      status: 'degraded',
      dbReachable: false,
      stateWriteFailure: {
        operation: 'saveContactShareEnvelope',
        message: 'disk full',
      },
    });

    probeOk = true;
    const recovered = await fetch(`${relay.url()}/health`);
    const recoveredBody = await recovered.json() as { status: string; dbReachable: boolean; stateWriteFailure?: unknown };
    expect(recoveredBody).toMatchObject({ status: 'ok', dbReachable: true });
    expect(recoveredBody.stateWriteFailure).toBeUndefined();
  });

  it('fails hard when the state database cannot be opened', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kookr-relay-state-'));
    expect(() => createRelayServer({ adminToken: 'admin', stateDbPath: tmp })).toThrow(/failed to open relay state database/);
  });

  it('reports degraded health when the DB probe fails', async () => {
    relay = createRelayServer({ adminToken: 'admin', stateProbe: () => false });
    await listen(relay);
    const res = await fetch(`${relay.url()}/health`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      status: 'degraded',
      dbReachable: false,
    });
  });

  it('returns 503 on /ready when the DB probe fails while /health stays 200', async () => {
    // Issue #1393: liveness (/health) stays 200 so k8s does not restart;
    // readiness (/ready) goes non-2xx so ALB/k8s stop routing traffic.
    relay = createRelayServer({ adminToken: 'admin', stateProbe: () => false });
    await listen(relay);

    const health = await fetch(`${relay.url()}/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      status: 'degraded',
      dbReachable: false,
    });

    const ready = await fetch(`${relay.url()}/ready`);
    expect(ready.status).toBe(503);
    await expect(ready.json()).resolves.toEqual({
      ready: false,
      reason: 'db-unreachable',
    });
  });

  it('returns 200 on /ready when the DB is reachable and mode is not emergency-disabled', async () => {
    relay = createRelayServer({ adminToken: 'admin', stateProbe: () => true });
    await listen(relay);

    const ready = await fetch(`${relay.url()}/ready`);
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toEqual({ ready: true });
  });

  it('returns 503 after a state write failure and recovers when the probe succeeds', async () => {
    let probeOk = false;
    const stateStore = {
      load: (): RelayStateSnapshot => ({
        registrations: [],
        invitations: [],
        contactShareEnvelopes: [],
        terminalViewingDisabledTenants: [],
        quarantinedRows: 0,
      }),
      saveRegistration: (_registration: PersistedNodeRegistration): void => {
        throw new Error('disk full');
      },
      saveInvitation: (_invitation: InvitationRecord): void => undefined,
      saveContactShareEnvelope: (): void => undefined,
      saveTerminalViewingDisabledTenant: (): void => undefined,
      deleteTerminalViewingDisabledTenant: (): void => undefined,
      probe: (): boolean => probeOk,
      close: (): void => undefined,
    };
    relay = createRelayServer({
      adminToken: 'admin',
      stateStore,
      hostedRelay: {
        enabled: true,
        operationalGatesMet: true,
        mode: 'available',
      },
      accountToken: 'account-secret',
    });
    await listen(relay);

    const paired = await fetch(`${relay.url()}/relay/admin/nodes`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'desktop' }),
    });
    expect(paired.status).toBe(503);
    await expect(paired.json()).resolves.toEqual({
      error: 'relay-state-write-failed',
      operation: 'saveRegistration',
    });

    const degraded = await fetch(`${relay.url()}/health`);
    await expect(degraded.json()).resolves.toMatchObject({
      status: 'degraded',
      dbReachable: false,
      stateWriteFailure: {
        operation: 'saveRegistration',
        message: 'disk full',
      },
      hostedRelay: {
        terminalViewing: {
          enabled: false,
          blockReason: 'hosted-relay-kill-switch-persistence-unavailable',
        },
      },
    });

    // Still-failing probe must leave the latch intact.
    const stillDegraded = await fetch(`${relay.url()}/health`);
    await expect(stillDegraded.json()).resolves.toMatchObject({
      status: 'degraded',
      dbReachable: false,
      stateWriteFailure: { operation: 'saveRegistration' },
    });

    probeOk = true;
    const recovered = await fetch(`${relay.url()}/health`);
    const recoveredBody = await recovered.json() as {
      status: string;
      dbReachable: boolean;
      stateWriteFailure?: unknown;
      hostedRelay: { terminalViewing: { enabled: boolean; blockReason?: string } };
    };
    expect(recoveredBody).toMatchObject({
      status: 'ok',
      dbReachable: true,
      hostedRelay: {
        terminalViewing: { enabled: true },
      },
    });
    expect(recoveredBody.stateWriteFailure).toBeUndefined();
  });

  it('keeps serving after a WebSocket heartbeat state write failure and recovers health on probe success', async () => {
    let throwWrites = false;
    let probeOk = false;
    const rows = new Map<string, PersistedNodeRegistration>();
    const stateStore = {
      load: (): RelayStateSnapshot => ({
        registrations: [],
        invitations: [],
        contactShareEnvelopes: [],
        terminalViewingDisabledTenants: [],
        quarantinedRows: 0,
      }),
      saveRegistration: (registration: PersistedNodeRegistration): void => {
        if (throwWrites) throw new Error('readonly database');
        rows.set(registration.nodeId, registration);
      },
      saveInvitation: (_invitation: InvitationRecord): void => undefined,
      saveContactShareEnvelope: (): void => undefined,
      saveTerminalViewingDisabledTenant: (): void => undefined,
      deleteTerminalViewingDisabledTenant: (): void => undefined,
      probe: (): boolean => probeOk,
      close: (): void => undefined,
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    relay = createRelayServer({ adminToken: 'admin', stateStore });
    await listen(relay);
    const node = relay.registerNode({ displayName: 'desktop' });

    throwWrites = true;
    const ws = await connectNode(relay, node.nodeId, node.nodeToken);
    sockets.push(ws);

    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('"event":"relay.state.write_failed"'));
    const degraded = await fetch(`${relay.url()}/health`);
    await expect(degraded.json()).resolves.toMatchObject({
      status: 'degraded',
      dbReachable: false,
      stateWriteFailure: { operation: 'saveRegistration' },
    });

    probeOk = true;
    const recovered = await fetch(`${relay.url()}/health`);
    const recoveredBody = await recovered.json() as { status: string; dbReachable: boolean; stateWriteFailure?: unknown };
    expect(recoveredBody).toMatchObject({ status: 'ok', dbReachable: true });
    expect(recoveredBody.stateWriteFailure).toBeUndefined();
  });

  it('survives peer reset during WebSocket upgrade and node socket errors without exiting', async () => {
    relay = createRelayServer({ adminToken: 'admin', allowInsecureClients: true });
    await listen(relay);
    const base = new URL(relay.url());
    const port = Number(base.port);

    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown): void => {
      uncaught.push(err);
    };
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUncaught);
    try {
      // Unauthenticated upgrade + immediate RST must not kill the process (#1422).
      await new Promise<void>((resolve, reject) => {
        const sock = createConnection({ host: '127.0.0.1', port }, () => {
          sock.write(
            'GET /relay/node HTTP/1.1\r\n'
            + 'Host: 127.0.0.1\r\n'
            + 'Connection: Upgrade\r\n'
            + 'Upgrade: websocket\r\n'
            + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
            + 'Sec-WebSocket-Version: 13\r\n'
            + '\r\n',
          );
          // Destroy mid-handshake / mid-rejection write.
          sock.destroy();
          resolve();
        });
        sock.on('error', () => resolve());
        sock.setTimeout(500, () => {
          sock.destroy();
          reject(new Error('upgrade RST timed out'));
        });
      });

      // Authenticated node path: emit error on the underlying TCP socket after connect.
      // ws exposes the Node socket as `_socket` (not public API; intentional in this test).
      const node = relay.registerNode({ displayName: 'desktop' });
      const ws = await connectNode(relay, node.nodeId, node.nodeToken);
      sockets.push(ws);
      const raw = (ws as unknown as { _socket?: { destroy: (err?: Error) => void } })._socket;
      expect(raw).toBeTruthy();
      raw?.destroy(new Error('ECONNRESET'));
      await once(ws, 'close').catch(() => undefined);

      // Allow any delayed uncaught 'error' to surface before asserting process health.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(uncaught).toEqual([]);

      // Relay must still serve /health.
      const health = await fetch(`${relay.url()}/health`);
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toMatchObject({ status: 'ok', dbReachable: true });
    } finally {
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onUncaught);
    }
  });

  it('sets Secure on member cookies behind the trusted HTTPS proxy', async () => {
    relay = createRelayServer({ adminToken: 'admin', bindHost: '127.0.0.1' });
    await listen(relay);
    const node = relay.registerNode({ displayName: 'desktop' });
    const created = relay.createInvitation({ nodeId: node.nodeId, grants: ['view'] });

    const accepted = await fetch(`${relay.url()}/relay/invitations/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ token: created.token, displayName: 'alice' }),
    });

    expect(accepted.status).toBe(200);
    expect(accepted.headers.get('set-cookie')).toContain('Secure');
  });

  it('refuses non-loopback admin requests at the relay boundary', async () => {
    relay = createRelayServer({ adminToken: 'admin', bindHost: '127.0.0.1' });
    await listen(relay);
    const res = await fetch(`${relay.url()}/relay/admin/metrics`, {
      headers: {
        authorization: 'Bearer admin',
        'x-forwarded-for': '203.0.113.5',
      },
    });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'admin-api-loopback-only' });
  });
});

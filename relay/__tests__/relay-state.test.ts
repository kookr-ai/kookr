import { mkdtemp, rm } from 'node:fs/promises';
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

  it('returns 503 and marks health degraded after a state write failure', async () => {
    const stateStore = {
      load: (): RelayStateSnapshot => ({ registrations: [], invitations: [], quarantinedRows: 0 }),
      saveRegistration: (_registration: PersistedNodeRegistration): void => {
        throw new Error('disk full');
      },
      saveInvitation: (_invitation: InvitationRecord): void => undefined,
      probe: (): boolean => true,
      close: (): void => undefined,
    };
    relay = createRelayServer({ adminToken: 'admin', stateStore });
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

    const health = await fetch(`${relay.url()}/health`);
    await expect(health.json()).resolves.toMatchObject({
      status: 'degraded',
      dbReachable: false,
      stateWriteFailure: {
        operation: 'saveRegistration',
        message: 'disk full',
      },
    });
  });

  it('keeps serving after a WebSocket heartbeat state write failure and degrades health', async () => {
    let throwWrites = false;
    const rows = new Map<string, PersistedNodeRegistration>();
    const stateStore = {
      load: (): RelayStateSnapshot => ({ registrations: [], invitations: [], quarantinedRows: 0 }),
      saveRegistration: (registration: PersistedNodeRegistration): void => {
        if (throwWrites) throw new Error('readonly database');
        rows.set(registration.nodeId, registration);
      },
      saveInvitation: (_invitation: InvitationRecord): void => undefined,
      probe: (): boolean => true,
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
    const health = await fetch(`${relay.url()}/health`);
    await expect(health.json()).resolves.toMatchObject({
      status: 'degraded',
      dbReachable: false,
      stateWriteFailure: { operation: 'saveRegistration' },
    });
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

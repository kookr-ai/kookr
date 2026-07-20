import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import { createRelayServer, type RelayServerHandle } from '../server.js';
import { makeNodeHello, PHASE1_SUPPORTED_FEATURES, type RemoteFeature } from '../../src/remote/handshake.js';
import { asNodeEpoch, asPolicyVersion, asSeq, asSessionEpoch, asSessionId } from '../../src/remote/ids.js';
import type { TerminalStreamEvent } from '../../src/remote/stream-events.js';
import type { InvitationRecord } from '../src/invitations/store.js';
import type { PersistedNodeRegistration, RelayStateSnapshot } from '../src/state/sqlite.js';

async function listen(relay: RelayServerHandle): Promise<void> {
  await new Promise<void>((resolve) => relay.httpServer.listen(0, '127.0.0.1', () => resolve()));
}

async function connectNode(relay: RelayServerHandle, nodeId: string, token: string): Promise<WebSocket> {
  const wsUrl = new URL('/relay/node', relay.url());
  wsUrl.protocol = 'ws:';
  const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } });
  await once(ws, 'open');
  ws.send(JSON.stringify(makeNodeHello({
    nodeId: nodeId as ReturnType<typeof makeNodeHello>['nodeId'],
    nodeEpoch: asNodeEpoch('1'),
    softwareVersion: 'test',
    supportedFeatures: [...PHASE1_SUPPORTED_FEATURES, 'terminal-stream', 'terminal-publication-gate.v1'] satisfies RemoteFeature[],
  })));
  await once(ws, 'message');
  return ws;
}

async function connectTerminalClient(relay: RelayServerHandle, nodeId: string): Promise<{ ws: WebSocket; messages: unknown[] }> {
  const wsUrl = new URL('/relay/client', relay.url());
  wsUrl.protocol = 'ws:';
  wsUrl.searchParams.set('nodeId', nodeId);
  wsUrl.searchParams.set('terminalSessionId', 's1');
  wsUrl.searchParams.set('terminalSessionEpoch', '1');
  const ws = new WebSocket(wsUrl);
  const messages: unknown[] = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as unknown));
  await once(ws, 'open');
  return { ws, messages };
}

async function connectPlainClient(relay: RelayServerHandle, nodeId: string): Promise<{ ws: WebSocket; messages: unknown[] }> {
  const wsUrl = new URL('/relay/client', relay.url());
  wsUrl.protocol = 'ws:';
  wsUrl.searchParams.set('nodeId', nodeId);
  const ws = new WebSocket(wsUrl);
  const messages: unknown[] = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as unknown));
  await once(ws, 'open');
  return { ws, messages };
}

function terminalBytes(
  nodeId: string,
  seq: number,
  text: string,
  publicationScopeId = 'scope-test',
  sessionId = 's1',
): TerminalStreamEvent {
  return {
    nodeId: nodeId as TerminalStreamEvent['nodeId'],
    nodeEpoch: asNodeEpoch('1'),
    sessionId: asSessionId(sessionId),
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
      publicationScopeId,
      principal: { kind: 'guest-member', invitationId: 'inv-1', memberSessionId: 'member-1', deviceId: 'device-1' },
      policyVersion: asPolicyVersion(1),
    },
  };
}

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

function relayStateStoreWithTerminalFailures(fail: 'save' | 'delete') {
  const registrations = new Map<string, PersistedNodeRegistration>();
  return {
    load: (): RelayStateSnapshot => ({
      registrations: [],
      invitations: [],
      contactShareEnvelopes: [],
      terminalViewingDisabledTenants: fail === 'delete'
        ? [{ tenantId: 'tenant-a', reason: 'existing-disable', disabledAt: '2026-05-19T00:00:00.000Z' }]
        : [],
      quarantinedRows: 0,
    }),
    saveRegistration: (registration: PersistedNodeRegistration): void => {
      registrations.set(registration.nodeId, registration);
    },
    saveInvitation: (_invitation: InvitationRecord): void => undefined,
    saveContactShareEnvelope: (): void => undefined,
    saveTerminalViewingDisabledTenant: (): void => {
      if (fail === 'save') throw new Error('terminal disable persistence failed');
    },
    deleteTerminalViewingDisabledTenant: (): void => {
      if (fail === 'delete') throw new Error('terminal enable persistence failed');
    },
    probe: (): boolean => true,
    close: (): void => undefined,
  };
}

describe('hosted relay terminal viewing production gate', () => {
  let relay: RelayServerHandle | null = null;
  let tmp: string | null = null;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets.splice(0)) {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
    }
    await relay?.close();
    relay = null;
    if (tmp) await rm(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it('rejects hosted terminal bytes until all production gates pass and exports metadata only', async () => {
    relay = createRelayServer({
      adminToken: 'admin-secret',
      accountToken: 'account-secret',
      allowInsecureClients: true,
      hostedRelay: {
        enabled: true,
        operationalGatesMet: false,
        mode: 'available',
      },
    });
    await listen(relay);
    const node = relay.registerNode({ ownerId: 'tenant-a' });
    const nodeWs = await connectNode(relay, node.nodeId, node.nodeToken);
    sockets.push(nodeWs);

    const clientUrl = new URL('/relay/client', relay.url());
    clientUrl.protocol = 'ws:';
    clientUrl.searchParams.set('nodeId', node.nodeId);
    clientUrl.searchParams.set('terminalSessionId', 's1');
    clientUrl.searchParams.set('terminalSessionEpoch', '1');
    const blockedClient = new WebSocket(clientUrl);
    const [upgradeError] = await once(blockedClient, 'unexpected-response') as [unknown];
    expect(upgradeError).toBeTruthy();

    const stateUrl = new URL('/relay/dashboard/state', relay.url());
    stateUrl.searchParams.set('nodeId', node.nodeId);
    stateUrl.searchParams.set('terminalSessionId', 's1');
    stateUrl.searchParams.set('terminalSessionEpoch', '1');
    const state = await fetch(stateUrl);
    expect(state.status).toBe(503);
    await expect(state.json()).resolves.toEqual({ error: 'hosted-relay-production-gate' });

    nodeWs.send(JSON.stringify(terminalBytes(node.nodeId, 1, 'SECRET_HOSTED_PAYLOAD', 'scope-blocked', 'session-1')));
    await waitFor(() => relay!.metadataAuditRows().some((row) => row.publicationScopeId === 'scope-blocked'));

    const audit = await fetch(new URL('/relay/admin/metadata-audit', relay.url()), {
      headers: { authorization: 'Bearer admin-secret' },
    });
    expect(audit.status).toBe(200);
    const body = await audit.json() as { rows: unknown[] };
    expect(body.rows).toContainEqual(expect.objectContaining({
      publicationScopeId: 'scope-blocked',
      outcome: 'rejected',
      reason: 'hosted-relay-production-gate',
      byteCount: Buffer.byteLength('SECRET_HOSTED_PAYLOAD'),
    }));
    expect(JSON.stringify(body)).not.toContain('SECRET_HOSTED_PAYLOAD');
    expect(JSON.stringify(body)).not.toContain(Buffer.from('SECRET_HOSTED_PAYLOAD').toString('base64'));
    expect(JSON.stringify(body)).not.toContain('member-1');
    expect(JSON.stringify(body)).not.toContain('device-1');
    expect(JSON.stringify(body)).not.toContain('inv-1');
    expect(JSON.stringify(body)).not.toContain('session-1');
  });

  it('tears down one tenant terminal streams without disabling another tenant', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kookr-hosted-relay-gate-'));
    relay = createRelayServer({
      adminToken: 'admin-secret',
      accountToken: 'account-secret',
      stateDbPath: join(tmp, 'relay.sqlite'),
      allowInsecureClients: true,
      hostedRelay: {
        enabled: true,
        operationalGatesMet: true,
        mode: 'available',
      },
    });
    await listen(relay);
    const tenantA = relay.registerNode({ ownerId: 'tenant-a' });
    const tenantB = relay.registerNode({ ownerId: 'tenant-b' });
    const nodeA = await connectNode(relay, tenantA.nodeId, tenantA.nodeToken);
    const nodeB = await connectNode(relay, tenantB.nodeId, tenantB.nodeToken);
    const clientA = await connectTerminalClient(relay, tenantA.nodeId);
    const clientB = await connectTerminalClient(relay, tenantB.nodeId);
    sockets.push(nodeA, nodeB, clientA.ws, clientB.ws);

    const longReason = `tenant-incident-${'x'.repeat(180)}`;
    const closedA = once(clientA.ws, 'close');
    const disabled = await fetch(new URL('/relay/admin/tenants/tenant-a/terminal-viewing/disable', relay.url()), {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ reason: longReason }),
    });
    expect(disabled.status).toBe(200);
    const disabledBody = await disabled.json() as { reason: string };
    expect(disabledBody).toMatchObject({
      tenantId: 'tenant-a',
      terminalViewingDisabled: true,
      reason: longReason.slice(0, 160),
    });
    const [code, reason] = await closedA as [number, Buffer];
    expect(code).toBe(4005);
    expect(reason.toString()).toContain('tenant-incident');
    expect(reason.byteLength).toBeLessThanOrEqual(123);

    nodeA.send(JSON.stringify(terminalBytes(tenantA.nodeId, 1, 'TENANT_A_SECRET', 'scope-tenant-a')));
    nodeB.send(JSON.stringify(terminalBytes(tenantB.nodeId, 1, 'tenant-b-live', 'scope-tenant-b')));
    await waitFor(() => clientB.messages.some((msg) => (msg as { publication?: { publicationScopeId?: string } }).publication?.publicationScopeId === 'scope-tenant-b'));
    await waitFor(() => relay!.metadataAuditRows().some((row) => row.publicationScopeId === 'scope-tenant-a'));

    expect(clientB.ws.readyState).toBe(clientB.ws.OPEN);
    expect(relay.tenantTerminalViewingStatus()).toEqual([{ tenantId: 'tenant-a', disabled: true, reason: longReason.slice(0, 160) }]);
    expect(relay.metadataAuditRows()).toContainEqual(expect.objectContaining({
      publicationScopeId: 'scope-tenant-a',
      outcome: 'rejected',
      reason: longReason.slice(0, 160),
    }));
  });

  it('rejects terminal input from already-open clients after a tenant disable', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kookr-hosted-relay-gate-'));
    relay = createRelayServer({
      adminToken: 'admin-secret',
      accountToken: 'account-secret',
      stateDbPath: join(tmp, 'relay.sqlite'),
      allowInsecureClients: true,
      hostedRelay: {
        enabled: true,
        operationalGatesMet: true,
        mode: 'available',
      },
    });
    await listen(relay);
    const node = relay.registerNode({ ownerId: 'tenant-a' });
    const nodeWs = await connectNode(relay, node.nodeId, node.nodeToken);
    const client = await connectPlainClient(relay, node.nodeId);
    sockets.push(nodeWs, client.ws);
    const nodeCommands: unknown[] = [];
    nodeWs.on('message', (data) => nodeCommands.push(JSON.parse(data.toString()) as unknown));

    const disabled = await fetch(new URL('/relay/admin/tenants/tenant-a/terminal-viewing/disable', relay.url()), {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'tenant-input-disabled' }),
    });
    expect(disabled.status).toBe(200);

    client.ws.send(JSON.stringify({
      type: 'remote.command',
      commandId: 'cmd-after-disable',
      action: 'submitMessage',
      nodeId: node.nodeId,
      nodeEpoch: '1',
      payload: { text: 'should not forward', appendNewline: true },
    }));

    await waitFor(() => client.messages.some((msg) => (msg as { commandId?: string }).commandId === 'cmd-after-disable'));
    expect(client.messages).toContainEqual(expect.objectContaining({
      type: 'remote.command.result',
      commandId: 'cmd-after-disable',
      outcome: 'rejected-pre-audit',
      reason: 'tenant-input-disabled',
    }));
    expect(relay.metadataAuditRows().filter((row) => row.commandId === 'cmd-after-disable')).toEqual([
      expect.objectContaining({
        commandId: 'cmd-after-disable',
        outcome: 'rejected-pre-audit',
        reason: 'tenant-input-disabled',
      }),
    ]);
    expect(nodeCommands).not.toContainEqual(expect.objectContaining({
      type: 'remote.command',
      commandId: 'cmd-after-disable',
    }));
  });

  it('keeps tenant terminal viewing disabled when disable persistence fails', async () => {
    // Probe stays healthy: write latch clears on the next successful probe (#1423),
    // but the in-memory tenant disable still blocks terminal viewing.
    relay = createRelayServer({
      adminToken: 'admin-secret',
      accountToken: 'account-secret',
      stateStore: relayStateStoreWithTerminalFailures('save'),
      allowInsecureClients: true,
      hostedRelay: {
        enabled: true,
        operationalGatesMet: true,
        mode: 'available',
      },
    });
    await listen(relay);
    const node = relay.registerNode({ ownerId: 'tenant-a' });
    const nodeWs = await connectNode(relay, node.nodeId, node.nodeToken);
    const client = await connectTerminalClient(relay, node.nodeId);
    sockets.push(nodeWs, client.ws);

    const closed = once(client.ws, 'close');
    const disabled = await fetch(new URL('/relay/admin/tenants/tenant-a/terminal-viewing/disable', relay.url()), {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'tenant-persistence-failed' }),
    });
    expect(disabled.status).toBe(503);
    await expect(disabled.json()).resolves.toEqual({
      error: 'relay-state-write-failed',
      operation: 'saveTerminalViewingDisabledTenant',
    });
    const [code] = await closed as [number, Buffer];
    expect(code).toBe(4005);
    expect(relay.tenantTerminalViewingStatus()).toEqual([{
      tenantId: 'tenant-a',
      disabled: true,
      reason: 'tenant-persistence-failed',
    }]);

    nodeWs.send(JSON.stringify(terminalBytes(node.nodeId, 1, 'PERSISTENCE_FAILURE_SECRET', 'scope-disable-persistence-failed')));
    await waitFor(() => relay!.metadataAuditRows().some((row) => row.publicationScopeId === 'scope-disable-persistence-failed'));
    expect(relay.metadataAuditRows()).toContainEqual(expect.objectContaining({
      publicationScopeId: 'scope-disable-persistence-failed',
      outcome: 'rejected',
      reason: 'tenant-persistence-failed',
    }));

    const health = await fetch(new URL('/health', relay.url()));
    const healthBody = await health.json() as {
      status: string;
      dbReachable: boolean;
      stateWriteFailure?: unknown;
      hostedRelay: { terminalViewing: { enabled: boolean } };
    };
    expect(healthBody).toMatchObject({
      status: 'ok',
      dbReachable: true,
      hostedRelay: {
        terminalViewing: {
          enabled: true,
        },
      },
    });
    expect(healthBody.stateWriteFailure).toBeUndefined();
  });

  it('keeps tenant terminal viewing disabled when enable persistence fails', async () => {
    relay = createRelayServer({
      adminToken: 'admin-secret',
      accountToken: 'account-secret',
      stateStore: relayStateStoreWithTerminalFailures('delete'),
      allowInsecureClients: true,
      hostedRelay: {
        enabled: true,
        operationalGatesMet: true,
        mode: 'available',
      },
    });
    await listen(relay);

    const enabled = await fetch(new URL('/relay/admin/tenants/tenant-a/terminal-viewing/enable', relay.url()), {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret' },
    });
    expect(enabled.status).toBe(503);
    await expect(enabled.json()).resolves.toEqual({
      error: 'relay-state-write-failed',
      operation: 'deleteTerminalViewingDisabledTenant',
    });
    expect(relay.tenantTerminalViewingStatus()).toEqual([{
      tenantId: 'tenant-a',
      disabled: true,
      reason: 'existing-disable',
    }]);

    // Healthy probe clears the write-failure latch; tenant disable remains in memory.
    const health = await fetch(new URL('/health', relay.url()));
    const healthBody = await health.json() as { status: string; dbReachable: boolean; stateWriteFailure?: unknown };
    expect(healthBody).toMatchObject({
      status: 'ok',
      dbReachable: true,
    });
    expect(healthBody.stateWriteFailure).toBeUndefined();
  });

  it.each([
    ['notConfigured', 'hosted-relay-production-gate'],
    ['maintenance', 'hosted-relay-maintenance'],
    ['emergencyDisabled', 'hosted-relay-emergency-disabled'],
  ] as const)('fails closed for hosted terminal viewing when mode is %s', async (mode, expectedReason) => {
    tmp = await mkdtemp(join(tmpdir(), 'kookr-hosted-relay-gate-'));
    relay = createRelayServer({
      adminToken: 'admin-secret',
      accountToken: 'account-secret',
      stateDbPath: join(tmp, 'relay.sqlite'),
      allowInsecureClients: true,
      hostedRelay: {
        enabled: true,
        operationalGatesMet: true,
        mode,
      },
    });
    await listen(relay);
    const node = relay.registerNode({ ownerId: 'tenant-a' });
    const nodeWs = await connectNode(relay, node.nodeId, node.nodeToken);
    sockets.push(nodeWs);

    const status = await fetch(new URL('/health', relay.url()));
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      hostedRelay: {
        configured: true,
        mode,
        terminalViewing: {
          enabled: false,
          blockReason: expectedReason,
        },
      },
    });

    const clientUrl = new URL('/relay/client', relay.url());
    clientUrl.protocol = 'ws:';
    clientUrl.searchParams.set('nodeId', node.nodeId);
    clientUrl.searchParams.set('terminalSessionId', 's1');
    clientUrl.searchParams.set('terminalSessionEpoch', '1');
    const blockedClient = new WebSocket(clientUrl);
    const [, response] = await once(blockedClient, 'unexpected-response') as [unknown, { statusCode?: number }];
    expect(response.statusCode).toBe(503);

    const publicationScopeId = `scope-${mode}`;
    nodeWs.send(JSON.stringify(terminalBytes(node.nodeId, 1, `${mode}_SECRET`, publicationScopeId)));
    await waitFor(() => relay!.metadataAuditRows().some((row) => row.publicationScopeId === publicationScopeId));
    expect(relay.metadataAuditRows()).toContainEqual(expect.objectContaining({
      publicationScopeId,
      outcome: 'rejected',
      reason: expectedReason,
    }));
  });

  it('persists per-tenant terminal viewing disables and enables across relay restarts', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kookr-hosted-relay-gate-'));
    const stateDbPath = join(tmp, 'relay.sqlite');
    relay = createRelayServer({
      adminToken: 'admin-secret',
      accountToken: 'account-secret',
      stateDbPath,
      allowInsecureClients: true,
      hostedRelay: {
        enabled: true,
        operationalGatesMet: true,
        mode: 'available',
      },
    });
    await listen(relay);
    const node = relay.registerNode({ ownerId: 'tenant-a' });

    const disabled = await fetch(new URL('/relay/admin/tenants/tenant-a/terminal-viewing/disable', relay.url()), {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'tenant-persisted-disable' }),
    });
    expect(disabled.status).toBe(200);
    await relay.close();
    relay = null;

    relay = createRelayServer({
      adminToken: 'admin-secret',
      accountToken: 'account-secret',
      stateDbPath,
      allowInsecureClients: true,
      hostedRelay: {
        enabled: true,
        operationalGatesMet: true,
        mode: 'available',
      },
    });
    await listen(relay);
    expect(relay.tenantTerminalViewingStatus()).toEqual([{
      tenantId: 'tenant-a',
      disabled: true,
      reason: 'tenant-persisted-disable',
    }]);

    const wsUrl = new URL('/relay/client', relay.url());
    wsUrl.protocol = 'ws:';
    wsUrl.searchParams.set('nodeId', node.nodeId);
    wsUrl.searchParams.set('terminalSessionId', 's1');
    wsUrl.searchParams.set('terminalSessionEpoch', '1');
    const blockedClient = new WebSocket(wsUrl);
    const [, response] = await once(blockedClient, 'unexpected-response') as [unknown, { statusCode?: number }];
    expect(response.statusCode).toBe(503);

    const enabled = await fetch(new URL('/relay/admin/tenants/tenant-a/terminal-viewing/enable', relay.url()), {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret' },
    });
    expect(enabled.status).toBe(200);
    await expect(enabled.json()).resolves.toEqual({
      tenantId: 'tenant-a',
      terminalViewingDisabled: false,
    });
    await relay.close();
    relay = null;

    relay = createRelayServer({
      adminToken: 'admin-secret',
      accountToken: 'account-secret',
      stateDbPath,
      allowInsecureClients: true,
      hostedRelay: {
        enabled: true,
        operationalGatesMet: true,
        mode: 'available',
      },
    });
    await listen(relay);
    expect(relay.tenantTerminalViewingStatus()).toEqual([]);

    const nodeWs = await connectNode(relay, node.nodeId, node.nodeToken);
    const client = await connectTerminalClient(relay, node.nodeId);
    sockets.push(nodeWs, client.ws);
    nodeWs.send(JSON.stringify(terminalBytes(node.nodeId, 1, 'tenant-live-again', 'scope-reenabled')));
    await waitFor(() => client.messages.some((msg) => (
      (msg as { publication?: { publicationScopeId?: string } }).publication?.publicationScopeId === 'scope-reenabled'
    )));
  });

  it('publishes synthetic probe coverage and the public privacy notice', async () => {
    relay = createRelayServer({ adminToken: 'admin-secret' });
    await listen(relay);

    const opsProbes = await fetch(new URL('/relay/ops/synthetic-probes', relay.url()));
    expect(opsProbes.status).toBe(200);
    await expect(opsProbes.json()).resolves.toMatchObject({
      probes: expect.arrayContaining([
        expect.objectContaining({ name: 'invite', required: true }),
        expect.objectContaining({ name: 'accept-refuse', required: true }),
        expect.objectContaining({ name: 'terminal-view-setup', required: true }),
        expect.objectContaining({ name: 'revocation', required: true }),
        expect.objectContaining({ name: 'rollback', required: true }),
      ]),
      requiredCount: 5,
    });

    const probes = await fetch(new URL('/relay/admin/synthetic-probes', relay.url()), {
      headers: { authorization: 'Bearer admin-secret' },
    });
    expect(probes.status).toBe(200);
    expect(await probes.json()).toMatchObject({
      probes: expect.arrayContaining([
        expect.objectContaining({ name: 'invite', required: true }),
        expect.objectContaining({ name: 'accept-refuse', required: true }),
        expect.objectContaining({ name: 'terminal-view-setup', required: true }),
        expect.objectContaining({ name: 'revocation', required: true }),
        expect.objectContaining({ name: 'rollback', required: true }),
      ]),
      requiredCount: 5,
    });

    const join = await fetch(new URL('/relay/join', relay.url()));
    const html = await join.text();
    expect(html).toContain('Public relay terminal viewing is live-only.');
    expect(html).toContain('Do not paste secrets into shared terminals');
  });
});

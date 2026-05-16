import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createRelayServer, type RelayServerHandle } from '../../relay/server.js';
import { createRelayConnectionManager, type RelayRuntimeHandle } from './relay-connection-manager.js';
import { relayConnectionCredentialsPath } from './relay-connection-store.js';
import type { RemoteNodeStatus } from '../remote/node-client.js';

let relay: RelayServerHandle | null = null;

afterEach(async () => {
  await relay?.close();
  relay = null;
});

async function startRelay(): Promise<{ relayUrl: string; nodeId: string; nodeToken: string }> {
  relay = createRelayServer({ adminToken: 'admin-secret' });
  await new Promise<void>((resolve) => relay!.httpServer.listen(0, '127.0.0.1', () => resolve()));
  const { nodeId, nodeToken } = relay.registerNode();
  return { relayUrl: relay.url(), nodeId, nodeToken };
}

function fakeRuntime(onStop: () => void): RelayRuntimeHandle {
  const nodeStatus: RemoteNodeStatus = {
    relayConnected: true,
    protocolVersion: 1,
    nodeId: 'node-1' as RemoteNodeStatus['nodeId'],
    nodeEpoch: '1' as RemoteNodeStatus['nodeEpoch'],
    nodeMode: 'active',
    connectionState: 'connected',
    features: { enabled: [], disabled: [] },
  };
  return {
    nodeStatus,
    start: () => undefined,
    stop: async () => {
      nodeStatus.relayConnected = false;
      nodeStatus.connectionState = 'stopped';
      onStop();
    },
  };
}

describe('RelayConnectionManager', () => {
  it('starts stored credentials on restart and stops the previous runtime before reconnecting', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-relay-manager-'));
    const { relayUrl, nodeId, nodeToken } = await startRelay();
    let starts = 0;
    let stops = 0;
    const manager = createRelayConnectionManager({
      kookrDir: dir,
      env: {},
      startRuntime: async () => {
        starts += 1;
        return fakeRuntime(() => { stops += 1; });
      },
    });

    await manager.connect({ relayUrl, nodeId, relayToken: nodeToken });
    expect(starts).toBe(1);
    expect(manager.status()).toMatchObject({ source: 'stored', connectionState: 'connected', relayConnected: true });

    await manager.disconnect();
    expect(stops).toBe(1);
    expect(manager.status()).toMatchObject({ source: 'stored', connectionState: 'stopped', relayConnected: false });

    await manager.startConfigured();
    expect(starts).toBe(2);
    expect(stops).toBe(1);
    expect(manager.status()).toMatchObject({ source: 'stored', connectionState: 'connected', relayConnected: true });
  });

  it('reports authFailed for an invalid node token without starting a runtime', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-relay-manager-auth-'));
    const { relayUrl } = await startRelay();
    let starts = 0;
    const manager = createRelayConnectionManager({
      kookrDir: dir,
      env: {},
      startRuntime: async () => {
        starts += 1;
        return fakeRuntime(() => undefined);
      },
    });

    const status = await manager.connect({ relayUrl, nodeId: 'node-1', relayToken: 'wrong-token' });

    expect(starts).toBe(0);
    expect(status).toMatchObject({
      configured: true,
      source: 'stored',
      connectionState: 'authFailed',
      relayConnected: false,
      lastError: { code: 'authFailed' },
    });
    expect(JSON.stringify(status)).not.toContain('wrong-token');
  });

  it('forgets stored credentials and returns to local-only mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-relay-manager-forget-'));
    const { relayUrl, nodeId, nodeToken } = await startRelay();
    let starts = 0;
    const manager = createRelayConnectionManager({
      kookrDir: dir,
      env: {},
      startRuntime: async () => {
        starts += 1;
        return fakeRuntime(() => undefined);
      },
    });

    await manager.connect({ relayUrl, nodeId, relayToken: nodeToken });
    const status = await manager.forget();
    const restartStatus = await manager.startConfigured();

    expect(status).toMatchObject({
      configured: false,
      source: 'none',
      connectionState: 'localOnly',
      relayConnected: false,
    });
    expect(restartStatus).toMatchObject({
      configured: false,
      source: 'none',
      connectionState: 'localOnly',
      relayConnected: false,
    });
    expect(starts).toBe(1);
  });

  it('pairs with a custom relay using an admin token and persists only the node credential', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-relay-manager-pair-'));
    relay = createRelayServer({ adminToken: 'admin-secret' });
    await new Promise<void>((resolve) => relay!.httpServer.listen(0, '127.0.0.1', () => resolve()));
    const startedWith: string[] = [];
    const manager = createRelayConnectionManager({
      kookrDir: dir,
      env: {},
      startRuntime: async (credentials) => {
        startedWith.push(credentials.relayToken);
        return fakeRuntime(() => undefined);
      },
    });

    const status = await manager.pair({
      relayUrl: relay.url(),
      relayAdminToken: 'admin-secret',
      displayName: 'Pairing desk',
    });

    expect(startedWith).toHaveLength(1);
    expect(status).toMatchObject({
      configured: true,
      source: 'stored',
      relayUrl: relay.url(),
      displayName: 'Pairing desk',
      connectionState: 'connected',
      relayConnected: true,
    });
    const storedText = await readFile(relayConnectionCredentialsPath(dir), 'utf8');
    expect(storedText).toContain(startedWith[0]!);
    expect(storedText).not.toContain('admin-secret');
  });

  it('rejects anonymous pairing and reports redacted auth failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-relay-manager-pair-auth-'));
    const { relayUrl } = await startRelay();
    let starts = 0;
    const manager = createRelayConnectionManager({
      kookrDir: dir,
      env: {},
      startRuntime: async () => {
        starts += 1;
        return fakeRuntime(() => undefined);
      },
    });

    await expect(manager.pair({ relayUrl, relayAdminToken: '' })).rejects.toMatchObject({
      code: 'relay-admin-token-required',
    });
    await expect(manager.pair({ relayUrl, relayAdminToken: 'wrong-admin-token' })).rejects.toMatchObject({
      code: 'relay-pairing-auth-failed',
      status: 401,
    });
    expect(starts).toBe(0);
  });

  it('rotates the stored node token and invalidates the old token at the relay', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-relay-manager-rotate-'));
    relay = createRelayServer({ adminToken: 'admin-secret' });
    await new Promise<void>((resolve) => relay!.httpServer.listen(0, '127.0.0.1', () => resolve()));
    const startTokens: string[] = [];
    const manager = createRelayConnectionManager({
      kookrDir: dir,
      env: {},
      startRuntime: async (credentials) => {
        startTokens.push(credentials.relayToken);
        return fakeRuntime(() => undefined);
      },
    });

    await manager.pair({ relayUrl: relay.url(), relayAdminToken: 'admin-secret' });
    const oldToken = startTokens[0]!;
    const rotated = await manager.rotate({ relayAdminToken: 'admin-secret' });
    const newToken = startTokens[1]!;

    expect(rotated).toMatchObject({ source: 'stored', connectionState: 'connected' });
    expect(newToken).toBeTruthy();
    expect(newToken).not.toBe(oldToken);
    await expect(fetch(new URL('/relay/node/status', relay.url()), {
      headers: { authorization: `Bearer ${oldToken}` },
    })).resolves.toMatchObject({ status: 401 });
    await expect(fetch(new URL('/relay/node/status', relay.url()), {
      headers: { authorization: `Bearer ${newToken}` },
    })).resolves.toMatchObject({ status: 200 });
    await expect(readFile(relayConnectionCredentialsPath(dir), 'utf8')).resolves.toContain(newToken);
    await expect(readFile(relayConnectionCredentialsPath(dir), 'utf8')).resolves.not.toContain(oldToken);
  });

  it('rejects a valid token paired with the wrong nodeId before starting runtime', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-relay-manager-node-mismatch-'));
    const { relayUrl, nodeToken } = await startRelay();
    let starts = 0;
    const manager = createRelayConnectionManager({
      kookrDir: dir,
      env: {},
      startRuntime: async () => {
        starts += 1;
        return fakeRuntime(() => undefined);
      },
    });

    const status = await manager.connect({ relayUrl, nodeId: 'wrong-node', relayToken: nodeToken });

    expect(starts).toBe(0);
    expect(status).toMatchObject({
      configured: true,
      connectionState: 'authFailed',
      lastError: { code: 'authFailed' },
    });
  });

  it('does not throw during startup when stored credentials are malformed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-relay-manager-bad-store-'));
    await writeFile(join(dir, 'relay-connection.json'), '{bad json', 'utf8');
    const manager = createRelayConnectionManager({
      kookrDir: dir,
      env: {},
      startRuntime: async () => fakeRuntime(() => undefined),
    });

    await expect(manager.startConfigured()).resolves.toMatchObject({
      configured: false,
      connectionState: 'error',
      lastError: { code: 'credential-load-failed' },
    });
  });
});

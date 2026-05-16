import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createRelayServer, type RelayServerHandle } from '../../relay/server.js';
import { createRelayConnectionManager, type RelayRuntimeHandle } from './relay-connection-manager.js';
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
    const manager = createRelayConnectionManager({
      kookrDir: dir,
      env: {},
      startRuntime: async () => fakeRuntime(() => undefined),
    });

    await manager.connect({ relayUrl, nodeId, relayToken: nodeToken });
    const status = await manager.forget();

    expect(status).toMatchObject({
      configured: false,
      source: 'none',
      connectionState: 'localOnly',
      relayConnected: false,
    });
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

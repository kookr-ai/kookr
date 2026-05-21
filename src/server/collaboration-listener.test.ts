import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { WebSocket } from 'ws';

import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { startHttpAndWebSockets, type HttpAndWebSockets } from './bootstrap/start-http-and-websockets.js';
import {
  buildCollaborationHealthResponse,
  startPrivateNetworkCollaborationListener,
  type CollaborationListenerHandle,
} from './collaboration-listener.js';
import { readPrivateNetworkCollaborationConfig } from './collaboration-config.js';

let normalServer: HttpAndWebSockets | undefined;
let collaborationListener: CollaborationListenerHandle | undefined;

async function closeNormalServer(): Promise<void> {
  if (!normalServer) return;
  normalServer.terminalWss.close();
  normalServer.wss.close();
  await new Promise<void>((resolve) => normalServer?.httpServer.close(() => resolve()));
  normalServer = undefined;
}

async function closeCollaborationListener(): Promise<void> {
  if (!collaborationListener) return;
  await collaborationListener.close();
  collaborationListener = undefined;
}

function listeningPort(handle: { httpServer?: { address(): unknown } }): number {
  const address = handle.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('expected TCP listener');
  return address.port;
}

async function reservePort(): Promise<number> {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected TCP listener');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  return port;
}

async function expectWebSocketRejected(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url);
    let opened = false;
    ws.on('open', () => {
      opened = true;
      ws.close();
      reject(new Error(`unexpected websocket open: ${url}`));
    });
    ws.on('error', () => {
      if (!opened) resolve();
    });
    ws.on('close', () => {
      if (!opened) resolve();
    });
  });
}

afterEach(async () => {
  await closeCollaborationListener();
  await closeNormalServer();
});

describe('private-network collaboration listener', () => {
  it('does not start when feature flags are disabled', async () => {
    const config = readPrivateNetworkCollaborationConfig({
      env: {},
      dashboardHost: '127.0.0.1',
      dashboardPort: 4801,
    });

    collaborationListener = await startPrivateNetworkCollaborationListener(config);

    expect(collaborationListener.status).toBe('disabled');
    expect(collaborationListener.httpServer).toBeUndefined();
  });

  it('reports feature flags, profile state, and rollback behavior without secrets', () => {
    const config = readPrivateNetworkCollaborationConfig({
      env: {
        KOOKR_COLLABORATION_PROFILES: 'true',
        KOOKR_COLLABORATION_LISTENER: 'true',
        KOOKR_COLLABORATION_PRIVATE_NETWORK: 'true',
        KOOKR_COLLABORATION_PEER_BASE_URL: 'https://peer.example.test',
        KOOKR_COLLABORATION_EXPECTED_PEER_FINGERPRINT: 'fingerprint-only',
      },
      dashboardHost: '127.0.0.1',
      dashboardPort: 4801,
      now: () => new Date('2026-05-21T00:00:00.000Z'),
    });

    const health = buildCollaborationHealthResponse(config);

    expect(health.schemaVersion).toBe('collaboration-health.v1');
    expect(health.profileKind).toBe('privateNetwork');
    expect(health.featureFlags).toEqual({
      profiles: true,
      listener: true,
      privateNetwork: true,
      contactShareViewOnly: false,
    });
    expect(health.listener).toMatchObject({ enabled: true, url: 'http://127.0.0.1:4802' });
    expect(health.profile).toMatchObject({
      schemaVersion: 'private-network-profile.v1',
      peerBaseUrl: 'https://peer.example.test',
      expectedPeerFingerprint: 'fingerprint-only',
    });
    expect(health.health).toEqual({ state: 'ok', checkedAt: '2026-05-21T00:00:00.000Z' });
    expect(health.rollback).toEqual({
      disableFlags: ['privateNetwork', 'listener'],
      behavior: 'reject-new-collaboration-requests-preserve-state',
    });
    expect(JSON.stringify(health)).not.toContain('token');
    expect(JSON.stringify(health)).not.toContain('privateKey');
  });

  it('serves only collaboration bootstrap and health routes on a separate listener', async () => {
    const normalApp = new Hono();
    normalApp.get('/api/health', (c) => c.json({ status: 'normal' }));
    normalApp.post('/api/tasks', (c) => c.json({ created: true }));
    normalApp.get('/assets/app.js', (c) => c.text('dashboard asset'));

    normalServer = await startHttpAndWebSockets({
      app: normalApp,
      port: 0,
      host: '127.0.0.1',
      tasksFile: '/tmp/tasks.json',
      hooksDir: '/tmp/hooks',
      terminalBackend: new FakeTerminalBackend(),
      terminalDeps: {
        monitor: {} as never,
        abortPendingSuggestion: () => {},
        broadcastToAll: () => {},
        serverCwd: '/repo',
      },
      onDashboardConnection: (ws) => ws.close(),
    });

    const dashboardPort = listeningPort(normalServer);
    const collaborationConfigPort = await reservePort();
    const config = readPrivateNetworkCollaborationConfig({
      env: {
        KOOKR_COLLABORATION_PROFILES: 'true',
        KOOKR_COLLABORATION_LISTENER: 'true',
        KOOKR_COLLABORATION_PRIVATE_NETWORK: 'true',
        KOOKR_COLLABORATION_PORT: String(collaborationConfigPort),
      },
      dashboardHost: '127.0.0.1',
      dashboardPort,
    });
    collaborationListener = await startPrivateNetworkCollaborationListener(config);
    const collaborationPort = listeningPort(collaborationListener);

    expect(collaborationPort).toBe(collaborationConfigPort);
    expect(collaborationPort).not.toBe(dashboardPort);
    await expect(fetch(`http://127.0.0.1:${dashboardPort}/api/health`).then((r) => r.json()))
      .resolves.toEqual({ status: 'normal' });

    const baseUrl = `http://127.0.0.1:${collaborationPort}`;
    const health = await fetch(`${baseUrl}/api/collaboration/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      schemaVersion: 'collaboration-health.v1',
      listener: { enabled: true },
    });

    for (const request of [
      { path: '/api/tasks', init: { method: 'POST' } },
      { path: '/api/tasks/task-1', init: { method: 'DELETE' } },
      { path: '/api/settings', init: { method: 'PUT' } },
      { path: '/api/diagnostics/self', init: undefined },
      { path: '/api/share/task', init: { method: 'POST' } },
      { path: '/api/relay-connection', init: undefined },
      { path: '/api/projects', init: undefined },
      { path: '/api/schedules', init: undefined },
      { path: '/assets/app.js', init: undefined },
      { path: '/', init: undefined },
    ]) {
      const res = await fetch(`${baseUrl}${request.path}`, request.init);
      expect([404, 405]).toContain(res.status);
    }
    await expectWebSocketRejected(`ws://127.0.0.1:${collaborationPort}/ws`);
    await expectWebSocketRejected(`ws://127.0.0.1:${collaborationPort}/ws/terminal/session-1`);

    await expect(fetch(`${baseUrl}/api/collaboration/pairing/offers`, { method: 'POST' }).then(async (r) => ({
      status: r.status,
      body: await r.json(),
    }))).resolves.toEqual({
      status: 501,
      body: {
        error: 'pairing-bootstrap-not-implemented',
        allowedFields: ['publicKey', 'nonce', 'commitment', 'expiresAt', 'label'],
      },
    });

    await expect(fetch(`${baseUrl}/api/collaboration/pairing/accept`, { method: 'POST' }).then(async (r) => ({
      status: r.status,
      body: await r.json(),
    }))).resolves.toEqual({
      status: 501,
      body: {
        error: 'pairing-bootstrap-not-implemented',
        allowedFields: ['pairingId', 'publicKey', 'nonce', 'commitment', 'expiresAt', 'label'],
      },
    });

    for (const request of [
      { path: '/api/collaboration/contact-share/invites', init: { method: 'POST' } },
      { path: '/api/collaboration/contact-share/decisions', init: { method: 'POST' } },
      { path: '/api/collaboration/shared-task-updates', init: undefined },
    ]) {
      const res = await fetch(`${baseUrl}${request.path}`, request.init);
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual({ error: 'verified-device-required' });
    }
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { WebSocket } from 'ws';

import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { startHttpAndWebSockets, type HttpAndWebSockets } from './bootstrap/start-http-and-websockets.js';
import {
  buildCollaborationHealthResponse,
  startConfiguredPrivateNetworkCollaborationListener,
  startPrivateNetworkCollaborationListener,
  type CollaborationListenerHandle,
} from './collaboration-listener.js';
import { readPrivateNetworkCollaborationConfig } from './collaboration-config.js';
import {
  collaborationDeviceRequestPayload,
  ContactIdentityStore,
} from './contact-identity-store.js';
import { CollaborationShareStore } from './collaboration-share-store.js';
import { registerCollaborationPairingRoutes } from './routes/collaboration-pairing-routes.js';

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

function keyPair(): { publicKey: string; privateKey: string } {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString().trim(),
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function signDeviceRequest(input: {
  privateKey: string;
  contactId: string;
  deviceId: string;
  audience: string;
  method: string;
  path: string;
  query?: string;
  bodySha256?: string;
  timestamp: string;
  nonce: string;
}): string {
  const signer = createSign('sha256');
  signer.update(collaborationDeviceRequestPayload({
    ...input,
    query: input.query ?? '',
    bodySha256: input.bodySha256 ?? createHash('sha256').update('').digest('hex'),
  }));
  signer.end();
  return signer.sign(input.privateKey, 'base64url');
}

function emptyBodySha256(): string {
  return createHash('sha256').update('').digest('hex');
}

function authHeaders(input: {
  privateKey: string;
  contactId: string;
  deviceId: string;
  audience: string;
  method: string;
  path: string;
  query?: string;
  bodySha256?: string;
  timestamp: string;
  nonce: string;
}): Record<string, string> {
  return {
    'x-kookr-contact-id': input.contactId,
    'x-kookr-device-id': input.deviceId,
    'x-kookr-request-timestamp': input.timestamp,
    'x-kookr-request-nonce': input.nonce,
    'x-kookr-request-signature': signDeviceRequest(input),
  };
}

async function postJson(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function signedJson(input: {
  baseUrl: string;
  path: string;
  privateKey: string;
  contactId: string;
  deviceId: string;
  timestamp: string;
  nonce: string;
  body: unknown;
}): Promise<Response> {
  const body = JSON.stringify(input.body);
  return fetch(`${input.baseUrl}${input.path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...authHeaders({
        privateKey: input.privateKey,
        contactId: input.contactId,
        deviceId: input.deviceId,
        audience: input.baseUrl,
        method: 'POST',
        path: input.path,
        bodySha256: createHash('sha256').update(body).digest('hex'),
        timestamp: input.timestamp,
        nonce: input.nonce,
      }),
    },
    body,
  });
}

async function verifiedContact(input: {
  baseUrl: string;
  identityStore: ContactIdentityStore;
  initiatorPublicKey: string;
  recipientPublicKey: string;
  expiresAt: string;
  offerNonce: string;
  acceptNonce: string;
}): Promise<{ contactId: string; deviceId: string }> {
  const offerRes = await postJson(input.baseUrl, '/api/collaboration/pairing/offers', {
    publicKey: input.initiatorPublicKey,
    nonce: input.offerNonce,
    commitment: `${input.offerNonce}-commitment`,
    expiresAt: input.expiresAt,
    label: 'Jean desktop',
  });
  expect(offerRes.status).toBe(201);
  const offer = await offerRes.json() as { pairingId: string };
  const acceptedRes = await postJson(input.baseUrl, '/api/collaboration/pairing/accept', {
    pairingId: offer.pairingId,
    publicKey: input.recipientPublicKey,
    nonce: input.acceptNonce,
    commitment: `${input.acceptNonce}-commitment`,
    expiresAt: input.expiresAt,
    label: 'Alice laptop',
  });
  expect(acceptedRes.status).toBe(201);
  const pending = await acceptedRes.json() as {
    pairingId: string;
    verifiedFingerprint: string;
    verificationCode: string;
  };
  const verified = await input.identityStore.verifyAcceptedPairing({
    pairingId: pending.pairingId,
    verifiedFingerprint: pending.verifiedFingerprint,
    verificationCode: pending.verificationCode,
  });
  return {
    contactId: verified.contact.contactId,
    deviceId: verified.device.deviceId,
  };
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
    }))).resolves.toEqual({ status: 400, body: { error: 'invalid-pairing-offer' } });

    await expect(fetch(`${baseUrl}/api/collaboration/pairing/accept`, { method: 'POST' }).then(async (r) => ({
      status: r.status,
      body: await r.json(),
    }))).resolves.toEqual({ status: 400, body: { error: 'invalid-pairing-accept' } });

    for (const request of [
      { path: '/api/collaboration/contact-share/invites', init: { method: 'POST' } },
      { path: '/api/collaboration/contact-share/decisions', init: { method: 'POST' } },
      { path: '/api/collaboration/shared-task-updates', init: undefined },
    ]) {
      const res = await fetch(`${baseUrl}${request.path}`, request.init);
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual({ error: 'unverified-device' });
    }
  });

  it('pairs only after explicit fingerprint verification and gates peer routes by verified device signature', async () => {
    const now = () => new Date('2026-05-21T00:00:00.000Z');
    const identityStore = new ContactIdentityStore({ now });
    const config = readPrivateNetworkCollaborationConfig({
      env: {
        KOOKR_COLLABORATION_PROFILES: 'true',
        KOOKR_COLLABORATION_LISTENER: 'true',
        KOOKR_COLLABORATION_PRIVATE_NETWORK: 'true',
      },
      dashboardHost: '127.0.0.1',
      dashboardPort: 4801,
      now,
    });
    collaborationListener = await startPrivateNetworkCollaborationListener(config, { identityStore });
    const baseUrl = `http://127.0.0.1:${listeningPort(collaborationListener)}`;
    const initiator = keyPair();
    const recipient = keyPair();

    const offerRes = await postJson(baseUrl, '/api/collaboration/pairing/offers', {
      publicKey: initiator.publicKey,
      nonce: 'offer-nonce',
      commitment: 'offer-commitment',
      expiresAt: '2026-05-21T00:10:00.000Z',
      label: 'Jean desktop',
    });
    expect(offerRes.status).toBe(201);
    const offer = await offerRes.json() as { pairingId: string; publicKey: string };
    expect(offer).toEqual(expect.objectContaining({
      schemaVersion: 'collaboration-pairing-offer.v1',
      publicKey: initiator.publicKey,
      nonce: 'offer-nonce',
      commitment: 'offer-commitment',
      label: 'Jean desktop',
    }));
    expect(JSON.stringify(offer)).not.toContain('private');

    const acceptDraft = {
      pairingId: offer.pairingId,
      publicKey: recipient.publicKey,
      nonce: 'accept-nonce',
      commitment: 'accept-commitment',
      expiresAt: '2026-05-21T00:10:00.000Z',
      label: 'Alice laptop',
    };
    const acceptedRes = await postJson(baseUrl, '/api/collaboration/pairing/accept', {
      ...acceptDraft,
    });
    expect(acceptedRes.status).toBe(201);
    const pending = await acceptedRes.json() as {
      pairingId: string;
      verifiedFingerprint: string;
      verificationCode: string;
      trustState: string;
    };
    expect(pending).toEqual(expect.objectContaining({ trustState: 'pending-local-verification' }));
    const peerVerify = await postJson(baseUrl, '/api/collaboration/pairing/verify', {
      pairingId: pending.pairingId,
      verifiedFingerprint: pending.verifiedFingerprint,
      verificationCode: pending.verificationCode,
    });
    expect(peerVerify.status).toBe(404);

    const secondOffer = await identityStore.createPairingOffer({
      publicKey: initiator.publicKey,
      nonce: 'offer-nonce-2',
      commitment: 'offer-commitment-2',
      expiresAt: '2026-05-21T00:10:00.000Z',
      label: 'Jean desktop',
    });
    const verifiedDraft = {
      ...acceptDraft,
      pairingId: secondOffer.pairingId,
      nonce: 'accept-nonce-2',
      commitment: 'accept-commitment-2',
    };
    const acceptedRes2 = await postJson(baseUrl, '/api/collaboration/pairing/accept', {
      ...verifiedDraft,
    });
    expect(acceptedRes2.status).toBe(201);
    const pending2 = await acceptedRes2.json() as {
      pairingId: string;
      verifiedFingerprint: string;
      verificationCode: string;
    };
    const verified = await identityStore.verifyAcceptedPairing({
      pairingId: pending2.pairingId,
      verifiedFingerprint: pending2.verifiedFingerprint,
      verificationCode: pending2.verificationCode,
    });

    const auth = {
      contactId: verified.contact.contactId,
      deviceId: verified.device.deviceId,
      audience: baseUrl,
      method: 'GET',
      path: '/api/collaboration/shared-task-updates',
      bodySha256: emptyBodySha256(),
      timestamp: '2026-05-21T00:00:00.000Z',
      nonce: 'peer-route-nonce-1',
    };
    const signed = await fetch(`${baseUrl}${auth.path}`, {
      headers: authHeaders({ privateKey: recipient.privateKey, ...auth }),
    });
    expect(signed.status).toBe(501);
    await expect(signed.json()).resolves.toEqual({ error: 'collaboration-route-not-implemented' });

    const replayed = await fetch(`${baseUrl}${auth.path}`, {
      headers: authHeaders({ privateKey: recipient.privateKey, ...auth }),
    });
    expect(replayed.status).toBe(401);
    await expect(replayed.json()).resolves.toEqual({ error: 'replayed-device-signature' });

    const stale = await fetch(`${baseUrl}${auth.path}`, {
      headers: authHeaders({
        privateKey: recipient.privateKey,
        ...auth,
        timestamp: '2026-05-20T23:00:00.000Z',
        nonce: 'peer-route-stale',
      }),
    });
    expect(stale.status).toBe(401);
    await expect(stale.json()).resolves.toEqual({ error: 'stale-device-signature' });

    const wrongPath = await fetch(`${baseUrl}${auth.path}`, {
      headers: authHeaders({
        privateKey: recipient.privateKey,
        ...auth,
        path: '/api/collaboration/contact-share/invites',
        nonce: 'peer-route-wrong-path',
      }),
    });
    expect(wrongPath.status).toBe(401);
    await expect(wrongPath.json()).resolves.toEqual({ error: 'unverified-device' });

    const postBody = JSON.stringify({ envelope: 'ciphertext-only' });
    const postAuth = {
      contactId: verified.contact.contactId,
      deviceId: verified.device.deviceId,
      audience: baseUrl,
      method: 'POST',
      path: '/api/collaboration/contact-share/invites',
      bodySha256: createHash('sha256').update(postBody).digest('hex'),
      timestamp: '2026-05-21T00:00:00.000Z',
      nonce: 'peer-route-post',
    };
    const signedPost = await fetch(`${baseUrl}${postAuth.path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders({ privateKey: recipient.privateKey, ...postAuth }),
      },
      body: postBody,
    });
    expect(signedPost.status).toBe(404);
    await expect(signedPost.json()).resolves.toEqual({ error: 'contact-share-view-only-disabled' });

    const tamperedPost = await fetch(`${baseUrl}${postAuth.path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders({ privateKey: recipient.privateKey, ...postAuth, nonce: 'peer-route-post-tampered' }),
      },
      body: JSON.stringify({ envelope: 'different-ciphertext' }),
    });
    expect(tamperedPost.status).toBe(401);
    await expect(tamperedPost.json()).resolves.toEqual({ error: 'unverified-device' });

    await identityStore.revokeDevice(auth.contactId, auth.deviceId);
    const revokedAuth = { ...auth, nonce: 'peer-route-nonce-2' };
    const revoked = await fetch(`${baseUrl}${auth.path}`, {
      headers: authHeaders({ privateKey: recipient.privateKey, ...revokedAuth }),
    });
    expect(revoked.status).toBe(401);
    await expect(revoked.json()).resolves.toEqual({ error: 'unverified-device' });
  });

  it('loads persisted trust when the configured listener restarts', async () => {
    const kookrDir = await mkdtemp(join(tmpdir(), 'kookr-collaboration-listener-'));
    const collaborationPort = await reservePort();
    const now = () => new Date('2026-05-21T00:00:00.000Z');
    const initiator = keyPair();
    const recipient = keyPair();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    collaborationListener = await startConfiguredPrivateNetworkCollaborationListener({
      env: {
        KOOKR_COLLABORATION_PROFILES: 'true',
        KOOKR_COLLABORATION_LISTENER: 'true',
        KOOKR_COLLABORATION_PRIVATE_NETWORK: 'true',
        KOOKR_COLLABORATION_PORT: String(collaborationPort),
      },
      dashboardHost: '127.0.0.1',
      dashboardPort: 4801,
      kookrDir,
    });
    const baseUrl = `http://127.0.0.1:${collaborationPort}`;

    const offerRes = await postJson(baseUrl, '/api/collaboration/pairing/offers', {
      publicKey: initiator.publicKey,
      nonce: 'persisted-offer-nonce',
      commitment: 'persisted-offer-commitment',
      expiresAt,
      label: 'Jean desktop',
    });
    expect(offerRes.status).toBe(201);
    const offer = await offerRes.json() as { pairingId: string };
    const acceptedRes = await postJson(baseUrl, '/api/collaboration/pairing/accept', {
      pairingId: offer.pairingId,
      publicKey: recipient.publicKey,
      nonce: 'persisted-accept-nonce',
      commitment: 'persisted-accept-commitment',
      expiresAt,
      label: 'Alice laptop',
    });
    expect(acceptedRes.status).toBe(201);
    const pending = await acceptedRes.json() as {
      pairingId: string;
      verifiedFingerprint: string;
      verificationCode: string;
    };

    const localApp = new Hono();
    registerCollaborationPairingRoutes(localApp, {
      kookrDir,
      remoteShare: { csrfToken: 'csrf-local', client: null },
    } as never);
    const missingCsrf = await localApp.request('http://localhost/api/collaboration/pairing/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost' },
      body: JSON.stringify({
        pairingId: pending.pairingId,
        verifiedFingerprint: pending.verifiedFingerprint,
        verificationCode: pending.verificationCode,
      }),
    });
    expect(missingCsrf.status).toBe(403);
    await expect(missingCsrf.json()).resolves.toEqual({ error: 'invalid-csrf-token' });

    const localVerify = await localApp.request('http://localhost/api/collaboration/pairing/verify', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: 'http://localhost',
        'x-kookr-csrf': 'csrf-local',
      },
      body: JSON.stringify({
        pairingId: pending.pairingId,
        verifiedFingerprint: pending.verifiedFingerprint,
        verificationCode: pending.verificationCode,
      }),
    });
    expect(localVerify.status).toBe(201);
    const verified = await localVerify.json() as {
      contact: { contactId: string };
      device: { deviceId: string };
    };

    const repeatVerify = await localApp.request('http://localhost/api/collaboration/pairing/verify', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: 'http://localhost',
        'x-kookr-csrf': 'csrf-local',
      },
      body: JSON.stringify({
        pairingId: pending.pairingId,
        verifiedFingerprint: pending.verifiedFingerprint,
        verificationCode: pending.verificationCode,
      }),
    });
    expect(repeatVerify.status).toBe(409);
    await closeCollaborationListener();

    collaborationListener = await startConfiguredPrivateNetworkCollaborationListener({
      env: {
        KOOKR_COLLABORATION_PROFILES: 'true',
        KOOKR_COLLABORATION_LISTENER: 'true',
        KOOKR_COLLABORATION_PRIVATE_NETWORK: 'true',
        KOOKR_COLLABORATION_PORT: String(collaborationPort),
      },
      dashboardHost: '127.0.0.1',
      dashboardPort: 4801,
      kookrDir,
    });

    const auth = {
      contactId: verified.contact.contactId,
      deviceId: verified.device.deviceId,
      audience: baseUrl,
      method: 'GET',
      path: '/api/collaboration/shared-task-updates',
      bodySha256: emptyBodySha256(),
      timestamp: new Date().toISOString(),
      nonce: 'persisted-route-nonce',
    };
    const signed = await fetch(`${baseUrl}${auth.path}`, {
      headers: authHeaders({ privateKey: recipient.privateKey, ...auth }),
    });
    expect(signed.status).toBe(501);
    await expect(signed.json()).resolves.toEqual({ error: 'collaboration-route-not-implemented' });
  });

  it('creates a view-only Contact Share grant for a verified device and persists audit metadata', async () => {
    const kookrDir = await mkdtemp(join(tmpdir(), 'kookr-collaboration-share-'));
    const now = () => new Date('2026-05-21T00:00:00.000Z');
    const identityStore = new ContactIdentityStore({ kookrDir, now });
    const shareStore = new CollaborationShareStore({
      kookrDir,
      now,
      taskExists: (taskId) => taskId === 'task-1',
    });
    const collaborationPort = await reservePort();
    const config = readPrivateNetworkCollaborationConfig({
      env: {
        KOOKR_COLLABORATION_PROFILES: 'true',
        KOOKR_COLLABORATION_LISTENER: 'true',
        KOOKR_COLLABORATION_PRIVATE_NETWORK: 'true',
        KOOKR_COLLABORATION_CONTACT_SHARE_VIEW_ONLY: 'true',
        KOOKR_COLLABORATION_PORT: String(collaborationPort),
      },
      dashboardHost: '127.0.0.1',
      dashboardPort: 4801,
      now,
    });
    collaborationListener = await startPrivateNetworkCollaborationListener(config, {
      identityStore,
      shareStore,
      taskExists: (taskId) => taskId === 'task-1',
    });
    const baseUrl = `http://127.0.0.1:${listeningPort(collaborationListener)}`;
    const initiator = keyPair();
    const recipient = keyPair();
    const principal = await verifiedContact({
      baseUrl,
      identityStore,
      initiatorPublicKey: initiator.publicKey,
      recipientPublicKey: recipient.publicKey,
      expiresAt: '2026-05-21T00:10:00.000Z',
      offerNonce: 'share-offer',
      acceptNonce: 'share-accept',
    });

    const inviteRes = await signedJson({
      baseUrl,
      path: '/api/collaboration/contact-share/invites',
      privateKey: recipient.privateKey,
      ...principal,
      timestamp: '2026-05-21T00:00:00.000Z',
      nonce: 'invite-nonce',
      body: { taskId: 'remote-task-1', capabilities: ['viewTask'] },
    });
    expect(inviteRes.status).toBe(201);
    const inboundInviteBody = await inviteRes.json() as { invite: { inviteId: string; capabilities: string[]; direction: string; status: string } };
    expect(inboundInviteBody.invite).toEqual(expect.objectContaining({
      direction: 'inbound',
      status: 'pending',
      capabilities: ['viewTask'],
    }));
    const inboundAccept = await signedJson({
      baseUrl,
      path: '/api/collaboration/contact-share/decisions',
      privateKey: recipient.privateKey,
      ...principal,
      timestamp: '2026-05-21T00:00:00.000Z',
      nonce: 'inbound-accept-nonce',
      body: { inviteId: inboundInviteBody.invite.inviteId, decision: 'accept' },
    });
    expect(inboundAccept.status).toBe(409);
    await expect(inboundAccept.json()).resolves.toEqual({ error: 'contact-share-grant-not-local' });

    await expect(shareStore.createOutboundInvite(principal, {
      taskId: 'missing-task',
      capabilities: ['viewTask'],
    })).rejects.toMatchObject({ code: 'task-not-found', status: 404 });

    const outboundInvite = await shareStore.createOutboundInvite(principal, {
      taskId: 'task-1',
      expiresAt: '2026-05-21T00:05:00.000Z',
      capabilities: ['viewTask'],
    });
    expect(JSON.stringify(outboundInvite)).not.toContain('terminal');

    const acceptRes = await signedJson({
      baseUrl,
      path: '/api/collaboration/contact-share/decisions',
      privateKey: recipient.privateKey,
      ...principal,
      timestamp: '2026-05-21T00:00:00.000Z',
      nonce: 'accept-invite-nonce',
      body: { inviteId: outboundInvite.inviteId, decision: 'accept' },
    });
    expect(acceptRes.status).toBe(200);
    const accepted = await acceptRes.json() as {
      invite: { status: string; grantId: string };
      grant: { grantId: string; capabilities: string[]; principal: { contactId: string; deviceId: string }; subject: { taskId: string } };
    };
    expect(accepted.invite.status).toBe('accepted');
    expect(accepted.grant).toEqual(expect.objectContaining({
      capabilities: ['viewTask'],
      principal: { kind: 'contact-device', ...principal },
      subject: { kind: 'task', taskId: 'task-1' },
    }));

    const reloaded = new CollaborationShareStore({ kookrDir, now });
    await reloaded.load();
    expect(reloaded.getGrant(accepted.grant.grantId)).toEqual(expect.objectContaining({
      grantId: accepted.grant.grantId,
      capabilities: ['viewTask'],
    }));
    const audit = await readFile(join(kookrDir, 'collaboration-audit.jsonl'), 'utf-8');
    expect(audit).toContain('"kind":"share.sent"');
    expect(audit).toContain('"kind":"share.accepted"');
    expect(audit).toContain('"taskId":"task-1"');
    expect(audit).not.toContain('privateKey');
  });

  it('rejects unpaired devices and prevents declined or expired invites from creating grants', async () => {
    let currentTime = new Date('2026-05-21T00:00:00.000Z');
    const now = () => currentTime;
    const identityStore = new ContactIdentityStore({ now });
    const shareStore = new CollaborationShareStore({ now, taskExists: () => true });
    const collaborationPort = await reservePort();
    const config = readPrivateNetworkCollaborationConfig({
      env: {
        KOOKR_COLLABORATION_PROFILES: 'true',
        KOOKR_COLLABORATION_LISTENER: 'true',
        KOOKR_COLLABORATION_PRIVATE_NETWORK: 'true',
        KOOKR_COLLABORATION_CONTACT_SHARE_VIEW_ONLY: 'true',
        KOOKR_COLLABORATION_PORT: String(collaborationPort),
      },
      dashboardHost: '127.0.0.1',
      dashboardPort: 4801,
      now,
    });
    collaborationListener = await startPrivateNetworkCollaborationListener(config, { identityStore, shareStore });
    const baseUrl = `http://127.0.0.1:${listeningPort(collaborationListener)}`;
    const initiator = keyPair();
    const recipient = keyPair();
    const stranger = keyPair();
    const principal = await verifiedContact({
      baseUrl,
      identityStore,
      initiatorPublicKey: initiator.publicKey,
      recipientPublicKey: recipient.publicKey,
      expiresAt: '2026-05-21T00:10:00.000Z',
      offerNonce: 'reject-offer',
      acceptNonce: 'reject-accept',
    });

    const unpaired = await signedJson({
      baseUrl,
      path: '/api/collaboration/contact-share/invites',
      privateKey: stranger.privateKey,
      contactId: 'contact-missing',
      deviceId: 'device-missing',
      timestamp: '2026-05-21T00:00:00.000Z',
      nonce: 'unpaired-nonce',
      body: { taskId: 'task-1', capabilities: ['viewTask'] },
    });
    expect(unpaired.status).toBe(401);
    await expect(unpaired.json()).resolves.toEqual({ error: 'unverified-device' });

    const declinedInvite = await shareStore.createOutboundInvite(principal, {
      taskId: 'task-1',
      capabilities: ['viewTask'],
    });
    const decline = await signedJson({
      baseUrl,
      path: '/api/collaboration/contact-share/decisions',
      privateKey: recipient.privateKey,
      ...principal,
      timestamp: '2026-05-21T00:00:00.000Z',
      nonce: 'decline-decision',
      body: { inviteId: declinedInvite.inviteId, decision: 'decline' },
    });
    expect(decline.status).toBe(200);
    await expect(decline.json()).resolves.toEqual({
      invite: expect.objectContaining({ status: 'declined' }),
    });
    const acceptDeclined = await signedJson({
      baseUrl,
      path: '/api/collaboration/contact-share/decisions',
      privateKey: recipient.privateKey,
      ...principal,
      timestamp: '2026-05-21T00:00:00.000Z',
      nonce: 'accept-declined',
      body: { inviteId: declinedInvite.inviteId, decision: 'accept' },
    });
    expect(acceptDeclined.status).toBe(409);
    await expect(acceptDeclined.json()).resolves.toEqual({ error: 'contact-share-declined' });

    const expiringInvite = await shareStore.createOutboundInvite(principal, {
      taskId: 'task-1',
      expiresAt: '2026-05-21T00:01:00.000Z',
      capabilities: ['viewTask'],
    });
    currentTime = new Date('2026-05-21T00:02:00.000Z');
    const expiredAccept = await signedJson({
      baseUrl,
      path: '/api/collaboration/contact-share/decisions',
      privateKey: recipient.privateKey,
      ...principal,
      timestamp: '2026-05-21T00:02:00.000Z',
      nonce: 'expired-accept',
      body: { inviteId: expiringInvite.inviteId, decision: 'accept' },
    });
    expect(expiredAccept.status).toBe(410);
    await expect(expiredAccept.json()).resolves.toEqual({ error: 'contact-share-invite-expired' });

    currentTime = new Date('2026-05-21T00:00:00.000Z');
    const acceptedInvite = await shareStore.createOutboundInvite(principal, {
      taskId: 'task-1',
      expiresAt: '2026-05-21T00:01:00.000Z',
      capabilities: ['viewTask'],
    });
    const acceptedGrant = await signedJson({
      baseUrl,
      path: '/api/collaboration/contact-share/decisions',
      privateKey: recipient.privateKey,
      ...principal,
      timestamp: '2026-05-21T00:00:00.000Z',
      nonce: 'short-lived-accept',
      body: { inviteId: acceptedInvite.inviteId, decision: 'accept' },
    });
    const acceptedGrantBody = await acceptedGrant.json() as { grant: { grantId: string } };
    currentTime = new Date('2026-05-21T00:02:00.000Z');
    expect(shareStore.getGrant(acceptedGrantBody.grant.grantId)).toBeUndefined();
  });

  it('persists revocation tombstones so stale invites and cached grants cannot resurrect access', async () => {
    const kookrDir = await mkdtemp(join(tmpdir(), 'kookr-collaboration-revoke-'));
    const now = () => new Date('2026-05-21T00:00:00.000Z');
    const identityStore = new ContactIdentityStore({ kookrDir, now });
    const collaborationPort = await reservePort();
    const config = readPrivateNetworkCollaborationConfig({
      env: {
        KOOKR_COLLABORATION_PROFILES: 'true',
        KOOKR_COLLABORATION_LISTENER: 'true',
        KOOKR_COLLABORATION_PRIVATE_NETWORK: 'true',
        KOOKR_COLLABORATION_CONTACT_SHARE_VIEW_ONLY: 'true',
        KOOKR_COLLABORATION_PORT: String(collaborationPort),
      },
      dashboardHost: '127.0.0.1',
      dashboardPort: 4801,
      now,
    });
    const shareStore = new CollaborationShareStore({ kookrDir, now, taskExists: () => true });
    collaborationListener = await startPrivateNetworkCollaborationListener(config, {
      identityStore,
      shareStore,
    });
    const baseUrl = `http://127.0.0.1:${listeningPort(collaborationListener)}`;
    const initiator = keyPair();
    const recipient = keyPair();
    const principal = await verifiedContact({
      baseUrl,
      identityStore,
      initiatorPublicKey: initiator.publicKey,
      recipientPublicKey: recipient.publicKey,
      expiresAt: '2026-05-21T00:10:00.000Z',
      offerNonce: 'revoke-offer',
      acceptNonce: 'revoke-accept',
    });

    const invite = await shareStore.createOutboundInvite(principal, {
      taskId: 'task-1',
      capabilities: ['viewTask'],
    });
    const acceptRes = await signedJson({
      baseUrl,
      path: '/api/collaboration/contact-share/decisions',
      privateKey: recipient.privateKey,
      ...principal,
      timestamp: '2026-05-21T00:00:00.000Z',
      nonce: 'revoke-accept-invite',
      body: { inviteId: invite.inviteId, decision: 'accept' },
    });
    const accepted = await acceptRes.json() as { grant: { grantId: string } };
    const revokeRes = await signedJson({
      baseUrl,
      path: '/api/collaboration/contact-share/decisions',
      privateKey: recipient.privateKey,
      ...principal,
      timestamp: '2026-05-21T00:00:00.000Z',
      nonce: 'revoke-decision',
      body: { inviteId: invite.inviteId, decision: 'revoke' },
    });
    expect(revokeRes.status).toBe(200);
    const revoked = await revokeRes.json() as { invite: { status: string }; tombstone: { grantId: string; policyVersion: number } };
    expect(revoked.invite.status).toBe('revoked');
    expect(revoked.tombstone).toEqual(expect.objectContaining({
      grantId: accepted.grant.grantId,
      policyVersion: 2,
    }));

    await closeCollaborationListener();
    const reloaded = new CollaborationShareStore({ kookrDir });
    await reloaded.load();
    expect(reloaded.getGrant(accepted.grant.grantId)).toBeUndefined();
    expect(reloaded.listTombstones()).toEqual([
      expect.objectContaining({ grantId: accepted.grant.grantId, inviteId: invite.inviteId }),
    ]);

    collaborationListener = await startPrivateNetworkCollaborationListener(config, {
      identityStore,
      shareStore: new CollaborationShareStore({ kookrDir, now, taskExists: () => true }),
    });
    const staleAccept = await signedJson({
      baseUrl,
      path: '/api/collaboration/contact-share/decisions',
      privateKey: recipient.privateKey,
      ...principal,
      timestamp: '2026-05-21T00:00:00.000Z',
      nonce: 'stale-reaccept',
      body: { inviteId: invite.inviteId, decision: 'accept' },
    });
    expect(staleAccept.status).toBe(410);
    await expect(staleAccept.json()).resolves.toEqual({ error: 'contact-share-revoked' });

    const audit = await readFile(join(kookrDir, 'collaboration-audit.jsonl'), 'utf-8');
    expect(audit).toContain('"kind":"share.revoked"');
  });

});

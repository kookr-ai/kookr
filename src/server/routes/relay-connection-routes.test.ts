import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import type { RelayConnectionManager } from '../relay-connection-manager.js';
import { registerRelayConnectionRoutes } from './relay-connection-routes.js';
import type { RouteDeps } from './shared.js';
import { SHARE_CSRF_HEADER } from './share-routes.js';
import type { HostedRelayStatus } from '../../shared/contracts/hosted-relay.js';

const CSRF = 'csrf-nonce';
const ORIGIN = 'http://127.0.0.1';

const HOSTED_RELAY: HostedRelayStatus = {
  configured: false,
  relayUrl: 'https://share.kookr.dev',
  defaultEnabled: false,
  operationalGatesMet: false,
  mode: 'notConfigured',
  message: 'Hosted relay is not enabled.',
  checkedAt: '2026-05-16T00:00:00.000Z',
  gates: {
    deploymentOwner: false,
    environment: false,
    tlsDomain: false,
    tenantIsolation: false,
    accountDeviceAuth: false,
    nodePairingAuth: false,
    dataRetention: false,
    rateLimitAbuse: false,
    emergencyMaintenance: false,
    metricsAlerts: false,
    privacyNotice: false,
    syntheticProbes: false,
    perTenantKillSwitch: false,
    logEvidenceRedaction: false,
    incidentEscalation: false,
  },
  terminalViewing: {
    enabled: false,
    blockReason: 'hosted-relay-production-gate',
    disabledTenants: 0,
  },
};

function manager(overrides: Partial<RelayConnectionManager> = {}): RelayConnectionManager {
  return {
    status: () => ({
      configured: false,
      source: 'none',
      connectionState: 'localOnly',
      relayConnected: false,
      hostedRelay: HOSTED_RELAY,
    }),
    startConfigured: async () => ({
      configured: false,
      source: 'none',
      connectionState: 'localOnly',
      relayConnected: false,
      hostedRelay: HOSTED_RELAY,
    }),
    connect: vi.fn(async () => ({
      configured: true,
      source: 'stored',
      relayUrl: 'http://relay.test',
      connectionState: 'connected',
      relayConnected: true,
      hostedRelay: HOSTED_RELAY,
    })),
    pair: vi.fn(async () => ({
      configured: true,
      source: 'stored',
      relayUrl: 'http://relay.test',
      nodeId: 'kookr-node-paired',
      connectionState: 'connected',
      relayConnected: true,
      hostedRelay: HOSTED_RELAY,
    })),
    pairHosted: vi.fn(async () => ({
      configured: true,
      source: 'hosted',
      relayUrl: 'https://share.kookr.dev',
      nodeId: 'kookr-node-hosted',
      connectionState: 'connected',
      relayConnected: true,
      hostedRelay: {
        ...HOSTED_RELAY,
        configured: true,
        defaultEnabled: true,
        operationalGatesMet: true,
        mode: 'available',
        terminalViewing: { enabled: true, disabledTenants: 0 },
      },
    })),
    rotate: vi.fn(async () => ({
      configured: true,
      source: 'stored',
      relayUrl: 'http://relay.test',
      nodeId: 'kookr-node-paired',
      connectionState: 'connected',
      relayConnected: true,
      hostedRelay: HOSTED_RELAY,
    })),
    disconnect: vi.fn(async () => ({
      configured: true,
      source: 'stored',
      relayUrl: 'http://relay.test',
      connectionState: 'stopped',
      relayConnected: false,
      hostedRelay: HOSTED_RELAY,
    })),
    forget: vi.fn(async () => ({
      configured: false,
      source: 'none',
      connectionState: 'localOnly',
      relayConnected: false,
      hostedRelay: HOSTED_RELAY,
    })),
    ...overrides,
  };
}

function app(relayConnection = manager()): Hono {
  const hono = new Hono();
  registerRelayConnectionRoutes(hono, {
    relayConnection,
    remoteShare: { csrfToken: CSRF, client: null },
  } as unknown as RouteDeps);
  return hono;
}

function post(hono: Hono, path: string, headers: Record<string, string>, body: unknown = {}): Promise<Response> {
  return hono.request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('relay connection routes', () => {
  it('returns status without relay secrets', async () => {
    const relayConnection = manager({
      status: () => ({
        configured: true,
        source: 'stored',
        relayUrl: 'http://relay.test',
        connectionState: 'connected',
        relayConnected: true,
        hostedRelay: HOSTED_RELAY,
      }),
    });
    const res = await app(relayConnection).request(`${ORIGIN}/api/relay-connection`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: expect.objectContaining({ relayUrl: 'http://relay.test' }) });
    expect(JSON.stringify(body)).not.toContain('token');
  });

  it('protects connect with the same origin and CSRF guard', async () => {
    const relayConnection = manager();
    const missingCsrf = await post(app(relayConnection), '/api/relay-connection/connect', { Origin: ORIGIN }, {
      relayUrl: 'http://relay.test',
      nodeId: 'node-1',
      relayToken: 'tok',
    });
    expect(missingCsrf.status).toBe(403);

    const ok = await post(app(relayConnection), '/api/relay-connection/connect', {
      Origin: ORIGIN,
      [SHARE_CSRF_HEADER]: CSRF,
    }, {
      relayUrl: 'http://relay.test',
      nodeId: 'node-1',
      relayToken: 'tok',
    });
    expect(ok.status).toBe(200);
    expect(relayConnection.connect).toHaveBeenCalledWith({
      relayUrl: 'http://relay.test',
      nodeId: 'node-1',
      relayToken: 'tok',
    });
  });

  it('protects disconnect and forget with the same guard', async () => {
    const relayConnection = manager();
    const bad = await post(app(relayConnection), '/api/relay-connection/disconnect', { Origin: 'http://evil.test' });
    expect(bad.status).toBe(403);

    const ok = await post(app(relayConnection), '/api/relay-connection/disconnect', {
      Origin: ORIGIN,
      [SHARE_CSRF_HEADER]: CSRF,
    });
    expect(ok.status).toBe(200);

    const forgotten = await app(relayConnection).request(`${ORIGIN}/api/relay-connection/credentials`, {
      method: 'DELETE',
      headers: { Origin: ORIGIN, [SHARE_CSRF_HEADER]: CSRF },
    });
    expect(forgotten.status).toBe(200);
  });

  it('protects relay pairing and token rotation with the same guard', async () => {
    const relayConnection = manager();

    const missingCsrf = await post(app(relayConnection), '/api/relay-connection/pair', { Origin: ORIGIN }, {
      relayUrl: 'http://relay.test',
      relayAdminToken: 'admin-secret',
    });
    expect(missingCsrf.status).toBe(403);

    const badPairOrigin = await post(app(relayConnection), '/api/relay-connection/pair', {
      Origin: 'http://evil.test',
      [SHARE_CSRF_HEADER]: CSRF,
    }, {
      relayUrl: 'http://relay.test',
      relayAdminToken: 'admin-secret',
    });
    expect(badPairOrigin.status).toBe(403);

    const paired = await post(app(relayConnection), '/api/relay-connection/pair', {
      Origin: ORIGIN,
      [SHARE_CSRF_HEADER]: CSRF,
    }, {
      relayUrl: 'http://relay.test',
      relayAdminToken: 'admin-secret',
      displayName: 'Desk',
    });
    expect(paired.status).toBe(200);
    expect(relayConnection.pair).toHaveBeenCalledWith({
      relayUrl: 'http://relay.test',
      relayAdminToken: 'admin-secret',
      displayName: 'Desk',
    });

    const missingRotateCsrf = await post(app(relayConnection), '/api/relay-connection/rotate', { Origin: ORIGIN }, {
      relayAdminToken: 'admin-secret',
    });
    expect(missingRotateCsrf.status).toBe(403);

    const badRotateOrigin = await post(app(relayConnection), '/api/relay-connection/rotate', {
      Origin: 'http://evil.test',
      [SHARE_CSRF_HEADER]: CSRF,
    }, {
      relayAdminToken: 'admin-secret',
    });
    expect(badRotateOrigin.status).toBe(403);

    const rotated = await post(app(relayConnection), '/api/relay-connection/rotate', {
      Origin: ORIGIN,
      [SHARE_CSRF_HEADER]: CSRF,
    }, {
      relayAdminToken: 'admin-secret',
    });
    expect(rotated.status).toBe(200);
    expect(relayConnection.rotate).toHaveBeenCalledWith({ relayAdminToken: 'admin-secret' });
  });

  it('protects hosted relay account pairing and never returns the account token', async () => {
    const relayConnection = manager();

    const missingCsrf = await post(app(relayConnection), '/api/relay-connection/hosted/pair', { Origin: ORIGIN }, {
      accountToken: 'account-secret',
    });
    expect(missingCsrf.status).toBe(403);

    const badOrigin = await post(app(relayConnection), '/api/relay-connection/hosted/pair', {
      Origin: 'http://evil.test',
      [SHARE_CSRF_HEADER]: CSRF,
    }, {
      accountToken: 'account-secret',
    });
    expect(badOrigin.status).toBe(403);
    expect(relayConnection.pairHosted).not.toHaveBeenCalled();

    const paired = await post(app(relayConnection), '/api/relay-connection/hosted/pair', {
      Origin: ORIGIN,
      [SHARE_CSRF_HEADER]: CSRF,
    }, {
      accountToken: 'account-secret',
      displayName: 'Desk',
    });

    expect(paired.status).toBe(200);
    expect(relayConnection.pairHosted).toHaveBeenCalledWith({
      accountToken: 'account-secret',
      displayName: 'Desk',
    });
    expect(await paired.text()).not.toContain('account-secret');
  });

  it('returns redacted pairing errors', async () => {
    const relayConnection = manager({
      pair: vi.fn(async () => {
        const err = new Error('Relay rejected the pairing credential.') as Error & { code: string; status: 401 };
        err.code = 'relay-pairing-auth-failed';
        err.status = 401;
        throw err;
      }),
    });

    const res = await post(app(relayConnection), '/api/relay-connection/pair', {
      Origin: ORIGIN,
      [SHARE_CSRF_HEADER]: CSRF,
    }, {
      relayUrl: 'http://relay.test',
      relayAdminToken: 'super-secret-admin-token',
    });

    expect(res.status).toBe(401);
    const bodyText = await res.text();
    expect(bodyText).toContain('relay-pairing-auth-failed');
    expect(bodyText).not.toContain('super-secret-admin-token');
  });
});

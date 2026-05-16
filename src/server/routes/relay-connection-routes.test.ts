import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import type { RelayConnectionManager } from '../relay-connection-manager.js';
import { registerRelayConnectionRoutes } from './relay-connection-routes.js';
import type { RouteDeps } from './shared.js';
import { SHARE_CSRF_HEADER } from './share-routes.js';

const CSRF = 'csrf-nonce';
const ORIGIN = 'http://127.0.0.1';

function manager(overrides: Partial<RelayConnectionManager> = {}): RelayConnectionManager {
  return {
    status: () => ({
      configured: false,
      source: 'none',
      connectionState: 'localOnly',
      relayConnected: false,
    }),
    startConfigured: async () => ({
      configured: false,
      source: 'none',
      connectionState: 'localOnly',
      relayConnected: false,
    }),
    connect: vi.fn(async () => ({
      configured: true,
      source: 'stored',
      relayUrl: 'http://relay.test',
      connectionState: 'connected',
      relayConnected: true,
    })),
    disconnect: vi.fn(async () => ({
      configured: true,
      source: 'stored',
      relayUrl: 'http://relay.test',
      connectionState: 'stopped',
      relayConnected: false,
    })),
    forget: vi.fn(async () => ({
      configured: false,
      source: 'none',
      connectionState: 'localOnly',
      relayConnected: false,
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
});

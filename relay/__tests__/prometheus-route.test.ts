import { afterEach, describe, expect, it } from 'vitest';

import { createRelayServer, type RelayServerHandle } from '../server.js';

async function listen(relay: RelayServerHandle): Promise<void> {
  await new Promise<void>((resolve) => relay.httpServer.listen(0, '127.0.0.1', () => resolve()));
}

describe('relay Prometheus metrics route', () => {
  let relay: RelayServerHandle | null = null;

  afterEach(async () => {
    await relay?.close();
    relay = null;
  });

  it('serves a Prometheus exposition with the correct content type behind the admin gate', async () => {
    relay = createRelayServer({ allowInsecureClients: true, adminToken: 'admin' });
    await listen(relay);

    const res = await fetch(new URL('/relay/admin/metrics?format=prometheus', relay.url()), {
      headers: { authorization: 'Bearer admin' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; version=0.0.4');
    const body = await res.text();
    expect(body).toContain('# TYPE kookr_relay_tickets_created_total counter');
    expect(body).toContain('kookr_relay_active_node_sockets');
  });

  it('still returns JSON when format is omitted', async () => {
    relay = createRelayServer({ allowInsecureClients: true, adminToken: 'admin' });
    await listen(relay);

    const res = await fetch(new URL('/relay/admin/metrics', relay.url()), {
      headers: { authorization: 'Bearer admin' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toHaveProperty('metrics');
    expect(body).toHaveProperty('alerts');
  });

  it('rejects the Prometheus format without a valid admin token', async () => {
    relay = createRelayServer({ allowInsecureClients: true, adminToken: 'admin' });
    await listen(relay);

    const res = await fetch(new URL('/relay/admin/metrics?format=prometheus', relay.url()), {
      headers: { authorization: 'Bearer wrong' },
    });

    expect(res.status).toBe(401);
  });
});

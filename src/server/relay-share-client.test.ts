import { afterEach, describe, expect, it } from 'vitest';

import { createRelayServer, type RelayServerHandle } from '../../relay/server.js';
import { createRelayShareClient, RelayShareError } from './relay-share-client.js';

let openHandle: RelayServerHandle | null = null;

afterEach(async () => {
  if (openHandle) {
    await openHandle.close();
    openHandle = null;
  }
});

async function startRelay(): Promise<{ relay: RelayServerHandle; nodeToken: string }> {
  const relay = createRelayServer({ adminToken: 'admin-secret' });
  openHandle = relay;
  await new Promise<void>((resolve) => relay.httpServer.listen(0, '127.0.0.1', () => resolve()));
  const { nodeToken } = relay.registerNode();
  return { relay, nodeToken };
}

describe('createRelayShareClient', () => {
  it('creates a share and returns a fragment-token join URL', async () => {
    const { relay, nodeToken } = await startRelay();
    const client = createRelayShareClient({ relayUrl: relay.url(), relayToken: nodeToken });

    const { share, joinUrl } = await client.createTaskShare({ taskId: 'task-9', ttlMs: 600_000 });

    expect(share.taskId).toBe('task-9');
    expect(typeof share.invitationId).toBe('string');
    expect(share.revokedAt).toBeUndefined();

    const parsed = new URL(joinUrl);
    expect(parsed.pathname).toBe('/relay/join');
    // The token must travel only in the fragment, never the query string.
    expect(parsed.search).toBe('');
    expect(parsed.hash).toMatch(/^#inviteToken=kookr_inv_v1_/);
    expect(joinUrl).not.toContain('?inviteToken');
  });

  it('revokes a previously created share and reports alreadyRevoked', async () => {
    const { relay, nodeToken } = await startRelay();
    const client = createRelayShareClient({ relayUrl: relay.url(), relayToken: nodeToken });

    const { share } = await client.createTaskShare({ taskId: 'task-1', ttlMs: 600_000 });

    const first = await client.revokeTaskShare(share.invitationId);
    expect(first.share.invitationId).toBe(share.invitationId);
    expect(typeof first.share.revokedAt).toBe('string');
    expect(first.alreadyRevoked).toBe(false);

    // A second revoke of the same share is a no-op, surfaced as alreadyRevoked.
    const second = await client.revokeTaskShare(share.invitationId);
    expect(second.alreadyRevoked).toBe(true);
  });

  it('surfaces a relay-rejected token as a 502 RelayShareError', async () => {
    const { relay } = await startRelay();
    const client = createRelayShareClient({ relayUrl: relay.url(), relayToken: 'wrong-token' });

    await expect(client.createTaskShare({ taskId: 't', ttlMs: 600_000 })).rejects.toMatchObject({
      name: 'RelayShareError',
      code: 'relay-rejected-token',
      status: 502,
    });
  });

  it('surfaces an unknown invitation on revoke as a 404 RelayShareError', async () => {
    const { relay, nodeToken } = await startRelay();
    const client = createRelayShareClient({ relayUrl: relay.url(), relayToken: nodeToken });

    await expect(client.revokeTaskShare('inv-missing')).rejects.toMatchObject({
      name: 'RelayShareError',
      code: 'not-found',
      status: 404,
    });
  });

  it('surfaces a malformed relay create response as a 502 RelayShareError', async () => {
    const client = createRelayShareClient({
      relayUrl: 'http://relay.test',
      relayToken: 'token',
      // 200 OK but the body is missing `invitation`/`token`.
      fetchImpl: () => Promise.resolve(new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })),
    });

    await expect(client.createTaskShare({ taskId: 't', ttlMs: 600_000 })).rejects.toMatchObject({
      name: 'RelayShareError',
      code: 'relay-bad-response',
      status: 502,
    });
  });

  it('surfaces a malformed relay revoke response as a 502 RelayShareError', async () => {
    const client = createRelayShareClient({
      relayUrl: 'http://relay.test',
      relayToken: 'token',
      fetchImpl: () => Promise.resolve(new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })),
    });

    await expect(client.revokeTaskShare('inv-1')).rejects.toMatchObject({
      name: 'RelayShareError',
      code: 'relay-bad-response',
      status: 502,
    });
  });

  it('passes a relay 400 through with its status and error code', async () => {
    const client = createRelayShareClient({
      relayUrl: 'http://relay.test',
      relayToken: 'token',
      fetchImpl: () => Promise.resolve(new Response('{"error":"ttlMs out of range"}', {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })),
    });

    await expect(client.createTaskShare({ taskId: 't', ttlMs: 600_000 })).rejects.toMatchObject({
      name: 'RelayShareError',
      code: 'ttlMs out of range',
      status: 400,
    });
  });

  it('surfaces an unreachable relay as a 502 RelayShareError', async () => {
    const client = createRelayShareClient({
      relayUrl: 'http://127.0.0.1:1',
      relayToken: 'token',
      fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
    });

    const error = await client.createTaskShare({ taskId: 't', ttlMs: 600_000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayShareError);
    expect((error as RelayShareError).code).toBe('relay-unreachable');
    expect((error as RelayShareError).status).toBe(502);
  });
});

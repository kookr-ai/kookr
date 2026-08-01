import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRelayServer, type RelayServerHandle } from '../../relay/server.js';
import {
  createRelayShareClient,
  DEFAULT_RELAY_SHARE_REQUEST_TIMEOUT_MS,
  RelayShareError,
} from './relay-share-client.js';

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
  it('creates a share and returns fragment-only legacy and share-ticket join URLs', async () => {
    const { relay, nodeToken } = await startRelay();
    const client = createRelayShareClient({ relayUrl: relay.url(), relayToken: nodeToken });

    const { share, joinUrl, shareTicket } = await client.createTaskShare({ taskId: 'task-9', ttlMs: 600_000 });

    expect(share.taskId).toBe('task-9');
    expect(typeof share.invitationId).toBe('string');
    expect(share.state).toBe('waiting');
    expect(share.connectedViewerCount).toBe(0);
    expect(share.revokedAt).toBeUndefined();
    expect(share.shareId).toMatch(/^\d{3}-\d{3}$/);
    expect(share.redactedShareLabel).toMatch(/^\d{3}-\*\*\*$/);

    const parsed = new URL(joinUrl);
    expect(parsed.pathname).toBe('/relay/join');
    // The token must travel only in the fragment, never the query string.
    expect(parsed.search).toBe('');
    expect(parsed.hash).toMatch(/^#inviteToken=kookr_inv_v1_/);
    expect(joinUrl).not.toContain('?inviteToken');

    expect(shareTicket).toEqual(expect.objectContaining({
      shareId: share.shareId,
      password: expect.any(String),
      redactedShareLabel: share.redactedShareLabel,
    }));
    const ticketUrl = new URL(shareTicket!.joinUrl);
    expect(ticketUrl.pathname).toBe(`/relay/join/${share.shareId}`);
    expect(ticketUrl.search).toBe('');
    expect(ticketUrl.hash).toMatch(/^#password=/);
    expect(shareTicket!.joinUrl).not.toContain('?password');
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

  it('lists node task shares with derived owner state', async () => {
    const { nodeToken, relay } = await startRelay();
    const client = createRelayShareClient({ relayUrl: relay.url(), relayToken: nodeToken });
    const created = await client.createTaskShare({ taskId: 'task-list', ttlMs: 600_000 });

    const shares = await client.listTaskShares();

    expect(shares).toEqual([expect.objectContaining({
      invitationId: created.share.invitationId,
      taskId: 'task-list',
      state: 'waiting',
      connectedViewerCount: 0,
    })]);
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

  it('surfaces a malformed relay list response as a 502 RelayShareError', async () => {
    const client = createRelayShareClient({
      relayUrl: 'http://relay.test',
      relayToken: 'token',
      fetchImpl: () => Promise.resolve(new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })),
    });

    await expect(client.listTaskShares()).rejects.toMatchObject({
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

  it('aborts a hung relay fetch and surfaces relay-unreachable after the timeout', async () => {
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error('expected AbortSignal on relay share fetch'));
        return;
      }
      if (signal.aborted) {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      }, { once: true });
    }));

    const client = createRelayShareClient({
      relayUrl: 'http://relay.test',
      relayToken: 'token',
      requestTimeoutMs: 30,
      fetchImpl: fetchImpl as typeof fetch,
    });

    const error = await client.createTaskShare({ taskId: 't', ttlMs: 600_000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayShareError);
    expect((error as RelayShareError).code).toBe('relay-unreachable');
    expect((error as RelayShareError).status).toBe(502);
    expect((error as RelayShareError).message).toMatch(/aborted/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('happy-path mint still works with a fast fetchImpl under the default timeout', async () => {
    const invitation = {
      invitationId: 'inv-fast',
      taskId: 'task-fast',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      grants: ['view'],
      grantRequests: [],
      connectedViewerCount: 0,
      shareId: '123-456',
      redactedShareLabel: '123-***',
    };
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(false);
      return new Response(JSON.stringify({ invitation, token: 'kookr_inv_v1_testtoken' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const client = createRelayShareClient({
      relayUrl: 'http://relay.test',
      relayToken: 'token',
      // Explicit default documents the production budget in the test.
      requestTimeoutMs: DEFAULT_RELAY_SHARE_REQUEST_TIMEOUT_MS,
      fetchImpl: fetchImpl as typeof fetch,
    });

    const result = await client.createTaskShare({ taskId: 'task-fast', ttlMs: 600_000 });
    expect(result.share.invitationId).toBe('inv-fast');
    expect(result.share.taskId).toBe('task-fast');
    expect(result.joinUrl).toContain('#inviteToken=kookr_inv_v1_testtoken');
    expect(DEFAULT_RELAY_SHARE_REQUEST_TIMEOUT_MS).toBe(10_000);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRelayServer, type RelayServerHandle } from '../../relay/server.js';
import {
  createRelayShareClient,
  DEFAULT_RELAY_SHARE_MAX_RESPONSE_BYTES,
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

  it('keeps the timeout armed through the body and aborts a headers-then-stalled body', async () => {
    // Headers (and a first partial chunk) arrive, then the body stalls forever.
    // The abort timer must still fire and fail the read within the deadline.
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"invita'));
          if (!signal) {
            controller.error(new Error('expected AbortSignal on relay share fetch'));
            return;
          }
          signal.addEventListener('abort', () => {
            controller.error(new DOMException('The operation was aborted.', 'AbortError'));
          }, { once: true });
        },
      });
      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    });

    const client = createRelayShareClient({
      relayUrl: 'http://relay.test',
      relayToken: 'token',
      requestTimeoutMs: 30,
      fetchImpl: fetchImpl as typeof fetch,
    });

    const startedAt = Date.now();
    const error = await client.createTaskShare({ taskId: 't', ttlMs: 600_000 }).catch((e: unknown) => e);
    const elapsedMs = Date.now() - startedAt;
    expect(error).toBeInstanceOf(RelayShareError);
    expect((error as RelayShareError).code).toBe('relay-unreachable');
    expect((error as RelayShareError).status).toBe(502);
    expect((error as RelayShareError).message).toMatch(/aborted/i);
    // The failure must be bound to the configured 30ms deadline, not to
    // vitest's 15s testTimeout backstop: a timer not armed through the body
    // read would leave read() hanging far past this bound. The ceiling is
    // generous (well under the backstop) to stay non-flaky under CI load.
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it('rejects a declared oversized body early and cancels without buffering', async () => {
    let cancelled = false;
    const fetchImpl = vi.fn(() => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024));
        },
        cancel() {
          cancelled = true;
        },
      });
      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': String(5 * 1024 * 1024),
        },
      }));
    });

    const client = createRelayShareClient({
      relayUrl: 'http://relay.test',
      relayToken: 'token',
      maxResponseBytes: 1024,
      fetchImpl: fetchImpl as typeof fetch,
    });

    const error = await client.createTaskShare({ taskId: 't', ttlMs: 600_000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayShareError);
    expect((error as RelayShareError).code).toBe('relay-response-too-large');
    expect((error as RelayShareError).status).toBe(502);
    // The distinctive "declared" message pins the early-reject branch: the
    // streaming-cap branch throws a different message, so this asserts the body
    // was rejected on Content-Length, not merely capped mid-stream.
    expect((error as RelayShareError).message).toMatch(/declared/i);
    // The declared length is rejected without reading the body, and the stream
    // is cancelled so no payload is retained.
    expect(cancelled).toBe(true);
  });

  it('cancels a chunked body with no content-length once it exceeds the cap', async () => {
    let cancelled = false;
    const fetchImpl = vi.fn(() => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          // A relay streaming an unbounded chunked body with no declared length.
          controller.enqueue(new Uint8Array(512));
        },
        cancel() {
          cancelled = true;
        },
      });
      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    });

    const client = createRelayShareClient({
      relayUrl: 'http://relay.test',
      relayToken: 'token',
      maxResponseBytes: 2048,
      fetchImpl: fetchImpl as typeof fetch,
    });

    const error = await client.createTaskShare({ taskId: 't', ttlMs: 600_000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayShareError);
    expect((error as RelayShareError).code).toBe('relay-response-too-large');
    expect((error as RelayShareError).status).toBe(502);
    // The reader is cancelled at the ceiling so the stream stops being pumped.
    expect(cancelled).toBe(true);
  });

  it('reads a multi-chunk JSON body fully, including a late final chunk', async () => {
    const invitation = {
      invitationId: 'inv-chunky',
      taskId: 'task-chunky',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      grants: ['view'],
      grantRequests: [],
      connectedViewerCount: 0,
      shareId: '123-456',
      redactedShareLabel: '123-***',
    };
    const payload = JSON.stringify({ invitation, token: 'kookr_inv_v1_chunky' });
    const fetchImpl = vi.fn(() => {
      const enc = new TextEncoder();
      const mid = Math.floor(payload.length / 2);
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(enc.encode(payload.slice(0, mid)));
          // A deliberately late final chunk: the bounded reader must keep
          // reading past the first chunk and reassemble the whole body.
          await new Promise((resolve) => setTimeout(resolve, 5));
          controller.enqueue(enc.encode(payload.slice(mid)));
          controller.close();
        },
      });
      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    });

    const client = createRelayShareClient({
      relayUrl: 'http://relay.test',
      relayToken: 'token',
      fetchImpl: fetchImpl as typeof fetch,
    });

    const result = await client.createTaskShare({ taskId: 'task-chunky', ttlMs: 600_000 });
    expect(result.share.invitationId).toBe('inv-chunky');
    expect(result.share.taskId).toBe('task-chunky');
    expect(result.joinUrl).toContain('#inviteToken=kookr_inv_v1_chunky');
    // The default cap is far above any legitimate relay JSON response.
    expect(DEFAULT_RELAY_SHARE_MAX_RESPONSE_BYTES).toBe(1024 * 1024);
  });

  it('streams the body through when Content-Length is not a usable number', async () => {
    // A non-numeric (or empty) Content-Length must NOT be trusted as a size:
    // the client falls through to the bounded streaming read rather than
    // rejecting. If the `Number.isFinite` guard were inverted, this would fail.
    const invitation = {
      invitationId: 'inv-nolen',
      taskId: 'task-nolen',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      grants: ['view'],
      grantRequests: [],
      connectedViewerCount: 0,
      shareId: '123-456',
      redactedShareLabel: '123-***',
    };
    const payload = JSON.stringify({ invitation, token: 'kookr_inv_v1_nolen' });
    const fetchImpl = vi.fn(() => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload));
          controller.close();
        },
      });
      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': 'not-a-number' },
      }));
    });

    const client = createRelayShareClient({
      relayUrl: 'http://relay.test',
      relayToken: 'token',
      maxResponseBytes: 4096,
      fetchImpl: fetchImpl as typeof fetch,
    });

    const result = await client.createTaskShare({ taskId: 'task-nolen', ttlMs: 600_000 });
    expect(result.share.invitationId).toBe('inv-nolen');
  });

  it('accepts a body whose decoded size is exactly at the cap', async () => {
    // The ceiling is a strict `> maxBytes`, so a body of exactly the cap must
    // succeed. This guards against an off-by-one to `>=`.
    const invitation = {
      invitationId: 'inv-exact',
      taskId: 'task-exact',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      grants: ['view'],
      grantRequests: [],
      connectedViewerCount: 0,
      shareId: '123-456',
      redactedShareLabel: '123-***',
    };
    const payload = JSON.stringify({ invitation, token: 'kookr_inv_v1_exact' });
    const exactBytes = new TextEncoder().encode(payload).length;
    const fetchImpl = vi.fn(() => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload));
          controller.close();
        },
      });
      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    });

    const client = createRelayShareClient({
      relayUrl: 'http://relay.test',
      relayToken: 'token',
      maxResponseBytes: exactBytes,
      fetchImpl: fetchImpl as typeof fetch,
    });

    const result = await client.createTaskShare({ taskId: 'task-exact', ttlMs: 600_000 });
    expect(result.share.invitationId).toBe('inv-exact');
  });

  it('handles a bodyless response through the no-stream fallback', async () => {
    // `res.body === null` (a genuinely empty body) takes the `!stream` branch;
    // it must not throw a stream error, and the empty text surfaces as the
    // usual missing-fields relay-bad-response rather than crashing the reader.
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    const client = createRelayShareClient({
      relayUrl: 'http://relay.test',
      relayToken: 'token',
      fetchImpl: fetchImpl as typeof fetch,
    });

    const error = await client.createTaskShare({ taskId: 't', ttlMs: 600_000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayShareError);
    expect((error as RelayShareError).code).toBe('relay-bad-response');
    expect((error as RelayShareError).status).toBe(502);
  });
});

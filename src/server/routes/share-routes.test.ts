import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import type { RelayShareClient } from '../relay-share-client.js';
import { RelayShareError } from '../relay-share-client.js';
import type { RouteDeps, RemoteShareDeps } from './shared.js';
import {
  evaluateShareMutationGuard,
  registerShareRoutes,
  SHARE_CSRF_HEADER,
} from './share-routes.js';

const CSRF = 'csrf-nonce-abcdef';
const ORIGIN = 'http://127.0.0.1';

function fakeClient(overrides: Partial<RelayShareClient> = {}): RelayShareClient {
  return {
    createTaskShare: async ({ taskId, ttlMs }) => ({
      share: {
        invitationId: `inv-${taskId}`,
        taskId,
        createdAt: 'c',
        expiresAt: `ttl:${ttlMs}`,
        state: 'waiting',
        connectedViewerCount: 0,
        grants: ['view'],
        grantRequests: [],
      },
      joinUrl: `http://relay.test/relay/join#inviteToken=tok-${taskId}`,
      shareTicket: {
        shareId: '482-913',
        password: 'cobalt-mint-7',
        redactedShareLabel: '482-***',
        joinUrl: 'http://relay.test/relay/join/482-913#password=cobalt-mint-7',
      },
    }),
    revokeTaskShare: async (invitationId) => ({
      share: {
        invitationId,
        taskId: 't',
        createdAt: 'c',
        expiresAt: 'e',
        state: 'revoked',
        connectedViewerCount: 0,
        revokedAt: 'r',
        grants: ['view'],
        grantRequests: [],
      },
      alreadyRevoked: false,
    }),
    listTaskShares: async () => [{
      invitationId: 'inv-listed',
      taskId: 'listed',
      createdAt: 'c',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      state: 'waiting',
      connectedViewerCount: 0,
      grants: ['view'],
      grantRequests: [],
    }],
    approveGrantRequest: async (invitationId, requestId) => ({
      share: {
        invitationId,
        taskId: 't',
        createdAt: 'c',
        expiresAt: 'e',
        state: 'viewerConnected',
        connectedViewerCount: 1,
        grants: ['view', 'terminalInput'],
        grantRequests: [{
          requestId,
          invitationId,
          requestedGrants: ['terminalInput'],
          status: 'approved',
          requestedAt: 'r',
          resolvedAt: 'a',
          resolution: 'approved',
        }],
      },
      request: {
        requestId,
        invitationId,
        requestedGrants: ['terminalInput'],
        status: 'approved',
        requestedAt: 'r',
        resolvedAt: 'a',
        resolution: 'approved',
      },
    }),
    denyGrantRequest: async (invitationId, requestId) => ({
      share: {
        invitationId,
        taskId: 't',
        createdAt: 'c',
        expiresAt: 'e',
        state: 'viewerConnected',
        connectedViewerCount: 1,
        grants: ['view'],
        grantRequests: [{
          requestId,
          invitationId,
          requestedGrants: ['terminalInput'],
          status: 'denied',
          requestedAt: 'r',
          resolvedAt: 'd',
          resolution: 'denied',
        }],
      },
      request: {
        requestId,
        invitationId,
        requestedGrants: ['terminalInput'],
        status: 'denied',
        requestedAt: 'r',
        resolvedAt: 'd',
        resolution: 'denied',
      },
    }),
    ...overrides,
  };
}

function mkApp(remoteShare: RemoteShareDeps | undefined, opts: { taskExists?: boolean } = {}): Hono {
  const taskExists = opts.taskExists ?? true;
  // The share routes touch only `taskStore.getTask`, so the stub deliberately
  // implements just that slice of the real `TaskStore`.
  const taskStore = { getTask: (id: string) => (taskExists && id ? { id } : undefined) };
  const app = new Hono();
  registerShareRoutes(app, { remoteShare, taskStore } as unknown as RouteDeps);
  return app;
}

function post(app: Hono, path: string, headers: Record<string, string>, body?: unknown): Promise<Response> {
  return app.request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? '{}' : JSON.stringify(body),
  });
}

describe('evaluateShareMutationGuard', () => {
  const base = { requestUrl: 'http://127.0.0.1/api/share/task', expectedCsrfToken: CSRF };

  it('accepts a same-origin request with a matching CSRF token', () => {
    expect(evaluateShareMutationGuard({ ...base, origin: ORIGIN, csrfHeader: CSRF }))
      .toEqual({ ok: true });
  });

  it('rejects a request with no Origin header', () => {
    expect(evaluateShareMutationGuard({ ...base, origin: undefined, csrfHeader: CSRF }))
      .toEqual({ ok: false, status: 403, error: 'origin-required' });
  });

  it('rejects a cross-origin request', () => {
    expect(evaluateShareMutationGuard({ ...base, origin: 'http://evil.example', csrfHeader: CSRF }))
      .toEqual({ ok: false, status: 403, error: 'cross-origin-forbidden' });
  });

  it('rejects a same-host request from a different port', () => {
    expect(evaluateShareMutationGuard({
      requestUrl: 'http://127.0.0.1:4801/api/share/task',
      expectedCsrfToken: CSRF,
      origin: 'http://127.0.0.1:9999',
      csrfHeader: CSRF,
    })).toEqual({ ok: false, status: 403, error: 'cross-origin-forbidden' });
  });

  it('rejects an opaque/unparseable Origin', () => {
    expect(evaluateShareMutationGuard({ ...base, origin: 'null', csrfHeader: CSRF }))
      .toEqual({ ok: false, status: 403, error: 'bad-origin' });
  });

  it('rejects a missing CSRF token', () => {
    expect(evaluateShareMutationGuard({ ...base, origin: ORIGIN, csrfHeader: undefined }))
      .toEqual({ ok: false, status: 403, error: 'invalid-csrf-token' });
  });

  it('rejects a wrong CSRF token', () => {
    expect(evaluateShareMutationGuard({ ...base, origin: ORIGIN, csrfHeader: 'guessed' }))
      .toEqual({ ok: false, status: 403, error: 'invalid-csrf-token' });
  });

  it('rejects an unparseable request URL', () => {
    expect(evaluateShareMutationGuard({
      requestUrl: 'not a url',
      expectedCsrfToken: CSRF,
      origin: ORIGIN,
      csrfHeader: CSRF,
    })).toEqual({ ok: false, status: 400, error: 'bad-request-url' });
  });
});

describe('share routes — local-only mode', () => {
  it('answers 409 relay-not-configured for csrf-token, create, and revoke', async () => {
    const app = mkApp(undefined);

    const csrf = await app.request(`${ORIGIN}/api/share/csrf-token`);
    expect(csrf.status).toBe(409);

    const list = await app.request(`${ORIGIN}/api/share/task`);
    expect(list.status).toBe(409);

    const create = await post(app, '/api/share/task', { Origin: ORIGIN }, { taskId: 't' });
    expect(create.status).toBe(409);
    expect(await create.json()).toEqual({ error: 'relay-not-configured' });

    const revoke = await post(app, '/api/share/task/inv-1/revoke', { Origin: ORIGIN });
    expect(revoke.status).toBe(409);
  });

  it('answers 409 when a relay URL is set but produced no client', async () => {
    const app = mkApp({ csrfToken: CSRF, client: null });
    const create = await post(app, '/api/share/task', { Origin: ORIGIN }, { taskId: 't' });
    expect(create.status).toBe(409);
  });
});

describe('share routes — CSRF / Origin enforcement', () => {
  const remoteShare: RemoteShareDeps = { csrfToken: CSRF, client: fakeClient() };

  it('serves the CSRF nonce', async () => {
    const res = await mkApp(remoteShare).request(`${ORIGIN}/api/share/csrf-token`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ csrfToken: CSRF, shareMaxTtlMs: 24 * 60 * 60 * 1000 });
  });

  it('rejects a create with no CSRF header', async () => {
    const res = await post(mkApp(remoteShare), '/api/share/task', { Origin: ORIGIN }, { taskId: 't' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'invalid-csrf-token' });
  });

  it('rejects a cross-origin create even with a valid CSRF header', async () => {
    const res = await post(
      mkApp(remoteShare),
      '/api/share/task',
      { Origin: 'http://attacker.example', [SHARE_CSRF_HEADER]: CSRF },
      { taskId: 't' },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'cross-origin-forbidden' });
  });

  it('rejects a cross-origin revoke', async () => {
    const res = await post(
      mkApp(remoteShare),
      '/api/share/task/inv-1/revoke',
      { Origin: 'http://attacker.example', [SHARE_CSRF_HEADER]: CSRF },
    );
    expect(res.status).toBe(403);
  });
});

describe('share routes — create and revoke', () => {
  const remoteShare: RemoteShareDeps = { csrfToken: CSRF, client: fakeClient() };
  const okHeaders = { Origin: ORIGIN, [SHARE_CSRF_HEADER]: CSRF };

  it('lists shares with coarse owner state', async () => {
    const res = await mkApp(remoteShare).request(`${ORIGIN}/api/share/task`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      shareMaxTtlMs: 24 * 60 * 60 * 1000,
      shares: [expect.objectContaining({
        invitationId: 'inv-listed',
        taskId: 'listed',
        state: 'waiting',
        connectedViewerCount: 0,
      })],
    });
  });

  it('creates a share and returns a fragment-token join URL plus share ticket', async () => {
    const res = await post(mkApp(remoteShare), '/api/share/task', okHeaders, { taskId: 'task-5' });
    expect(res.status).toBe(201);
    const body = await res.json() as { share: { taskId: string }; joinUrl: string; shareTicket: { shareId: string; password: string; joinUrl: string } };
    expect(body.share.taskId).toBe('task-5');
    expect(body.joinUrl).toContain('#inviteToken=');
    expect(body.joinUrl).not.toContain('?inviteToken');
    expect(body.shareTicket).toEqual({
      shareId: '482-913',
      password: 'cobalt-mint-7',
      redactedShareLabel: '482-***',
      joinUrl: 'http://relay.test/relay/join/482-913#password=cobalt-mint-7',
    });
    expect(body.shareTicket.joinUrl).not.toContain('?password');
  });

  it('defaults the TTL when none is supplied', async () => {
    const res = await post(mkApp(remoteShare), '/api/share/task', okHeaders, { taskId: 'task-d' });
    const body = await res.json() as { share: { expiresAt: string } };
    // fakeClient encodes the received ttlMs into expiresAt.
    expect(body.share.expiresAt).toBe(`ttl:${10 * 60 * 1000}`);
  });

  it('rejects a missing taskId', async () => {
    const res = await post(mkApp(remoteShare), '/api/share/task', okHeaders, {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'taskId is required' });
  });

  it('rejects a malformed JSON body', async () => {
    const res = await mkApp(remoteShare).request(`${ORIGIN}/api/share/task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...okHeaders },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid-json-body' });
  });

  it('rejects a share for a task that does not exist on this node', async () => {
    const res = await post(
      mkApp(remoteShare, { taskExists: false }),
      '/api/share/task',
      okHeaders,
      { taskId: 'ghost' },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'task-not-found' });
  });

  it('rejects an out-of-range TTL', async () => {
    const res = await post(mkApp(remoteShare), '/api/share/task', okHeaders, { taskId: 't', ttlMs: 5 });
    expect(res.status).toBe(400);
  });

  it('uses the relay-advertised max TTL and passes a display label through', async () => {
    const createTaskShare = async ({ taskId, ttlMs, displayLabel }: { taskId: string; ttlMs: number; displayLabel?: string }) => ({
      share: {
        invitationId: `inv-${taskId}`,
        taskId,
        createdAt: 'c',
        expiresAt: `ttl:${ttlMs}:${displayLabel}`,
        state: 'waiting' as const,
        connectedViewerCount: 0,
        grants: ['view' as const],
        grantRequests: [],
      },
      joinUrl: 'http://relay.test/relay/join#inviteToken=tok',
    });
    const app = mkApp({
      csrfToken: CSRF,
      client: fakeClient({ createTaskShare }),
      getShareMaxTtlMs: () => 31 * 24 * 60 * 60 * 1000,
    });
    const res = await post(app, '/api/share/task', okHeaders, {
      taskId: 't',
      ttlMs: 31 * 24 * 60 * 60 * 1000,
      displayLabel: 'Public task label',
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      shareMaxTtlMs: 31 * 24 * 60 * 60 * 1000,
      share: { expiresAt: `ttl:${31 * 24 * 60 * 60 * 1000}:Public task label` },
    });
  });

  it('sanitizes display labels before forwarding them to the relay client', async () => {
    const createTaskShare = async ({ taskId, ttlMs, displayLabel }: { taskId: string; ttlMs: number; displayLabel?: string }) => ({
      share: {
        invitationId: `inv-${taskId}`,
        taskId,
        createdAt: 'c',
        expiresAt: `ttl:${ttlMs}:${displayLabel}`,
        state: 'waiting' as const,
        connectedViewerCount: 0,
        grants: ['view' as const],
        grantRequests: [],
      },
      joinUrl: 'http://relay.test/relay/join#inviteToken=tok',
    });
    const app = mkApp({ csrfToken: CSRF, client: fakeClient({ createTaskShare }) });
    const raw = `  ${'a'.repeat(90)}\u202e\n  `;
    const res = await post(app, '/api/share/task', okHeaders, {
      taskId: 't',
      ttlMs: 60_000,
      displayLabel: raw,
    });

    expect(res.status).toBe(201);
    const body = await res.json() as { share: { expiresAt: string } };
    expect(body.share.expiresAt).toBe(`ttl:60000:${'a'.repeat(80)}`);
  });

  it('rejects non-string display labels', async () => {
    const res = await post(mkApp(remoteShare), '/api/share/task', okHeaders, {
      taskId: 't',
      ttlMs: 60_000,
      displayLabel: 123,
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'displayLabel must be a string' });
  });

  it('revokes a share and reports alreadyRevoked', async () => {
    const res = await post(mkApp(remoteShare), '/api/share/task/inv-77/revoke', okHeaders);
    expect(res.status).toBe(200);
    const body = await res.json() as { share: { invitationId: string; revokedAt?: string }; alreadyRevoked: boolean };
    expect(body.share.invitationId).toBe('inv-77');
    expect(body.share.revokedAt).toBe('r');
    expect(body.alreadyRevoked).toBe(false);
  });

  it('passes through alreadyRevoked: true from the relay', async () => {
    const app = mkApp({
      csrfToken: CSRF,
      client: fakeClient({
        revokeTaskShare: async (invitationId) => ({
          share: {
            invitationId,
            taskId: 't',
            createdAt: 'c',
            expiresAt: 'e',
            state: 'revoked',
            connectedViewerCount: 0,
            revokedAt: 'r',
            grants: ['view'],
            grantRequests: [],
          },
          alreadyRevoked: true,
        }),
      }),
    });
    const res = await post(app, '/api/share/task/inv-9/revoke', okHeaders);
    expect(res.status).toBe(200);
    expect((await res.json() as { alreadyRevoked: boolean }).alreadyRevoked).toBe(true);
  });

  it('maps a RelayShareError to its HTTP status', async () => {
    const failing = mkApp({
      csrfToken: CSRF,
      client: fakeClient({
        createTaskShare: () => Promise.reject(new RelayShareError('relay-rejected-token', 502)),
      }),
    });
    const res = await post(failing, '/api/share/task', okHeaders, { taskId: 't' });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'relay-rejected-token' });
  });

  it('approves a pending grant request through the owner-confirmed route', async () => {
    const res = await post(
      mkApp(remoteShare),
      '/api/share/task/inv-1/grant-requests/grant-req-1/approve',
      okHeaders,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      share: expect.objectContaining({
        invitationId: 'inv-1',
        grants: ['view', 'terminalInput'],
      }),
      request: expect.objectContaining({
        requestId: 'grant-req-1',
        status: 'approved',
        resolution: 'approved',
      }),
    });
  });

  it('denies a pending grant request through the owner-confirmed route', async () => {
    const res = await post(
      mkApp(remoteShare),
      '/api/share/task/inv-1/grant-requests/grant-req-1/deny',
      okHeaders,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      share: expect.objectContaining({
        invitationId: 'inv-1',
        grants: ['view'],
      }),
      request: expect.objectContaining({
        requestId: 'grant-req-1',
        status: 'denied',
        resolution: 'denied',
      }),
    });
  });

  it('requires CSRF for grant request approval', async () => {
    const res = await post(
      mkApp(remoteShare),
      '/api/share/task/inv-1/grant-requests/grant-req-1/approve',
      { Origin: ORIGIN },
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'invalid-csrf-token' });
  });

  it('maps grant request relay failures to their HTTP status', async () => {
    const failing = mkApp({
      csrfToken: CSRF,
      client: fakeClient({
        approveGrantRequest: () => Promise.reject(new RelayShareError('already-resolved', 409)),
      }),
    });

    const res = await post(
      failing,
      '/api/share/task/inv-1/grant-requests/grant-req-1/approve',
      okHeaders,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'already-resolved' });
  });
});

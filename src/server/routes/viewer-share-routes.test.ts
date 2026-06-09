import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { WebSocket } from 'ws';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ViewerGrantStore } from '../../core/viewer-grants.js';
import { ViewerConnectionRegistry } from '../viewer-connection-registry.js';
import { CollaborationAuditLog } from '../collaboration-audit-log.js';
import type { CollaborationAuditEvent } from '../../shared/contracts/collaboration-audit.js';
import { registerViewerShareRoutes, isViewerShareRoute } from './viewer-share-routes.js';
import { isShareGuardedRoute } from './share-routes.js';
import { createApiAuthMiddleware, type ApiAuthConfig, type ViewerTokenResolution } from '../auth.js';
import { createCsrfMiddleware, computeCsrfToken, generateCsrfSecret } from '../auth-session.js';
import type { RouteDeps } from './shared.js';

function readAuditEvents(kookrDir: string): CollaborationAuditEvent[] {
  const file = join(kookrDir, 'collaboration-audit.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CollaborationAuditEvent);
}

async function get(app: Hono, path: string) {
  return app.request(`http://localhost${path}`);
}

async function post(app: Hono, path: string, body?: unknown) {
  return app.request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe('viewer-share-routes', () => {
  let kookrDir: string;
  let grantStore: ViewerGrantStore;
  let registry: ViewerConnectionRegistry;
  let auditLog: CollaborationAuditLog;
  let app: Hono;

  beforeEach(async () => {
    kookrDir = mkdtempSync(join(tmpdir(), 'viewer-share-routes-'));
    grantStore = new ViewerGrantStore(kookrDir);
    await grantStore.load();
    registry = new ViewerConnectionRegistry({ autoStartSweep: false });
    auditLog = new CollaborationAuditLog({ kookrDir });
    app = new Hono();
    registerViewerShareRoutes(app, {
      viewerShare: { grantStore, registry, auditLog },
    } as unknown as RouteDeps);
  });

  afterEach(() => {
    registry.stopSweep();
    rmSync(kookrDir, { recursive: true, force: true });
  });

  it('creates an all-scope grant, returns the raw token once + a handoff URL, and audits it', async () => {
    const res = await post(app, '/api/share/viewers', { label: 'Alice' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      grant: { id: string; label: string; scope: { kind: string } };
      token: string;
      handoffUrl: string;
    };
    expect(body.grant.label).toBe('Alice');
    expect(body.grant.scope).toEqual({ kind: 'all' });
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    // The handoff URL carries the raw token in the fragment (never the query/path).
    expect(body.handoffUrl).toContain(`#token=${body.token}`);

    const events = readAuditEvents(kookrDir);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('viewer-grant.created');
    expect(events[0].grantId).toBe(body.grant.id);
  });

  it('defaults a missing label and defaults scope to all', async () => {
    const res = await post(app, '/api/share/viewers', {});
    expect(res.status).toBe(201);
    const body = (await res.json()) as { grant: { label: string; scope: { kind: string } } };
    expect(body.grant.label).toBe('Viewer link');
    expect(body.grant.scope).toEqual({ kind: 'all' });
  });

  it('creates a projects-scoped grant (canonicalized) and audits it (#811)', async () => {
    const res = await post(app, '/api/share/viewers', {
      label: 'scoped',
      // Deliberately unsorted + duplicated to prove canonicalization on mint.
      scope: { kind: 'projects', projectIds: ['p2', 'p1', 'p2'] },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { grant: { id: string; scope: unknown } };
    expect(body.grant.scope).toEqual({ kind: 'projects', projectIds: ['p1', 'p2'] });
    expect(grantStore.list()).toHaveLength(1);
    const events = readAuditEvents(kookrDir);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('viewer-grant.created');
  });

  it('rejects a projects-scoped create with an empty projectIds (400 empty-scope), writes no grant', async () => {
    const res = await post(app, '/api/share/viewers', {
      label: 'empty',
      scope: { kind: 'projects', projectIds: [] },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('empty-scope');
    expect(grantStore.list()).toHaveLength(0);
    expect(readAuditEvents(kookrDir)).toHaveLength(0);
  });

  it('rejects a malformed scope with 400', async () => {
    const res = await post(app, '/api/share/viewers', { scope: { kind: 'bogus' } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid-scope');
  });

  it('stores a valid ISO-8601 expiry and echoes it back on create (#811)', async () => {
    const expiresAt = '2030-01-01T00:00:00.000Z';
    const res = await post(app, '/api/share/viewers', { label: 'exp', expiresAt });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { grant: { id: string; expiresAt?: string } };
    expect(body.grant.expiresAt).toBe(expiresAt);
    expect(grantStore.list()[0].expiresAt).toBe(expiresAt);
  });

  it('rejects a malformed expiry with 400', async () => {
    const res = await post(app, '/api/share/viewers', { expiresAt: 'not-a-date' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid-expiry');
  });

  it('lists grants (no raw token) and the live roster', async () => {
    await post(app, '/api/share/viewers', { label: 'one' });
    const res = await get(app, '/api/share/viewers');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      grants: Array<{ id: string; label: string; tokenHash?: string }>;
      roster: unknown[];
    };
    expect(body.grants).toHaveLength(1);
    expect(body.grants[0]).not.toHaveProperty('tokenHash');
    // No viewer is connected, so the roster is empty (Phase 1 admits no viewers).
    expect(body.roster).toEqual([]);
  });

  it('revokes a grant, audits it, and a re-revoke / unknown id is 404 vs idempotent', async () => {
    const created = (await (await post(app, '/api/share/viewers', { label: 'x' })).json()) as {
      grant: { id: string };
    };
    const id = created.grant.id;

    const revoke = await post(app, `/api/share/viewers/${id}/revoke`);
    expect(revoke.status).toBe(200);
    expect(grantStore.liveness(id)).toBe('revoked');

    const events = readAuditEvents(kookrDir).map((e) => e.event);
    expect(events).toContain('viewer-grant.created');
    expect(events).toContain('viewer-grant.revoked');

    // Re-revoking an already-revoked (but existing) grant is idempotent ⇒ 200.
    const reRevoke = await post(app, `/api/share/viewers/${id}/revoke`);
    expect(reRevoke.status).toBe(200);
    expect(grantStore.liveness(id)).toBe('revoked');

    // Unknown id ⇒ 404.
    const missing = await post(app, '/api/share/viewers/does-not-exist/revoke');
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBe('grant-not-found');
  });

  it('revoke drops a live viewer socket within one sweep (acceptance, end-to-end)', async () => {
    // Wire a registry whose sweep reads grant liveness from THIS store — the
    // production wiring (index.ts: resolveGrantLiveness = grantStore.liveness).
    const sweptRegistry = new ViewerConnectionRegistry({
      autoStartSweep: false,
      resolveGrantLiveness: (id) => grantStore.liveness(id),
    });
    const sweepApp = new Hono();
    registerViewerShareRoutes(sweepApp, {
      viewerShare: { grantStore, registry: sweptRegistry, auditLog },
    } as unknown as RouteDeps);

    // Create a grant and register a live viewer socket holding it.
    const created = (await (await post(sweepApp, '/api/share/viewers', { label: 'live' })).json()) as {
      grant: { id: string };
    };
    const ws = { readyState: WebSocket.OPEN, close: vi.fn(), send: vi.fn() } as unknown as WebSocket;
    sweptRegistry.register(ws, { kind: 'viewer', grantId: created.grant.id, scope: { kind: 'all' } }, 'dashboard');
    expect(sweptRegistry.connectedViewerCount()).toBe(1);

    // Revoke via the route, then run one sweep tick: the socket is closed (1008)
    // and dropped.
    expect((await post(sweepApp, `/api/share/viewers/${created.grant.id}/revoke`)).status).toBe(200);
    sweptRegistry.sweep();

    expect(ws.close).toHaveBeenCalledWith(1008, 'Access revoked');
    expect(sweptRegistry.connectedViewerCount()).toBe(0);
    sweptRegistry.stopSweep();
  });

  it('reports share-feature-disabled when the feature is not wired', async () => {
    const bare = new Hono();
    registerViewerShareRoutes(bare, {} as unknown as RouteDeps);
    expect((await post(bare, '/api/share/viewers', {})).status).toBe(503);
    expect((await get(bare, '/api/share/viewers')).status).toBe(503);
    expect((await post(bare, '/api/share/viewers/abc/revoke')).status).toBe(503);
  });

  it('denies a viewer actor on the control surface (defense in depth)', async () => {
    const guarded = new Hono();
    // Simulate the actor gate having set a viewer actor on the context.
    guarded.use('*', async (c, next) => {
      c.set('actor', { kind: 'viewer', grantId: 'g1', scope: { kind: 'all' } });
      await next();
    });
    registerViewerShareRoutes(guarded, {
      viewerShare: { grantStore, registry, auditLog },
    } as unknown as RouteDeps);
    expect((await post(guarded, '/api/share/viewers', {})).status).toBe(403);
    expect((await get(guarded, '/api/share/viewers')).status).toBe(403);
  });

  // Integration: build the SAME middleware stack as `routes.ts` (actor gate +
  // standard `x-kookr-csrf` guard with the viewer-share routes un-exempted) and
  // prove the control surface is owner-only AND CSRF-protected — guarding against
  // the failure mode where the routes match `isShareGuardedRoute` and silently
  // lose CSRF protection.
  describe('under the production auth + CSRF middleware stack', () => {
    const OWNER_TOKEN = 'owner-secret';
    const csrfSecret = generateCsrfSecret();

    function gatedApp(resolveViewer?: (token: string) => ViewerTokenResolution): Hono {
      const apiAuth: ApiAuthConfig = { required: true, token: OWNER_TOKEN, ...(resolveViewer ? { resolveViewer } : {}) };
      const stacked = new Hono();
      stacked.use('*', createApiAuthMiddleware(apiAuth));
      stacked.use(
        '*',
        createCsrfMiddleware({
          apiAuth,
          csrfSecret,
          isExempt: (path) => isShareGuardedRoute(path) && !isViewerShareRoute(path),
        }),
      );
      registerViewerShareRoutes(stacked, {
        viewerShare: { grantStore, registry, auditLog },
      } as unknown as RouteDeps);
      return stacked;
    }

    function req(app: Hono, method: 'GET' | 'POST', path: string, headers: Record<string, string>, body?: unknown) {
      return app.request(`http://lan.example${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    }

    it('rejects a request with no credential (401)', async () => {
      const res = await req(gatedApp(), 'POST', '/api/share/viewers', {}, {});
      expect(res.status).toBe(401);
    });

    it('the viewer-share routes are NOT exempt from the standard CSRF guard', () => {
      // Regression guard for the failure mode: they match the share prefix but
      // must be un-exempted so the standard guard applies.
      expect(isShareGuardedRoute('/api/share/viewers')).toBe(true);
      expect(isViewerShareRoute('/api/share/viewers')).toBe(true);
      expect(isViewerShareRoute('/api/share/viewers/abc/revoke')).toBe(true);
    });

    it('rejects a cookie-authenticated POST missing the x-kookr-csrf nonce (403 csrf-failed)', async () => {
      const res = await req(gatedApp(), 'POST', '/api/share/viewers', { cookie: `kookr_session=${OWNER_TOKEN}` }, {});
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe('csrf-failed');
    });

    it('accepts a cookie-authenticated POST carrying a valid x-kookr-csrf nonce (201)', async () => {
      const nonce = computeCsrfToken(csrfSecret, OWNER_TOKEN);
      const res = await req(
        gatedApp(),
        'POST',
        '/api/share/viewers',
        { cookie: `kookr_session=${OWNER_TOKEN}`, 'x-kookr-csrf': nonce },
        { label: 'ok' },
      );
      expect(res.status).toBe(201);
    });

    it('accepts a header-credentialed (CLI) POST with no CSRF nonce (201)', async () => {
      const res = await req(gatedApp(), 'POST', '/api/share/viewers', { authorization: `Bearer ${OWNER_TOKEN}` }, {});
      expect(res.status).toBe(201);
    });

    it('denies a valid viewer credential on the control surface (403 forbidden, by the actor gate)', async () => {
      const resolveViewer = (token: string): ViewerTokenResolution =>
        token === 'viewer-token' ? { kind: 'valid', grantId: 'g1', scope: { kind: 'all' } } : { kind: 'not-found' };
      const res = await req(gatedApp(resolveViewer), 'GET', '/api/share/viewers', { cookie: 'kookr_session=viewer-token' });
      expect(res.status).toBe(403);
    });
  });
});

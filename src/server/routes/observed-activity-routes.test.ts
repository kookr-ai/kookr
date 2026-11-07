import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerObservedActivityRoutes, type ObservedActivityRouteDeps } from './observed-activity-routes.js';
import { ObservedActivityStore, OBSERVED_SESSION_PREFIX } from '../observed-activity-store.js';

const TOKEN = 'observer-secret-123';
const HEADER = 'x-kookr-observer-token';
const SID = `${OBSERVED_SESSION_PREFIX}alpha`;

describe('observed-activity routes', () => {
  let dir: string;

  function app(deps: Partial<ObservedActivityRouteDeps>): Hono {
    const a = new Hono();
    registerObservedActivityRoutes(a, { kookrDir: dir, ...deps });
    return a;
  }

  function post(a: Hono, body: unknown, headers: Record<string, string> = {}) {
    return a.request('/api/observed-activity/hermes-fleet', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hermes-obs-routes-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('flag OFF ⇒ routes not registered (404)', async () => {
    const res = await post(app({ hermesFleetOptIn: false, hermesObserverToken: TOKEN }), { sessionId: SID, state: 'working', ts: 1 }, { [HEADER]: TOKEN });
    expect(res.status).toBe(404);
  });

  test('flag ON but no token configured ⇒ routes not registered, fail closed (404)', async () => {
    const res = await post(app({ hermesFleetOptIn: true }), { sessionId: SID, state: 'working', ts: 1 }, { [HEADER]: 'anything' });
    expect(res.status).toBe(404);
  });

  test('missing/wrong token ⇒ 401 even on loopback', async () => {
    const a = app({ hermesFleetOptIn: true, hermesObserverToken: TOKEN });
    expect((await post(a, { sessionId: SID, state: 'working', ts: 1 })).status).toBe(401);
    expect((await post(a, { sessionId: SID, state: 'working', ts: 1 }, { [HEADER]: 'wrong' })).status).toBe(401);
  });

  test('valid pulse with token ⇒ 200, provider pinned server-side', async () => {
    const res = await post(app({ hermesFleetOptIn: true, hermesObserverToken: TOKEN }),
      { sessionId: SID, state: 'working', label: 'PR #7', provider: 'claude-code', ts: 1 }, { [HEADER]: TOKEN });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'received', outcome: 'accepted', provider: 'hermes-fleet' });
  });

  test('rejects a session id without the reserved prefix (400)', async () => {
    const res = await post(app({ hermesFleetOptIn: true, hermesObserverToken: TOKEN }),
      { sessionId: 'not-prefixed', state: 'working', ts: 1 }, { [HEADER]: TOKEN });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_session_id');
  });

  test('rejects an invalid state (400)', async () => {
    const res = await post(app({ hermesFleetOptIn: true, hermesObserverToken: TOKEN }),
      { sessionId: SID, state: 'busy', ts: 1 }, { [HEADER]: TOKEN });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_state');
  });

  test('rejects an over-long label and a non-numeric ts (400)', async () => {
    const a = app({ hermesFleetOptIn: true, hermesObserverToken: TOKEN });
    const longLabel = 'x'.repeat(201);
    expect((await post(a, { sessionId: SID, state: 'working', label: longLabel, ts: 1 }, { [HEADER]: TOKEN })).status).toBe(400);
    expect((await post(a, { sessionId: SID, state: 'working', ts: 'soon' }, { [HEADER]: TOKEN })).status).toBe(400);
  });

  test('rejects malformed JSON (400) and an over-large body (413)', async () => {
    const a = app({ hermesFleetOptIn: true, hermesObserverToken: TOKEN });
    expect((await post(a, '{ not json', { [HEADER]: TOKEN })).status).toBe(400);
    const huge = JSON.stringify({ sessionId: SID, state: 'working', label: 'y'.repeat(5000), ts: 1 });
    expect((await post(a, huge, { [HEADER]: TOKEN })).status).toBe(413);
  });

  test('status route returns the lane snapshot (token-gated)', async () => {
    const a = app({ hermesFleetOptIn: true, hermesObserverToken: TOKEN });
    await post(a, { sessionId: SID, state: 'working', label: 'live', ts: 1 }, { [HEADER]: TOKEN });
    const unauth = await a.request('/api/observed-activity/hermes-fleet/status');
    expect(unauth.status).toBe(401);
    const res = await a.request('/api/observed-activity/hermes-fleet/status', { headers: { [HEADER]: TOKEN } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({ sessionId: SID, effectiveState: 'working' });
    expect(body.counters.accepted).toBe(1);
  });

  test('ping self-test is token-gated and returns ok', async () => {
    const a = app({ hermesFleetOptIn: true, hermesObserverToken: TOKEN });
    expect((await a.request('/api/observed-activity/hermes-fleet/ping', { method: 'POST' })).status).toBe(401);
    const res = await a.request('/api/observed-activity/hermes-fleet/ping', { method: 'POST', headers: { [HEADER]: TOKEN } });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  test('rate limit surfaces as 429 and increments the rejected counter', async () => {
    const store = new ObservedActivityStore(dir, { rateLimit: 1, rateWindowMs: 60_000 });
    const a = app({ hermesFleetOptIn: true, hermesObserverToken: TOKEN, observedActivityStore: store });
    expect((await post(a, { sessionId: SID, state: 'working', ts: 1 }, { [HEADER]: TOKEN })).status).toBe(200);
    expect((await post(a, { sessionId: SID, state: 'working', ts: 2 }, { [HEADER]: TOKEN })).status).toBe(429);
    const snap = await store.snapshot();
    expect(snap.counters.rejected.rate_limited).toBe(1);
  });
});

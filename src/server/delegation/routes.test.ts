import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createA2aClient } from './a2a-client.js';
import { FakeA2aServer } from './__fixtures__/fake-a2a-server.js';
import { makeConfig, worker } from './__fixtures__/builders.js';
import { registerDelegationRoutes } from './routes.js';
import { DelegationService } from './service.js';
import { DelegationStore } from './store.js';

const SHA = 'b'.repeat(40);
const TOKEN = 'route-test-secret-token-0123456789';
const VERDICT = JSON.stringify({
  type: 'chore', priority: 'P3', size: 'XS', ready_to_implement: true, needs_info: [], related_issues: [],
  risk: 'low', files_likely_touched: [], summary: 's', recommended_next_step: 'n',
});

let dir: string;
let server: FakeA2aServer;
let logs: string[];
let services: DelegationService[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'delegation-routes-'));
  server = new FakeA2aServer(TOKEN);
  await server.start();
  server.plan = () => ({ kind: 'reply', text: VERDICT, delayMs: 30 });
  logs = [];
  services = [];
});
afterEach(async () => {
  for (const s of services) {
    s.stop();
    await s.drain();
  }
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function makeService(opts: { maxInFlight?: number } = {}): Promise<DelegationService> {
  writeFileSync(join(dir, 'tok'), TOKEN, { mode: 0o600 });
  const workers = [worker('w1', { url: server.url, tokenFile: join(dir, 'tok'), maxInFlight: opts.maxInFlight ?? 2 })];
  const svc = new DelegationService({
    config: makeConfig({ workers }),
    workers,
    store: new DelegationStore(join(dir, 'delegations.json'), { newInstanceId: () => 'inst0001' }),
    client: createA2aClient(),
    snapshots: { ensureCurrent: async (p) => ({ projectId: p, sha: SHA, dir }), dirFor: () => dir, cleanup: async () => [] },
    fetchIssue: async () => ({ number: 1, title: 't', state: 'OPEN', labels: [], body: 'b', comments: [], truncated: false }),
    log: (l) => logs.push(l),
    timings: { resolveIntervalMs: 15, pollIntervalMs: 15, recoveryGraceMs: 100, recoveryBackoffMs: [10], callTimeoutMs: 500 },
  });
  services.push(svc);
  await svc.start();
  return svc;
}

function appWith(svc?: DelegationService, nowMs?: () => number): Hono {
  const app = new Hono();
  registerDelegationRoutes(app, { ...(svc ? { delegationService: svc } : {}), ...(nowMs ? { nowMs } : {}) });
  return app;
}

const post = (app: Hono, body: unknown) =>
  app.request('/api/delegations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const good = { kind: 'triage', projectId: 'proj', issueRef: 12 };

describe('delegation routes', () => {
  test('no service -> routes ARE registered and answer 503 delegation_disabled with a reason (RFC section 5)', async () => {
    const app = appWith(undefined);
    for (const res of [
      await post(app, good),
      await app.request('/api/delegations/abc'),
      await app.request('/api/delegations?parent=p'),
    ]) {
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: 'delegation_disabled', reason: 'flag_off' });
    }
    const withReason = new Hono();
    registerDelegationRoutes(withReason, { delegationDisabled: { reason: 'invalid_config', missing: ['workers[0].tokenFile'] } });
    const r = await withReason.request('/api/delegations', { method: 'POST', body: '{}' });
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: 'delegation_disabled', reason: 'invalid_config', missing: ['workers[0].tokenFile'] });
  });

  test('acceptingNewDelegations=false refuses ONLY new submissions: GETs and in-flight work keep working (ordered disable)', async () => {
    const svc = await makeService();
    const app = appWith(svc);
    const created = await post(app, { ...good, key: 'before' });
    expect(created.status).toBe(202);
    const id = ((await created.json()) as { delegation: { id: string } }).delegation.id;

    let accepting = false;
    (svc as unknown as { deps: { readAccepting?: () => Promise<boolean> } }).deps.readAccepting = async () => accepting;
    const refused = await post(app, { ...good, key: 'after' });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ error: 'delegation_disabled', reason: 'not_accepting' });

    // Reads and the in-flight delegation are unaffected while not accepting.
    expect((await app.request(`/api/delegations/${id}`)).status).toBe(200);
    expect((await app.request('/api/delegations')).status).toBe(200);
    for (let i = 0; i < 100; i++) {
      const rec = ((await (await app.request(`/api/delegations/${id}`)).json()) as { delegation: { state: string } }).delegation;
      if (rec.state === 'completed') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(((await (await app.request(`/api/delegations/${id}`)).json()) as { delegation: { state: string } }).delegation.state).toBe('completed');

    accepting = true;
    expect((await post(app, { ...good, key: 'resumed' })).status).toBe(202);
  });

  test('a corrupt store reports reason store_corrupt (not the internal store error code)', async () => {
    writeFileSync(join(dir, 'delegations.json'), '{not json');
    const svc = await makeService();
    expect(svc.disabledInfo).toBeDefined();
    const res = await post(appWith(svc), good);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'delegation_disabled', reason: 'store_corrupt', file: join(dir, 'delegations.json') });
  });

  test('GET /api/delegations?active=1 keeps only non-terminal delegations', async () => {
    const svc = await makeService();
    const app = appWith(svc);
    const done = ((await (await post(app, { ...good, key: 'done' })).json()) as { delegation: { id: string } }).delegation.id;
    for (let i = 0; i < 100; i++) {
      const rec = ((await (await app.request(`/api/delegations/${done}`)).json()) as { delegation: { state: string } }).delegation;
      if (rec.state === 'completed') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    server.plan = () => ({ kind: 'reply', text: VERDICT, delayMs: 400 });
    const running = ((await (await post(app, { ...good, key: 'running' })).json()) as { delegation: { id: string } }).delegation.id;
    const all = ((await (await app.request('/api/delegations')).json()) as { delegations: { id: string }[] }).delegations.map((d) => d.id);
    const active = ((await (await app.request('/api/delegations?active=1')).json()) as { delegations: { id: string }[] }).delegations.map((d) => d.id);
    expect(all).toEqual(expect.arrayContaining([done, running]));
    expect(active).toEqual([running]);
  });

  test('an unreadable accepting switch keeps the last known value (a broken config cannot silently re-open submissions)', async () => {
    const svc = await makeService();
    let mode: 'false' | 'throw' = 'false';
    (svc as unknown as { deps: { readAccepting?: () => Promise<boolean> } }).deps.readAccepting = async () => {
      if (mode === 'throw') throw new Error('config unreadable');
      return false;
    };
    expect(await svc.isAccepting()).toBe(false);
    mode = 'throw';
    expect(await svc.isAccepting()).toBe(false);
  });

  test('registers exactly the three slice-1a routes (no cancel, no workers)', async () => {
    const routes = appWith(await makeService()).routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(routes).toEqual(['GET /api/delegations', 'GET /api/delegations/:id', 'POST /api/delegations']);
  });

  test('POST returns 202 with the dispatching record; GET shows it complete later', async () => {
    const svc = await makeService();
    const app = appWith(svc);
    const res = await post(app, { ...good, parentTaskId: 'task-9', key: 'k1' });
    expect(res.status).toBe(202);
    const { delegation } = await res.json();
    expect(delegation).toMatchObject({
      kind: 'triage', projectId: 'proj', issueRef: 12, parentTaskId: 'task-9', key: 'k1',
      state: 'dispatching', workerId: 'w1', baseSha: SHA, promptVersion: 'triage-v1',
    });
    expect(delegation.id).toEqual(expect.any(String));
    await svc.drain();
    const got = await app.request(`/api/delegations/${delegation.id}`);
    expect(got.status).toBe(200);
    const body = await got.json();
    expect(body.delegation).toMatchObject({ id: delegation.id, state: 'completed', result: { untrusted: true, verdict: { type: 'chore' } } });
  });

  test('a repeated request with the same key returns 200 with idempotentReplay', async () => {
    server.plan = () => ({ kind: 'hang' });
    const app = appWith(await makeService());
    const first = await (await post(app, { ...good, key: 'same' })).json();
    const again = await post(app, { ...good, key: 'same' });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ idempotentReplay: true, delegation: { id: first.delegation.id } });
    const conflict = await post(app, { ...good, issueRef: 99, key: 'same' });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: 'idempotency_conflict' });
  });

  test.each([
    [{ ...good, kind: 'bogus' }, 400, 'invalid_request'],
    [{ ...good, projectId: 'ghost' }, 404, 'unknown_project'],
    [{ kind: 'triage', projectId: 'proj' }, 400, 'invalid_request'],
    [{ kind: 'test_audit', projectId: 'proj' }, 501, 'not_implemented'],
    ['{not json', 400, 'invalid_request'],
    ['[]', 400, 'invalid_request'],
  ])('validation: %j -> %i %s', async (payload, status, code) => {
    const res = await post(appWith(await makeService()), payload);
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ error: code, message: expect.any(String) });
  });

  test('body over 4 KB -> 413', async () => {
    const res = await post(appWith(await makeService()), { ...good, key: 'k', junk: 'x'.repeat(5000) });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'body_too_large' });
  });

  test('pool_busy -> 429 with Retry-After and a typed body', async () => {
    server.plan = () => ({ kind: 'hang' });
    const app = appWith(await makeService({ maxInFlight: 1 }));
    expect((await post(app, { ...good, key: 'a' })).status).toBe(202);
    const res = await post(app, { ...good, key: 'b' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(await res.json()).toMatchObject({ error: 'pool_busy', retryAfterSec: 30 });
  });

  test('rate limit: the 31st submission inside a minute -> 429 rate_limited', async () => {
    let t = 1_000;
    const app = appWith(await makeService(), () => t);
    for (let i = 0; i < 30; i++) expect((await post(app, '{bad')).status).toBe(400);
    const limited = await post(app, '{bad');
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: 'rate_limited' });
    t += 61_000;
    expect((await post(app, '{bad')).status).toBe(400);
  });

  test('GET unknown id -> 404; list filters by parent, newest first', async () => {
    server.plan = () => ({ kind: 'hang' });
    const app = appWith(await makeService({ maxInFlight: 5 }));
    expect((await app.request('/api/delegations/nope')).status).toBe(404);
    const a = (await (await post(app, { ...good, parentTaskId: 'p1', key: 'a' })).json()).delegation;
    await new Promise((r) => setTimeout(r, 5));
    const b = (await (await post(app, { ...good, parentTaskId: 'p1', key: 'b' })).json()).delegation;
    await post(app, { ...good, parentTaskId: 'p2', key: 'c' });
    const listed = await (await app.request('/api/delegations?parent=p1')).json();
    expect(listed.delegations.map((d: { id: string }) => d.id)).toEqual([b.id, a.id]);
    const all = await (await app.request('/api/delegations')).json();
    expect(all.delegations).toHaveLength(3);
  });

  test('a corrupt store registers the routes but every one answers a typed delegation_disabled naming the file', async () => {
    const file = join(dir, 'delegations.json');
    writeFileSync(file, 'garbage');
    const svc = await makeService();
    const app = appWith(svc);
    for (const res of [await post(app, good), await app.request('/api/delegations/x'), await app.request('/api/delegations')]) {
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: 'delegation_disabled', file, missing: expect.any(Array) });
    }
  });

  test('secrets never appear in responses or logs (token, token file path, worker URL)', async () => {
    server.plan = () => ({ kind: 'reply', state: 'failed', text: 'worker said hi' });
    const svc = await makeService();
    const app = appWith(svc);
    const responses: string[] = [];
    const created = await post(app, good);
    responses.push(await created.text());
    await svc.drain();
    const id = svc.list()[0]!.id;
    responses.push(await (await app.request(`/api/delegations/${id}`)).text());
    responses.push(await (await app.request('/api/delegations')).text());
    responses.push(await (await post(app, { ...good, projectId: 'ghost' })).text());
    const everything = [...responses, ...logs].join('\n');
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(join(dir, 'tok'));
    expect(everything).not.toContain(server.url);
    expect(everything).not.toMatch(/Bearer/i);
  });

  test('unrelated paths are untouched', async () => {
    const app = appWith(await makeService());
    expect((await app.request('/api/delegations/a/b')).status).toBe(404);
    expect((await app.request('/api/delegations', { method: 'DELETE' })).status).toBe(404);
  });
});

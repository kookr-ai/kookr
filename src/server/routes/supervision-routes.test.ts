import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { registerSupervisionRoutes } from './supervision-routes.js';
import type { SupervisionStatus } from '../supervision-service.js';

const row = { supervisionId: 'sup-1', health: 'healthy', wakesEnabled: true } as unknown as SupervisionStatus;

type Svc = { list: () => SupervisionStatus[]; get: (id: string) => SupervisionStatus | undefined; end: (id: string) => Promise<SupervisionStatus | undefined> };

function app(service?: Svc): Hono {
  const a = new Hono();
  registerSupervisionRoutes(a, { supervisionService: service });
  return a;
}

describe('supervision routes', () => {
  it('GET /api/supervisions lists supervisions', async () => {
    const res = await app({ list: () => [row], get: () => undefined, end: async () => undefined }).request('/api/supervisions');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ supervisions: [row] });
  });

  it('GET /api/supervisions is empty without a service', async () => {
    const res = await app().request('/api/supervisions');
    expect(await res.json()).toEqual({ supervisions: [] });
  });

  it('GET /api/supervisions/:id returns one, 404 otherwise', async () => {
    const a = app({ list: () => [row], get: (id) => (id === 'sup-1' ? row : undefined), end: async () => undefined });
    const ok = await a.request('/api/supervisions/sup-1');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(row);
    const missing = await a.request('/api/supervisions/nope');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Supervision not found: nope' });
    expect((await app().request('/api/supervisions/sup-1')).status).toBe(404);
  });

  it('POST /api/supervisions/:id/end ends via the service; 404 for an unknown id or no service', async () => {
    const ended: string[] = [];
    const a = app({
      list: () => [],
      get: () => undefined,
      end: async (id) => { ended.push(id); return id === 'sup-1' ? ({ ...row, health: 'ended' } as SupervisionStatus) : undefined; },
    });
    const ok = await a.request('/api/supervisions/sup-1/end', { method: 'POST' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, supervision: { ...row, health: 'ended' } });
    expect((await a.request('/api/supervisions/nope/end', { method: 'POST' })).status).toBe(404);
    expect(ended).toEqual(['sup-1', 'nope']);
    expect((await app().request('/api/supervisions/sup-1/end', { method: 'POST' })).status).toBe(404);
  });
});

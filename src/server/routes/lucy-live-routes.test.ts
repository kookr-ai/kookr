import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { LUCY_LIVE_STATUS_PATH } from '../../shared/contracts/lucy-live.js';
import { registerLucyLiveRoutes } from './lucy-live-routes.js';

async function get(deps: Parameters<typeof registerLucyLiveRoutes>[1]) {
  const app = new Hono();
  registerLucyLiveRoutes(app, deps);
  const res = await app.request(LUCY_LIVE_STATUS_PATH);
  return { status: res.status, body: await res.json() };
}

describe('GET /api/lucy-live/status', () => {
  it('reports available', async () => {
    expect(await get({ lucyLiveStatus: { available: true } })).toEqual({ status: 200, body: { available: true } });
  });
  it('reports why it is unavailable', async () => {
    const r = await get({ lucyLiveStatus: { available: false, reason: 'needs ears' } });
    expect(r.body).toEqual({ available: false, reason: 'needs ears' });
  });
  it('reports starting (not just unavailable) while the managed recogniser comes up', async () => {
    const r = await get({ getLucyLiveStatus: () => ({ available: false, starting: true, reason: 'ears starting' }) });
    expect(r.body).toEqual({ available: false, starting: true, reason: 'ears starting' });
  });
  it('reads the live status on every request', async () => {
    let status: Parameters<typeof registerLucyLiveRoutes>[1]['lucyLiveStatus'] = { available: false, starting: true, reason: 'x' };
    const app = new Hono();
    registerLucyLiveRoutes(app, { getLucyLiveStatus: () => status! });
    expect(await (await app.request(LUCY_LIVE_STATUS_PATH)).json()).toMatchObject({ starting: true });
    status = { available: true };
    expect(await (await app.request(LUCY_LIVE_STATUS_PATH)).json()).toEqual({ available: true });
  });
  it('is unavailable when nothing was wired', async () => {
    const r = await get({});
    expect(r.body).toMatchObject({ available: false });
  });
});

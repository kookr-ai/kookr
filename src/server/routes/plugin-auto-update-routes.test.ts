import { describe, it, expect, afterEach } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerPluginAutoUpdateRoutes } from './plugin-auto-update-routes.js';
import { AutoUpdateStore } from '../plugin-manager/auto-update-store.js';
import type { TaskStore } from '../../core/tasks.js';
import type { AutoUpdateActionResult, AutoUpdateSurface } from '../../shared/contracts/plugins.js';

describe('plugin auto-update routes', () => {
  let dir: string;
  let home: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  function makeApp(): { app: Hono; dir: string } {
    dir = mkdtempSync(join(tmpdir(), 'plugin-au-routes-'));
    home = mkdtempSync(join(tmpdir(), 'plugin-au-home-'));
    mkdirSync(join(home, '.claude'), { recursive: true });
    const taskStore = { viewLiveTasks: () => [] } as unknown as TaskStore;
    const app = new Hono();
    registerPluginAutoUpdateRoutes(app, {
      taskStore,
      kookrDir: dir,
      serverCwd: dir,
      serverPort: 0,
      hookHomeDir: home,
    });
    return { app, dir };
  }

  it('PUT sets a policy and persists it; GET surface reflects it', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/plugins/stripe@mkt/auto-update', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ policy: 'apply-when-idle' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AutoUpdateActionResult;
    expect(body.plugin.policy).toBe('apply-when-idle');

    expect(await new AutoUpdateStore(dir).getPolicy('stripe@mkt')).toBe('apply-when-idle');

    const surface = (await app.request('/api/plugins/auto-update').then((r) => r.json())) as AutoUpdateSurface;
    expect(surface.applyEnabled).toBe(false); // default-off env gate
    expect(surface.plugins.find((p) => p.pluginId === 'stripe@mkt')?.policy).toBe('apply-when-idle');
  });

  it('rejects an invalid plugin id', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/plugins/noat/auto-update', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ policy: 'off' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid policy value', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/plugins/a@m/auto-update', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ policy: 'sometimes' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid JSON body', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/plugins/a@m/auto-update', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('dismiss-banner returns ok for a plugin with no banner', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/plugins/a@m/auto-update/dismiss-banner', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AutoUpdateActionResult;
    expect(body.plugin.banner).toBeNull();
  });

  it('evaluate returns 200 with the plugin view (degrades gracefully with no claude binary)', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/plugins/stripe@mkt/auto-update/evaluate', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AutoUpdateActionResult;
    expect(body.plugin.pluginId).toBe('stripe@mkt');
  });

  it('rollback with no retained snapshot returns 200 with the plugin view', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/plugins/stripe@mkt/auto-update/rollback', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AutoUpdateActionResult;
    expect(body.plugin.rollbackAvailable).toBe(false);
  });

  it('evaluate rejects an invalid plugin id', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/plugins/noat/auto-update/evaluate', { method: 'POST' });
    expect(res.status).toBe(400);
  });
});

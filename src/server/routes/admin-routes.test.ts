import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { TaskStore } from '../../core/tasks.js';
import { DrainController } from '../drain-state.js';
import { registerAdminRoutes, isAuthorizedAdminRequest } from './admin-routes.js';
import type { RouteDeps } from './shared.js';

function mkApp(deps: Partial<RouteDeps>): Hono {
  const app = new Hono();
  registerAdminRoutes(app, deps as unknown as RouteDeps);
  return app;
}

describe('isAuthorizedAdminRequest', () => {
  afterEach(() => {
    delete process.env.KOOKR_ADMIN_TOKEN;
  });

  test('trusts loopback addresses with no token configured', () => {
    expect(isAuthorizedAdminRequest('127.0.0.1', undefined)).toBe(true);
    expect(isAuthorizedAdminRequest('::1', undefined)).toBe(true);
    expect(isAuthorizedAdminRequest('::ffff:127.0.0.1', undefined)).toBe(true);
  });

  test('rejects non-loopback addresses with no token configured', () => {
    expect(isAuthorizedAdminRequest('10.0.0.5', undefined)).toBe(false);
    expect(isAuthorizedAdminRequest(undefined, undefined)).toBe(false);
  });

  test('authorizes a matching configured token from any address', () => {
    process.env.KOOKR_ADMIN_TOKEN = 'secret';
    expect(isAuthorizedAdminRequest('10.0.0.5', 'secret')).toBe(true);
  });

  test('rejects a wrong token from a non-loopback address', () => {
    process.env.KOOKR_ADMIN_TOKEN = 'secret';
    expect(isAuthorizedAdminRequest('10.0.0.5', 'nope')).toBe(false);
  });
});

describe('admin drain routes', () => {
  let drainController: DrainController;
  let taskStore: TaskStore;
  let deps: Partial<RouteDeps>;

  beforeEach(() => {
    drainController = new DrainController();
    taskStore = new TaskStore();
    deps = { drainController, taskStore };
    delete process.env.KOOKR_ADMIN_TOKEN;
  });

  afterEach(() => {
    delete process.env.KOOKR_ADMIN_TOKEN;
  });

  test('does not register routes when no drainController is wired', async () => {
    const res = await mkApp({ taskStore }).request('http://example.com/api/admin/drain', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  test('rejects unauthenticated (non-loopback, no token) requests with 403', async () => {
    // app.request() carries no socket, so getConnInfo yields no remote address —
    // exercises the non-loopback path. No token configured ⇒ forbidden.
    const res = await mkApp(deps).request('http://example.com/api/admin/drain', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'admin-forbidden' });
    expect(drainController.isAccepting()).toBe(true); // state unchanged by a rejected call
  });

  test('drain then resume flips the controller and reports running task count', async () => {
    process.env.KOOKR_ADMIN_TOKEN = 'secret';
    const headers = { 'x-kookr-admin-token': 'secret' };

    const drainRes = await mkApp(deps).request('http://example.com/api/admin/drain', { method: 'POST', headers });
    expect(drainRes.status).toBe(200);
    const drainBody = await drainRes.json();
    expect(drainBody).toMatchObject({ accepting: false, draining: true, changed: true, runningTasks: 0 });
    expect(typeof drainBody.since).toBe('string');
    expect(drainController.isAccepting()).toBe(false);

    const resumeRes = await mkApp(deps).request('http://example.com/api/admin/resume', { method: 'POST', headers });
    expect(resumeRes.status).toBe(200);
    expect(await resumeRes.json()).toMatchObject({ accepting: true, draining: false, changed: true });
    expect(drainController.isAccepting()).toBe(true);
  });

  test('repeated drain reports changed:false (idempotent)', async () => {
    process.env.KOOKR_ADMIN_TOKEN = 'secret';
    const headers = { 'x-kookr-admin-token': 'secret' };
    await mkApp(deps).request('http://example.com/api/admin/drain', { method: 'POST', headers });
    const second = await mkApp(deps).request('http://example.com/api/admin/drain', { method: 'POST', headers });
    expect((await second.json()).changed).toBe(false);
  });

  test('GET reports current state without mutating it', async () => {
    process.env.KOOKR_ADMIN_TOKEN = 'secret';
    const headers = { 'x-kookr-admin-token': 'secret' };
    const res = await mkApp(deps).request('http://example.com/api/admin/drain', { method: 'GET', headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepting: true, draining: false, runningTasks: 0 });
    expect(drainController.isAccepting()).toBe(true);
  });
});

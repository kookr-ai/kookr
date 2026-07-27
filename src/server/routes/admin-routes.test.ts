import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { TaskStore } from '../../core/tasks.js';
import { DrainController } from '../drain-state.js';
import { registerAdminRoutes, isAuthorizedAdminRequest } from './admin-routes.js';
import { getLogLevel, resetLogLevel } from '../runtime-log-level.js';
import {
  getOperationalAlertConfig,
  resetOperationalAlertConfig,
} from '../operational-alert-config.js';
import {
  DEFAULT_OPERATIONAL_ALERT_CIRCUIT_BREAKER_OPEN_MS,
  DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_BYTES,
  DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_PERCENT,
  DEFAULT_OPERATIONAL_ALERT_PROCESS_RSS_BYTES,
} from '../config.js';
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

describe('admin operational-alert history route (issue #1256)', () => {
  const headers = { 'x-kookr-admin-token': 'secret' };

  const get = (app: Hono, authorized = true) =>
    app.request('http://example.com/api/admin/operational-alerts', {
      method: 'GET',
      headers: authorized ? headers : {},
    });

  beforeEach(() => {
    process.env.KOOKR_ADMIN_TOKEN = 'secret';
  });

  afterEach(() => {
    delete process.env.KOOKR_ADMIN_TOKEN;
  });

  test('returns the retained operational alert history', async () => {
    const res = await get(mkApp({
      getOperationalAlertHistory: () => ({
        generatedAt: '2026-05-13T00:02:00.000Z',
        limit: 100,
        alerts: [{
          id: 1,
          key: 'resource:cpu',
          metric: 'cpu',
          firstFiredAt: '2026-05-13T00:00:00.000Z',
          lastFiredAt: '2026-05-13T00:00:00.000Z',
          recoveredAt: '2026-05-13T00:01:00.000Z',
          active: false,
          fireCount: 1,
          alert: {
            type: 'alert',
            agentId: 'system',
            summary: 'High host CPU usage',
            details: 'sustained',
            severity: 'warning',
            operationalAlert: { key: 'resource:cpu', metric: 'cpu', state: 'fired' },
          },
          recoveryAlert: {
            type: 'alert',
            agentId: 'system',
            summary: 'Recovered host CPU usage',
            details: 'cleared',
            severity: 'info',
            operationalAlert: { key: 'resource:cpu', metric: 'cpu', state: 'recovered' },
          },
        }],
      }),
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      generatedAt: '2026-05-13T00:02:00.000Z',
      limit: 100,
      alerts: [{
        id: 1,
        key: 'resource:cpu',
        metric: 'cpu',
        firstFiredAt: '2026-05-13T00:00:00.000Z',
        lastFiredAt: '2026-05-13T00:00:00.000Z',
        recoveredAt: '2026-05-13T00:01:00.000Z',
        active: false,
        fireCount: 1,
        alert: {
          type: 'alert',
          agentId: 'system',
          summary: 'High host CPU usage',
          details: 'sustained',
          severity: 'warning',
          operationalAlert: { key: 'resource:cpu', metric: 'cpu', state: 'fired' },
        },
        recoveryAlert: {
          type: 'alert',
          agentId: 'system',
          summary: 'Recovered host CPU usage',
          details: 'cleared',
          severity: 'info',
          operationalAlert: { key: 'resource:cpu', metric: 'cpu', state: 'recovered' },
        },
      }],
    });
  });

  test('GET requires authorization', async () => {
    const res = await get(mkApp({ getOperationalAlertHistory: () => ({ generatedAt: 'now', limit: 100, alerts: [] }) }), false);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'admin-forbidden' });
  });
});

describe('admin operational-alert-config routes (issue #737)', () => {
  const headers = { 'x-kookr-admin-token': 'secret' };

  const post = (app: Hono, body: unknown, authorized = true) =>
    app.request('http://example.com/api/admin/operational-alert-config', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(authorized ? headers : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const get = (app: Hono, authorized = true) =>
    app.request('http://example.com/api/admin/operational-alert-config', {
      method: 'GET',
      headers: authorized ? headers : {},
    });

  beforeEach(() => {
    process.env.KOOKR_ADMIN_TOKEN = 'secret';
    resetOperationalAlertConfig({
      KOOKR_ALERT_CPU_PERCENT: '70',
      KOOKR_ALERT_SUSTAIN_SAMPLES: '3',
    });
  });

  afterEach(() => {
    delete process.env.KOOKR_ADMIN_TOKEN;
    resetOperationalAlertConfig({});
  });

  test('registers even when no drainController is wired', async () => {
    const res = await get(mkApp({ taskStore: new TaskStore() }));
    expect(res.status).toBe(200);
  });

  test('GET returns current config and boot defaults', async () => {
    const res = await get(mkApp({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      config: {
        cpuPercent: 70,
        memoryPercent: 0,
        eventLoopDelayMs: 0,
        processRssBytes: DEFAULT_OPERATIONAL_ALERT_PROCESS_RSS_BYTES,
        dataDirectoryFreePercent: DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_PERCENT,
        dataDirectoryFreeBytes: DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_BYTES,
        circuitBreakerOpenMs: DEFAULT_OPERATIONAL_ALERT_CIRCUIT_BREAKER_OPEN_MS,
        sustainSamples: 3,
      },
      default: {
        cpuPercent: 70,
        memoryPercent: 0,
        eventLoopDelayMs: 0,
        processRssBytes: DEFAULT_OPERATIONAL_ALERT_PROCESS_RSS_BYTES,
        dataDirectoryFreePercent: DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_PERCENT,
        dataDirectoryFreeBytes: DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_BYTES,
        circuitBreakerOpenMs: DEFAULT_OPERATIONAL_ALERT_CIRCUIT_BREAKER_OPEN_MS,
        sustainSamples: 3,
      },
    });
  });

  test('GET requires authorization', async () => {
    const res = await get(mkApp({}), false);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'admin-forbidden' });
  });

  test('POST applies a valid partial update process-wide', async () => {
    const res = await post(mkApp({}), { memoryPercent: 88, dataDirectoryFreeBytes: 1_000, sustainSamples: 2 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      config: {
        cpuPercent: 70,
        memoryPercent: 88,
        eventLoopDelayMs: 0,
        processRssBytes: DEFAULT_OPERATIONAL_ALERT_PROCESS_RSS_BYTES,
        dataDirectoryFreePercent: DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_PERCENT,
        dataDirectoryFreeBytes: 1_000,
        circuitBreakerOpenMs: DEFAULT_OPERATIONAL_ALERT_CIRCUIT_BREAKER_OPEN_MS,
        sustainSamples: 2,
      },
      default: {
        cpuPercent: 70,
        memoryPercent: 0,
        eventLoopDelayMs: 0,
        processRssBytes: DEFAULT_OPERATIONAL_ALERT_PROCESS_RSS_BYTES,
        dataDirectoryFreePercent: DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_PERCENT,
        dataDirectoryFreeBytes: DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_BYTES,
        circuitBreakerOpenMs: DEFAULT_OPERATIONAL_ALERT_CIRCUIT_BREAKER_OPEN_MS,
        sustainSamples: 3,
      },
    });
    expect(getOperationalAlertConfig()).toEqual({
      cpuPercent: 70,
      memoryPercent: 88,
      eventLoopDelayMs: 0,
      processRssBytes: DEFAULT_OPERATIONAL_ALERT_PROCESS_RSS_BYTES,
      dataDirectoryFreePercent: DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_PERCENT,
      dataDirectoryFreeBytes: 1_000,
      circuitBreakerOpenMs: DEFAULT_OPERATIONAL_ALERT_CIRCUIT_BREAKER_OPEN_MS,
      sustainSamples: 2,
    });
  });

  test('POST requires authorization and does not mutate state when rejected', async () => {
    const res = await post(mkApp({}), { cpuPercent: 95 }, false);
    expect(res.status).toBe(403);
    expect(getOperationalAlertConfig().cpuPercent).toBe(70);
  });

  test('POST rejects an invalid update without mutating state', async () => {
    const res = await post(mkApp({}), { cpuPercent: 95, sustainSamples: 0 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'invalid-sustain-samples',
      field: 'sustainSamples',
      validFields: [
        'cpuPercent',
        'memoryPercent',
        'eventLoopDelayMs',
        'processRssBytes',
        'dataDirectoryFreePercent',
        'dataDirectoryFreeBytes',
        'circuitBreakerOpenMs',
        'sustainSamples',
      ],
    });
    expect(getOperationalAlertConfig()).toEqual({
      cpuPercent: 70,
      memoryPercent: 0,
      eventLoopDelayMs: 0,
      processRssBytes: DEFAULT_OPERATIONAL_ALERT_PROCESS_RSS_BYTES,
      dataDirectoryFreePercent: DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_PERCENT,
      dataDirectoryFreeBytes: DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_BYTES,
      circuitBreakerOpenMs: DEFAULT_OPERATIONAL_ALERT_CIRCUIT_BREAKER_OPEN_MS,
      sustainSamples: 3,
    });
  });

  test('POST rejects malformed JSON with 400', async () => {
    const res = await post(mkApp({}), 'not json');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid-json' });
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

  test('broadcasts a drain-status snapshot when drain state changes', async () => {
    process.env.KOOKR_ADMIN_TOKEN = 'secret';
    const headers = { 'x-kookr-admin-token': 'secret' };
    const broadcastToAll = vi.fn();
    const monitor = {
      getSnapshot: () => [{ agentId: 'session-1', taskId: 'task-1', events: [], anomaly: null }],
    };
    const terminalInputCoordinator = {
      getSnapshot: vi.fn(() => ({
        sessionId: 'session-1',
        inputStateEpoch: 'epoch-1',
        readinessVersion: 1,
        prompt: { kind: 'ready' },
      })),
    };
    const userInputDeliveries = {
      getSnapshot: vi.fn(() => [{
        deliveryId: 'delivery-1',
        sessionId: 'session-1',
        deliverySeq: 1,
        source: 'respond',
        text: 'continue',
        status: 'queued',
        createdAt: '2026-06-13T10:00:00.000Z',
        updatedAt: '2026-06-13T10:00:00.000Z',
      }]),
    };
    const app = mkApp({
      ...deps,
      monitor,
      serverCwd: '/repo',
      broadcastToAll,
      terminalInputCoordinator,
      userInputDeliveries,
    } as Partial<RouteDeps>);

    await app.request('http://example.com/api/admin/drain', { method: 'POST', headers });
    await app.request('http://example.com/api/admin/drain', { method: 'POST', headers });
    await app.request('http://example.com/api/admin/resume', { method: 'POST', headers });

    expect(broadcastToAll).toHaveBeenCalledTimes(2);
    expect(broadcastToAll.mock.calls[0][0]).toMatchObject({
      type: 'snapshot',
      serverCwd: '/repo',
      drainStatus: { accepting: false, draining: true },
      agents: [{
        agentId: 'session-1',
        terminalInputSnapshot: {
          sessionId: 'session-1',
          taskId: 'task-1',
          inputStateEpoch: 'epoch-1',
          readinessVersion: 1,
          promptReady: true,
        },
        userInputDeliveries: [{
          deliveryId: 'delivery-1',
          status: 'queued',
          text: 'continue',
        }],
      }],
    });
    expect(broadcastToAll.mock.calls[1][0]).toMatchObject({
      type: 'snapshot',
      serverCwd: '/repo',
      drainStatus: { accepting: true, draining: false },
    });
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

describe('admin log-level routes (issue #662)', () => {
  const headers = { 'x-kookr-admin-token': 'secret' };

  // app.request() carries no socket, so production-shaped requests look
  // non-loopback; configure a token to authorize them in these tests.
  const post = (app: Hono, body: unknown, authorized = true) =>
    app.request('http://example.com/api/admin/log-level', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(authorized ? headers : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const get = (app: Hono, authorized = true) =>
    app.request('http://example.com/api/admin/log-level', {
      method: 'GET',
      headers: authorized ? headers : {},
    });

  beforeEach(() => {
    delete process.env.KOOKR_DEBUG;
    process.env.KOOKR_ADMIN_TOKEN = 'secret';
    resetLogLevel();
  });

  afterEach(() => {
    delete process.env.KOOKR_ADMIN_TOKEN;
    delete process.env.KOOKR_DEBUG;
    vi.useRealTimers();
    resetLogLevel();
  });

  test('registers even when no drainController is wired', async () => {
    const res = await get(mkApp({ taskStore: new TaskStore() }));
    expect(res.status).toBe(200);
  });

  test('GET returns the current level seeded to info by default', async () => {
    const res = await get(mkApp({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ level: 'info', default: 'info', ttlExpiresAt: null });
  });

  test('GET default is seeded from KOOKR_DEBUG', async () => {
    process.env.KOOKR_DEBUG = 'true';
    resetLogLevel();
    expect(await (await get(mkApp({}))).json()).toEqual({
      level: 'debug',
      default: 'debug',
      ttlExpiresAt: null,
    });
  });

  test('GET requires authorization', async () => {
    const res = await get(mkApp({}), false);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'admin-forbidden' });
  });

  test('POST sets the level and the change is observable process-wide', async () => {
    const res = await post(mkApp({}), { level: 'debug' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ level: 'debug', default: 'info', ttlExpiresAt: null });
    expect(getLogLevel()).toBe('debug');
  });

  test('POST requires authorization and does not mutate state when rejected', async () => {
    const res = await post(mkApp({}), { level: 'debug' }, false);
    expect(res.status).toBe(403);
    expect(getLogLevel()).toBe('info');
  });

  test('POST rejects an invalid level with 400 and lists valid levels', async () => {
    const res = await post(mkApp({}), { level: 'verbose' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'invalid-level',
      validLevels: ['error', 'warn', 'info', 'debug'],
    });
    expect(getLogLevel()).toBe('info');
  });

  test('POST rejects a non-positive ttl with 400', async () => {
    const res = await post(mkApp({}), { level: 'debug', ttlSeconds: 0 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid-ttl');
    expect(getLogLevel()).toBe('info');
  });

  test('POST rejects a malformed JSON body with 400', async () => {
    const res = await post(mkApp({}), 'not json');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid-json' });
  });

  test('POST with a ttl auto-reverts to the default after it elapses', async () => {
    vi.useFakeTimers();
    const res = await post(mkApp({}), { level: 'debug', ttlSeconds: 60 });
    const body = await res.json();
    expect(body.level).toBe('debug');
    expect(typeof body.ttlExpiresAt).toBe('string');
    expect(getLogLevel()).toBe('debug');

    vi.advanceTimersByTime(60_000);
    expect(getLogLevel()).toBe('info');

    const after = await (await get(mkApp({}))).json();
    expect(after).toEqual({ level: 'info', default: 'info', ttlExpiresAt: null });
  });

  // Infinity/NaN aren't representable in a JSON body (they serialize to null,
  // which means "no ttl"), so the non-finite branch is exercised directly in
  // runtime-log-level.test.ts. Here we cover the values a client can actually send.
  test('rejects a negative, string, or sub-second ttl with 400', async () => {
    for (const ttlSeconds of [-5, 'abc', 0.5]) {
      const res = await post(mkApp({}), { level: 'debug', ttlSeconds });
      expect(res.status, `ttl=${String(ttlSeconds)}`).toBe(400);
      expect((await res.json()).error).toBe('invalid-ttl');
      expect(getLogLevel()).toBe('info');
    }
  });
});

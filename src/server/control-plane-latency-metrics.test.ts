import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import {
  CONTROL_PLANE_LATENCIES_ROUTE,
  ControlPlaneLatencyMetrics,
  isControlPlaneLatencyRoute,
} from './control-plane-latency-metrics.js';
import { createRequestDurationMiddleware, RequestDurationMetrics } from './request-duration-metrics.js';

describe('ControlPlaneLatencyMetrics', () => {
  test('tracks percentiles, error counts, and slow counts from bounded samples', () => {
    const metrics = new ControlPlaneLatencyMetrics({ maxSamplesPerRoute: 4, slowThresholdMs: 50 });

    metrics.record({ method: 'get', route: '/api/health', durationMs: 1, status: 200 });
    metrics.record({ method: 'GET', route: '/api/health', durationMs: 2, status: 200 });
    metrics.record({ method: 'GET', route: '/api/health', durationMs: 3, status: 503 });
    metrics.record({ method: 'GET', route: '/api/health', durationMs: 4, status: 200 });
    metrics.record({ method: 'GET', route: '/api/health', durationMs: 100, status: 200 });

    expect(metrics.snapshot()).toEqual({
      schemaVersion: 'control-plane-latency-metrics.v1',
      maxRoutes: 16,
      maxSamplesPerRoute: 4,
      slowThresholdMs: 50,
      routeCount: 1,
      droppedRouteCount: 0,
      routes: [{
        method: 'GET',
        route: '/api/health',
        count: 5,
        sampleCount: 4,
        errorCount: 1,
        slowCount: 1,
        p50Ms: 3,
        p95Ms: 100,
        p99Ms: 100,
      }],
    });
  });

  test('counts a duration exactly at the slow threshold as slow (inclusive bound)', () => {
    const metrics = new ControlPlaneLatencyMetrics({ slowThresholdMs: 50 });
    metrics.record({ method: 'GET', route: '/api/health', durationMs: 49, status: 200 });
    metrics.record({ method: 'GET', route: '/api/health', durationMs: 50, status: 200 });
    expect(metrics.snapshot().routes[0]).toMatchObject({ count: 2, slowCount: 1 });
  });

  test('ignores negative and non-finite durations', () => {
    const metrics = new ControlPlaneLatencyMetrics();
    metrics.record({ method: 'GET', route: '/api/ready', durationMs: -1, status: 200 });
    metrics.record({ method: 'GET', route: '/api/ready', durationMs: Number.NaN, status: 200 });
    expect(metrics.snapshot().routeCount).toBe(0);
  });

  test('bounds route cardinality and reports dropped new routes', () => {
    const metrics = new ControlPlaneLatencyMetrics({ maxRoutes: 1 });
    metrics.record({ method: 'GET', route: '/api/health', durationMs: 1, status: 200 });
    metrics.record({ method: 'GET', route: '/api/ready', durationMs: 2, status: 200 });
    metrics.record({ method: 'GET', route: '/api/health/tts', durationMs: 3, status: 200 });

    const snapshot = metrics.snapshot();
    expect(snapshot.routeCount).toBe(1);
    expect(snapshot.droppedRouteCount).toBe(2);
    expect(snapshot.routes).toEqual([expect.objectContaining({ route: '/api/health', count: 1 })]);
  });

  test('classifies control-plane routes but not the general API surface', () => {
    expect(isControlPlaneLatencyRoute('/api/health')).toBe(true);
    expect(isControlPlaneLatencyRoute('/api/health/tts')).toBe(true);
    expect(isControlPlaneLatencyRoute('/api/ready')).toBe(true);
    expect(isControlPlaneLatencyRoute('/api/tasks/:id')).toBe(false);
    expect(isControlPlaneLatencyRoute('/api/healthz')).toBe(false);
  });
});

describe('createRequestDurationMiddleware control-plane recording', () => {
  test('records probe routes into control-plane metrics, not the request histogram', async () => {
    const times = [10, 15, 20, 5030, 40, 41];
    // The middleware times the probe off the request-metrics clock and passes
    // the measured durationMs into the control-plane metrics, which keep no
    // clock of their own — so only requestMetrics needs the injected `now`.
    const requestMetrics = new RequestDurationMetrics({ nowMs: () => times.shift() ?? 50 });
    const controlPlaneMetrics = new ControlPlaneLatencyMetrics({ slowThresholdMs: 5000 });
    const app = new Hono();

    app.use('*', createRequestDurationMiddleware(requestMetrics, controlPlaneMetrics));
    app.get('/api/tasks/:taskId', (c) => c.json({ id: c.req.param('taskId') }));
    app.get('/api/health', (c) => c.json({ status: 'ok' }));
    app.get('/api/ready', (c) => c.json({ ready: false }, 503));
    app.get(CONTROL_PLANE_LATENCIES_ROUTE, (c) => c.json(controlPlaneMetrics.snapshot()));

    await app.request('/api/tasks/alpha'); // 10 -> 15: request histogram only
    await app.request('/api/health'); // 20 -> 5030: slow probe
    await app.request('/api/ready'); // 40 -> 41: error (503)

    // The general request histogram excludes both control-plane probes.
    const requestSnapshot = requestMetrics.snapshot();
    expect(requestSnapshot.routes.map((r) => r.route)).toEqual(['/api/tasks/:taskId']);

    const res = await app.request(CONTROL_PLANE_LATENCIES_ROUTE);
    const snapshot = await res.json();
    const byRoute = Object.fromEntries(snapshot.routes.map((r: { route: string }) => [r.route, r]));

    expect(byRoute['/api/health']).toMatchObject({ count: 1, slowCount: 1, errorCount: 0, p50Ms: 5010 });
    expect(byRoute['/api/ready']).toMatchObject({ count: 1, slowCount: 0, errorCount: 1, p50Ms: 1 });
  });

  test('does not record OPTIONS preflights or 404 probe paths', async () => {
    const requestMetrics = new RequestDurationMetrics();
    const controlPlaneMetrics = new ControlPlaneLatencyMetrics();
    const app = new Hono();

    app.use('*', createRequestDurationMiddleware(requestMetrics, controlPlaneMetrics));
    app.get('/api/health', (c) => c.json({ status: 'ok' }));
    app.options('/api/health', (c) => c.body(null, 204));

    await app.request('/api/health', { method: 'OPTIONS' }); // OPTIONS preflight: excluded
    await app.request('/api/health/does-not-exist'); // 404 (no handler): excluded

    expect(controlPlaneMetrics.snapshot().routeCount).toBe(0);
  });
});

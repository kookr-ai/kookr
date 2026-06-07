import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { createRequestDurationMiddleware, RequestDurationMetrics } from './request-duration-metrics.js';

describe('RequestDurationMetrics', () => {
  test('tracks total count and percentile latency from bounded samples', () => {
    const metrics = new RequestDurationMetrics({ maxSamplesPerRoute: 4 });

    for (const durationMs of [1, 2, 3, 4, 100]) {
      metrics.record({ method: 'get', route: '/api/tasks/:id', durationMs });
    }

    expect(metrics.snapshot()).toEqual({
      schemaVersion: 'request-duration-metrics.v1',
      maxRoutes: 128,
      maxSamplesPerRoute: 4,
      routeCount: 1,
      droppedRouteCount: 0,
      routes: [{
        method: 'GET',
        route: '/api/tasks/:id',
        count: 5,
        sampleCount: 4,
        p50Ms: 3,
        p95Ms: 100,
        p99Ms: 100,
      }],
    });
  });

  test('bounds route cardinality and reports dropped new route samples', () => {
    const metrics = new RequestDurationMetrics({ maxRoutes: 1 });

    metrics.record({ method: 'GET', route: '/api/tasks', durationMs: 1 });
    metrics.record({ method: 'GET', route: '/api/projects', durationMs: 2 });
    metrics.record({ method: 'GET', route: '/api/other', durationMs: 3 });

    const snapshot = metrics.snapshot();
    expect(snapshot.routeCount).toBe(1);
    expect(snapshot.droppedRouteCount).toBe(2);
    expect(snapshot.routes).toEqual([expect.objectContaining({
      method: 'GET',
      route: '/api/tasks',
      count: 1,
    })]);
  });

  test('middleware aggregates by matched Hono route template and excludes noisy routes', async () => {
    const times = [10, 17.25, 20, 29, 30, 31, 40, 41];
    const metrics = new RequestDurationMetrics({ nowMs: () => times.shift() ?? 50 });
    const app = new Hono();

    app.use('*', createRequestDurationMiddleware(metrics));
    app.get('/api/tasks/:taskId', (c) => c.json({ id: c.req.param('taskId') }));
    app.get('/api/health', (c) => c.json({ status: 'ok' }));
    app.get('/api/diagnostics/request-latencies', (c) => c.json(metrics.snapshot()));
    app.get('/assets/app.js', (c) => c.text('asset'));

    await app.request('/api/tasks/alpha');
    await app.request('/api/tasks/beta');
    await app.request('/api/health');
    await app.request('/assets/app.js');
    const res = await app.request('/api/diagnostics/request-latencies');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      schemaVersion: 'request-duration-metrics.v1',
      maxRoutes: 128,
      maxSamplesPerRoute: 256,
      routeCount: 1,
      droppedRouteCount: 0,
      routes: [{
        method: 'GET',
        route: '/api/tasks/:taskId',
        count: 2,
        sampleCount: 2,
        p50Ms: 7.25,
        p95Ms: 9,
        p99Ms: 9,
      }],
    });
  });
});

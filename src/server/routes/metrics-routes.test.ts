import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { CircuitBreaker, CircuitBreakerRegistry } from '../../core/circuit-breaker.js';
import { AttentionQueue } from '../../core/attention-queue.js';
import type { Anomaly } from '../../core/types.js';
import { RequestDurationMetrics } from '../request-duration-metrics.js';
import { PROMETHEUS_CONTENT_TYPE } from '../prometheus-exposition.js';
import { registerMetricsRoutes } from './metrics-routes.js';
import type { RouteDeps } from './shared.js';

function mkApp(deps: Partial<RouteDeps>): Hono {
  const app = new Hono();
  registerMetricsRoutes(app, deps as RouteDeps);
  return app;
}

function makeAnomaly(agentId: string): Anomaly {
  return {
    agentId,
    type: 'needs_input',
    severity: 'info',
    explanation: `needs_input for ${agentId}`,
    detectedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

describe('metrics routes', () => {
  test('serves Prometheus text exposition with the expected content type', async () => {
    const requestDurationMetrics = new RequestDurationMetrics();
    requestDurationMetrics.record({ method: 'GET', route: '/api/tasks', durationMs: 42 });
    const circuitBreakerRegistry = new CircuitBreakerRegistry();
    circuitBreakerRegistry.register(new CircuitBreaker({ name: 'github' }));

    const res = await mkApp({ requestDurationMetrics, circuitBreakerRegistry }).request('/metrics');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(PROMETHEUS_CONTENT_TYPE);
    const body = await res.text();
    expect(body).toContain('# TYPE kookr_http_request_duration_observations_total counter');
    expect(body).toContain('kookr_http_request_duration_observations_total{method="GET",route="/api/tasks"} 1');
    expect(body).toContain('kookr_circuit_breaker_state{name="github",state="closed"} 1');
  });

  test('serves live attention queue suppression counters', async () => {
    const queue = new AttentionQueue();
    queue.enqueue('agent-1', makeAnomaly('agent-1'));
    queue.enqueue('agent-1', makeAnomaly('agent-1'));

    const res = await mkApp({ queue }).request('/metrics');

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('kookr_attention_suppressed_total{reason="queue_dedupe"} 1');
    expect(body).toContain('kookr_attention_suppressed_total{reason="queue_snoozed"} 0');
  });

  test('requires an owner credential when non-loopback API auth is required', async () => {
    const app = mkApp({ apiAuth: { required: true, token: 'owner-token' } });

    expect((await app.request('/metrics')).status).toBe(401);
    for (const headers of [
      { authorization: 'Bearer owner-token' },
      { 'x-kookr-api-token': 'owner-token' },
      { cookie: 'kookr_session=owner-token' },
    ]) {
      expect((await app.request('/metrics', { headers })).status).toBe(200);
    }
  });

  test('rejects viewer credentials when non-loopback API auth is required', async () => {
    const app = mkApp({
      apiAuth: {
        required: true,
        token: 'owner-token',
        resolveViewer: (token) => token === 'viewer-token'
          ? { kind: 'valid', grantId: 'viewer-1', scope: { kind: 'all' } }
          : { kind: 'not-found' },
      },
    });

    const res = await app.request('/metrics', {
      headers: { authorization: 'Bearer viewer-token' },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });
});

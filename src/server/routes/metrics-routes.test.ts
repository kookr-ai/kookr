import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { CircuitBreaker, CircuitBreakerRegistry } from '../../core/circuit-breaker.js';
import { AttentionQueue } from '../../core/attention-queue.js';
import type { Anomaly } from '../../core/types.js';
import { Watchdog } from '../../core/watchdog.js';
import { AuthThrottle } from '../auth-throttle.js';
import { RequestDurationMetrics } from '../request-duration-metrics.js';
import { PROMETHEUS_CONTENT_TYPE } from '../prometheus-exposition.js';
import { TerminalInputRttMetrics } from '../terminal-input-rtt-metrics.js';
import { TerminalInputCoordinator } from '../terminal-input-coordinator.js';
import { FakeTerminalBackend } from '../../adapters/fake-terminal-backend.js';
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
    const watchdog = new Watchdog();
    watchdog.registerAgent('agent-1', 1_000, 1_000);
    watchdog.recordEvents('agent-1', [{
      type: 'tool_use',
      sessionId: 's1',
      toolName: 'Bash',
      toolUseId: 't1',
    }], 1_000);
    watchdog.recordEvents('agent-1', [{
      type: 'tool_result',
      sessionId: 's1',
      toolName: 'Bash',
      toolUseId: 't1',
    }], 1_042);

    const res = await mkApp({ requestDurationMetrics, circuitBreakerRegistry, watchdog }).request('/metrics');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(PROMETHEUS_CONTENT_TYPE);
    const body = await res.text();
    expect(body).toContain('# TYPE kookr_http_request_duration_observations_total counter');
    expect(body).toContain('kookr_http_request_duration_observations_total{method="GET",route="/api/tasks"} 1');
    expect(body).toContain('# TYPE kookr_tool_duration_observations_total counter');
    expect(body).toContain('kookr_tool_duration_observations_total{tool="Bash"} 1');
    expect(body).toContain('kookr_tool_duration_seconds{tool="Bash",quantile="0.5"} 0.042');
    expect(body).toContain('kookr_tool_duration_seconds{tool="Bash",quantile="0.95"} 0.042');
    expect(body).toContain('kookr_circuit_breaker_state{name="github",state="closed"} 1');
    expect(body).toContain('kookr_auth_failed_attempts_total 0');
    expect(body).toContain('kookr_auth_throttled_attempts_total 0');
    expect(body).toContain('kookr_auth_locked_out_sources 0');
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

  test('serves live audit sink health metrics', async () => {
    const res = await mkApp({
      auditSinks: {
        getAllSnapshots: () => [{
          sink: 'private_network_collaboration',
          writable: false,
          appendFailureCount: 2,
        }],
      },
    }).request('/metrics');

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('kookr_audit_sink_writable{sink="private_network_collaboration"} 0');
    expect(body).toContain('kookr_audit_append_failures_total{sink="private_network_collaboration"} 2');
  });

  test('serves live webhook delivery outcome counters', async () => {
    const res = await mkApp({
      webhookNotifier: {
        getDeliveryCounts: () => ({
          success: 3,
          failed: 5,
          dropped: 2,
        }),
      },
    }).request('/metrics');

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('kookr_webhook_deliveries_total{outcome="success"} 3');
    expect(body).toContain('kookr_webhook_deliveries_total{outcome="failed"} 5');
    expect(body).toContain('kookr_webhook_deliveries_total{outcome="dropped"} 2');
  });

  test('serves terminalWrite saturation gauges from backend + coordinator (issue #1776)', async () => {
    const res = await mkApp({
      terminalBackend: {
        getStats: () => ({
          attachedSessions: 1,
          reattachCounts: {},
          pendingWriters: 2,
          maxPendingWriters: 7,
          writeTimeoutCount: 4,
          lastError: null,
          errorCount: 4,
        }),
      } as never,
      terminalInputCoordinator: {
        getWriteMetrics: () => ({ pendingWrites: 1, maxPendingWrites: 3 }),
      } as never,
    }).request('/metrics');

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('kookr_terminal_write_pending_writers 2');
    expect(body).toContain('kookr_terminal_write_max_pending_writers 7');
    expect(body).toContain('kookr_terminal_write_timeouts_total 4');
    expect(body).toContain('kookr_terminal_write_pending_writes 1');
    expect(body).toContain('kookr_terminal_write_max_pending_writes 3');
  });

  test('serves live aggregate auth throttle metrics', async () => {
    const authThrottle = new AuthThrottle({ freeFailures: 0, audit: () => {} });
    authThrottle.recordFailure('10.0.0.12', 'bad_token');
    authThrottle.recordThrottledAttempt('10.0.0.12');

    const res = await mkApp({
      apiAuth: { required: true, token: 'owner-token', authThrottle },
    }).request('/metrics', {
      headers: { authorization: 'Bearer owner-token' },
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('kookr_auth_failed_attempts_total 1');
    expect(body).toContain('kookr_auth_throttled_attempts_total 1');
    expect(body).toContain('kookr_auth_locked_out_sources 1');
    expect(body).not.toContain('10.0.0.12');
  });

  test('exposes terminal input RTT recorded by a real coordinator write (issue #1773)', async () => {
    // End-to-end: a successful coordinator write records a sample through the
    // live histogram, which then surfaces on /metrics with quantiles + count.
    const clock = [4, 10];
    const terminalInputRttMetrics = new TerminalInputRttMetrics({ nowMs: () => clock.shift() ?? 0 });
    const backend = new FakeTerminalBackend();
    await backend.createSession({ id: 's1', command: 'agent', args: [] });
    const coordinator = new TerminalInputCoordinator(backend, undefined, terminalInputRttMetrics);
    coordinator.registerSession('s1');
    await coordinator.writeInput('s1', new TextEncoder().encode('x'));

    const res = await mkApp({ terminalInputRttMetrics }).request('/metrics');

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('# TYPE kookr_terminal_input_rtt_seconds gauge');
    // 6ms round-trip rendered as Prometheus base-unit seconds.
    expect(body).toContain('kookr_terminal_input_rtt_seconds{quantile="0.5"} 0.006');
    expect(body).toContain('kookr_terminal_input_rtt_observations_total 1');
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

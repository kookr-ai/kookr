import { describe, expect, test } from 'vitest';
import type { CircuitBreakerSnapshot } from '../core/circuit-breaker.js';
import { AttentionQueue } from '../core/attention-queue.js';
import type { Anomaly } from '../core/types.js';
import type { RequestDurationMetricsSnapshot } from './request-duration-metrics.js';
import { renderPrometheusExposition } from './prometheus-exposition.js';

const EMPTY_REQUEST_DURATIONS: RequestDurationMetricsSnapshot = {
  schemaVersion: 'request-duration-metrics.v1',
  maxRoutes: 128,
  maxSamplesPerRoute: 256,
  routeCount: 0,
  droppedRouteCount: 0,
  routes: [],
};

function makeAnomaly(agentId: string): Anomaly {
  return {
    agentId,
    type: 'needs_input',
    severity: 'info',
    explanation: `needs_input for ${agentId}`,
    detectedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

describe('renderPrometheusExposition', () => {
  test('renders request durations and circuit breakers in Prometheus text format', () => {
    const requestDurations: RequestDurationMetricsSnapshot = {
      schemaVersion: 'request-duration-metrics.v1',
      maxRoutes: 128,
      maxSamplesPerRoute: 256,
      routeCount: 1,
      droppedRouteCount: 2,
      routes: [{
        method: 'GET',
        route: '/api/tasks/:taskId/"events"\\tail',
        count: 7,
        sampleCount: 4,
        p50Ms: 12.5,
        p95Ms: 25,
        p99Ms: 30,
      }],
    };
    const circuitBreakers: CircuitBreakerSnapshot[] = [{
      name: 'llm',
      state: 'open',
      failureCount: 3,
      successCount: 0,
      lastFailureTime: 123,
      lastStateChange: 456,
      resetTimeoutMs: 30_000,
    }];

    const output = renderPrometheusExposition({ requestDurations, circuitBreakers });

    expect(output).toContain('# HELP kookr_http_request_duration_observations_total Total recorded HTTP request-duration observations by route template.');
    expect(output).toContain('# TYPE kookr_http_request_duration_observations_total counter');
    expect(output).toContain('kookr_http_request_duration_observations_total{method="GET",route="/api/tasks/:taskId/\\"events\\"\\\\tail"} 7');
    expect(output).toContain('# TYPE kookr_http_request_duration_sample_count gauge');
    expect(output).toContain('kookr_http_request_duration_sample_count{method="GET",route="/api/tasks/:taskId/\\"events\\"\\\\tail"} 4');
    expect(output).toContain('# TYPE kookr_http_request_duration_seconds gauge');
    expect(output).toContain('kookr_http_request_duration_seconds{method="GET",route="/api/tasks/:taskId/\\"events\\"\\\\tail",quantile="0.5"} 0.0125');
    expect(output).toContain('kookr_http_request_duration_seconds{method="GET",route="/api/tasks/:taskId/\\"events\\"\\\\tail",quantile="0.95"} 0.025');
    expect(output).toContain('kookr_http_request_duration_seconds{method="GET",route="/api/tasks/:taskId/\\"events\\"\\\\tail",quantile="0.99"} 0.03');
    expect(output).toContain('kookr_http_request_duration_dropped_routes_total 2');
    expect(output).toContain('# HELP kookr_circuit_breaker_state Current circuit-breaker state. The active state is 1 and inactive states are 0.');
    expect(output).toContain('# TYPE kookr_circuit_breaker_state gauge');
    expect(output).toContain('kookr_circuit_breaker_state{name="llm",state="closed"} 0');
    expect(output).toContain('kookr_circuit_breaker_state{name="llm",state="open"} 1');
    expect(output).toContain('kookr_circuit_breaker_state{name="llm",state="half-open"} 0');
    expect(output).toContain('kookr_circuit_breaker_failures{name="llm"} 3');
    expect(output).toContain('# TYPE kookr_attention_suppressed_total counter');
    expect(output).toContain('kookr_attention_suppressed_total{reason="queue_dedupe"} 0');
    expect(output).toContain('kookr_attention_suppressed_total{reason="queue_snoozed"} 0');
    expect(output).toContain('# TYPE kookr_audit_sink_writable gauge');
    expect(output).toContain('# TYPE kookr_audit_append_failures_total counter');
    expect(output.endsWith('\n')).toBe(true);
  });

  test('increments attention suppression counter for duplicate queue admissions', () => {
    const queue = new AttentionQueue();

    queue.enqueue('agent-1', makeAnomaly('agent-1'));
    queue.enqueue('agent-1', makeAnomaly('agent-1'));

    const output = renderPrometheusExposition({
      requestDurations: EMPTY_REQUEST_DURATIONS,
      circuitBreakers: [],
      attentionQueueSuppressions: queue.getSuppressionCounts(),
    });

    expect(output).toContain('# TYPE kookr_attention_suppressed_total counter');
    expect(output).toContain('kookr_attention_suppressed_total{reason="queue_dedupe"} 1');
    expect(output).toContain('kookr_attention_suppressed_total{reason="queue_snoozed"} 0');
  });

  test('increments attention suppression counter for snoozed queue admissions', () => {
    const queue = new AttentionQueue();

    queue.enqueue('agent-1', makeAnomaly('agent-1'));
    queue.snooze('agent-1', 60_000);
    queue.enqueue('agent-1', makeAnomaly('agent-1'));

    const output = renderPrometheusExposition({
      requestDurations: EMPTY_REQUEST_DURATIONS,
      circuitBreakers: [],
      attentionQueueSuppressions: queue.getSuppressionCounts(),
    });

    expect(output).toContain('# TYPE kookr_attention_suppressed_total counter');
    expect(output).toContain('kookr_attention_suppressed_total{reason="queue_dedupe"} 0');
    expect(output).toContain('kookr_attention_suppressed_total{reason="queue_snoozed"} 1');
  });

  test('renders audit sink writable gauge and append failure counter without failure reasons', () => {
    const output = renderPrometheusExposition({
      requestDurations: EMPTY_REQUEST_DURATIONS,
      circuitBreakers: [],
      auditSinks: [{
        sink: 'private_network_collaboration',
        writable: false,
        appendFailureCount: 7,
      }, {
        sink: 'healthy_sink',
        writable: true,
        appendFailureCount: 0,
      }],
    });

    expect(output).toContain('# HELP kookr_audit_sink_writable Current audit sink write health. 1 means writable, 0 means the last append failed.');
    expect(output).toContain('# TYPE kookr_audit_sink_writable gauge');
    expect(output).toContain('kookr_audit_sink_writable{sink="private_network_collaboration"} 0');
    expect(output).toContain('kookr_audit_sink_writable{sink="healthy_sink"} 1');
    expect(output).toContain('# HELP kookr_audit_append_failures_total Total failed audit append attempts by sink.');
    expect(output).toContain('# TYPE kookr_audit_append_failures_total counter');
    expect(output).toContain('kookr_audit_append_failures_total{sink="private_network_collaboration"} 7');
    expect(output).toContain('kookr_audit_append_failures_total{sink="healthy_sink"} 0');
    expect(output).not.toContain('lastFailure');
  });

  test('renders aggregate auth throttle counters without source labels', () => {
    const output = renderPrometheusExposition({
      requestDurations: EMPTY_REQUEST_DURATIONS,
      circuitBreakers: [],
      authThrottle: {
        schemaVersion: 'auth-throttle.v1',
        totalFailedAttempts: 11,
        totalThrottledAttempts: 4,
        activeSourceCount: 3,
        lockedOutSources: [{
          source: '10.0.0.1',
          failures: 6,
          retryAfterMs: 1_000,
          throttledAttempts: 3,
          lastReason: 'bad_token',
        }, {
          source: '10.0.0.2',
          failures: 7,
          retryAfterMs: 2_000,
          throttledAttempts: 1,
          lastReason: 'throttled',
        }],
      },
    });

    expect(output).toContain('# HELP kookr_auth_failed_attempts_total Total failed owner-authentication attempts for this process.');
    expect(output).toContain('# TYPE kookr_auth_failed_attempts_total counter');
    expect(output).toContain('kookr_auth_failed_attempts_total 11');
    expect(output).toContain('# TYPE kookr_auth_throttled_attempts_total counter');
    expect(output).toContain('kookr_auth_throttled_attempts_total 4');
    expect(output).toContain('# TYPE kookr_auth_locked_out_sources gauge');
    expect(output).toContain('kookr_auth_locked_out_sources 2');
    expect(output).not.toContain('10.0.0.');
    expect(output).not.toContain('source=');
  });
});

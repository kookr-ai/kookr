import type { CircuitBreakerSnapshot, CircuitBreakerState } from '../core/circuit-breaker.js';
import {
  ATTENTION_QUEUE_SUPPRESSION_REASONS,
  type AttentionQueueSuppressionCounts,
} from '../core/attention-queue.js';
import type { AuthThrottleSnapshot } from './auth-throttle.js';
import type { RequestDurationMetricsSnapshot } from './request-duration-metrics.js';

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4';

export interface PrometheusExpositionSnapshot {
  requestDurations: RequestDurationMetricsSnapshot;
  circuitBreakers: CircuitBreakerSnapshot[];
  attentionQueueSuppressions?: AttentionQueueSuppressionCounts;
  auditSinks?: AuditSinkMetricsSnapshot[];
  authThrottle?: AuthThrottleSnapshot;
}

export interface AuditSinkMetricsSnapshot {
  sink: string;
  writable: boolean;
  appendFailureCount: number;
}

export function renderPrometheusExposition(snapshot: PrometheusExpositionSnapshot): string {
  const lines: string[] = [];

  appendRequestDurationMetrics(lines, snapshot.requestDurations);
  appendCircuitBreakerMetrics(lines, snapshot.circuitBreakers);
  appendAttentionQueueSuppressionMetrics(lines, snapshot.attentionQueueSuppressions);
  appendAuditSinkMetrics(lines, snapshot.auditSinks ?? []);
  appendAuthThrottleMetrics(lines, snapshot.authThrottle);

  return `${lines.join('\n')}\n`;
}

function appendRequestDurationMetrics(lines: string[], snapshot: RequestDurationMetricsSnapshot): void {
  lines.push(
    '# HELP kookr_http_request_duration_observations_total Total recorded HTTP request-duration observations by route template.',
    '# TYPE kookr_http_request_duration_observations_total counter',
  );
  for (const route of snapshot.routes) {
    lines.push(metricLine('kookr_http_request_duration_observations_total', {
      method: route.method,
      route: route.route,
    }, route.count));
  }

  lines.push(
    '# HELP kookr_http_request_duration_sample_count Number of retained request-duration samples by route template.',
    '# TYPE kookr_http_request_duration_sample_count gauge',
  );
  for (const route of snapshot.routes) {
    lines.push(metricLine('kookr_http_request_duration_sample_count', {
      method: route.method,
      route: route.route,
    }, route.sampleCount));
  }

  lines.push(
    '# HELP kookr_http_request_duration_seconds Request-duration quantiles by route template.',
    '# TYPE kookr_http_request_duration_seconds gauge',
  );
  for (const route of snapshot.routes) {
    const baseLabels = { method: route.method, route: route.route };
    lines.push(
      metricLine('kookr_http_request_duration_seconds', { ...baseLabels, quantile: '0.5' }, msToSeconds(route.p50Ms)),
      metricLine('kookr_http_request_duration_seconds', { ...baseLabels, quantile: '0.95' }, msToSeconds(route.p95Ms)),
      metricLine('kookr_http_request_duration_seconds', { ...baseLabels, quantile: '0.99' }, msToSeconds(route.p99Ms)),
    );
  }

  lines.push(
    '# HELP kookr_http_request_duration_dropped_routes_total Total route templates dropped after the request-duration route limit was reached.',
    '# TYPE kookr_http_request_duration_dropped_routes_total counter',
    metricLine('kookr_http_request_duration_dropped_routes_total', {}, snapshot.droppedRouteCount),
  );
}

function appendCircuitBreakerMetrics(lines: string[], snapshots: CircuitBreakerSnapshot[]): void {
  lines.push(
    '# HELP kookr_circuit_breaker_state Current circuit-breaker state. The active state is 1 and inactive states are 0.',
    '# TYPE kookr_circuit_breaker_state gauge',
  );
  for (const breaker of snapshots) {
    for (const state of CIRCUIT_BREAKER_STATES) {
      lines.push(metricLine('kookr_circuit_breaker_state', {
        name: breaker.name,
        state,
      }, breaker.state === state ? 1 : 0));
    }
  }

  lines.push(
    '# HELP kookr_circuit_breaker_failures Current recent failure count by circuit breaker.',
    '# TYPE kookr_circuit_breaker_failures gauge',
  );
  for (const breaker of snapshots) {
    lines.push(metricLine('kookr_circuit_breaker_failures', { name: breaker.name }, breaker.failureCount));
  }

  lines.push(
    '# HELP kookr_circuit_breaker_rejected_total Total calls rejected while a circuit breaker was open.',
    '# TYPE kookr_circuit_breaker_rejected_total counter',
  );
  for (const breaker of snapshots) {
    lines.push(metricLine('kookr_circuit_breaker_rejected_total', { name: breaker.name }, breaker.rejectedCalls));
  }

  lines.push(
    '# HELP kookr_circuit_breaker_trips_total Total transitions into the open state by circuit breaker.',
    '# TYPE kookr_circuit_breaker_trips_total counter',
  );
  for (const breaker of snapshots) {
    lines.push(metricLine('kookr_circuit_breaker_trips_total', { name: breaker.name }, breaker.tripCount));
  }
}

function appendAttentionQueueSuppressionMetrics(
  lines: string[],
  counts: AttentionQueueSuppressionCounts = { queue_dedupe: 0, queue_snoozed: 0 },
): void {
  lines.push(
    '# HELP kookr_attention_suppressed_total Total attention queue findings suppressed before admission, by queue suppression reason.',
    '# TYPE kookr_attention_suppressed_total counter',
  );
  for (const reason of ATTENTION_QUEUE_SUPPRESSION_REASONS) {
    lines.push(metricLine('kookr_attention_suppressed_total', { reason }, counts[reason]));
  }
}

function appendAuditSinkMetrics(lines: string[], snapshots: AuditSinkMetricsSnapshot[]): void {
  lines.push(
    '# HELP kookr_audit_sink_writable Current audit sink write health. 1 means writable, 0 means the last append failed.',
    '# TYPE kookr_audit_sink_writable gauge',
  );
  for (const sink of snapshots) {
    lines.push(metricLine('kookr_audit_sink_writable', { sink: sink.sink }, sink.writable ? 1 : 0));
  }

  lines.push(
    '# HELP kookr_audit_append_failures_total Total failed audit append attempts by sink.',
    '# TYPE kookr_audit_append_failures_total counter',
  );
  for (const sink of snapshots) {
    lines.push(metricLine('kookr_audit_append_failures_total', { sink: sink.sink }, sink.appendFailureCount));
  }
}

function appendAuthThrottleMetrics(lines: string[], snapshot: AuthThrottleSnapshot = EMPTY_AUTH_THROTTLE): void {
  lines.push(
    '# HELP kookr_auth_failed_attempts_total Total failed owner-authentication attempts for this process.',
    '# TYPE kookr_auth_failed_attempts_total counter',
    metricLine('kookr_auth_failed_attempts_total', {}, snapshot.totalFailedAttempts),
    '# HELP kookr_auth_throttled_attempts_total Total owner-authentication attempts rejected while a source was throttled for this process.',
    '# TYPE kookr_auth_throttled_attempts_total counter',
    metricLine('kookr_auth_throttled_attempts_total', {}, snapshot.totalThrottledAttempts),
    '# HELP kookr_auth_locked_out_sources Current count of sources locked out by the auth throttle.',
    '# TYPE kookr_auth_locked_out_sources gauge',
    metricLine('kookr_auth_locked_out_sources', {}, snapshot.lockedOutSources.length),
  );
}

const CIRCUIT_BREAKER_STATES: CircuitBreakerState[] = ['closed', 'open', 'half-open'];

const EMPTY_AUTH_THROTTLE: AuthThrottleSnapshot = {
  schemaVersion: 'auth-throttle.v1',
  totalFailedAttempts: 0,
  totalThrottledAttempts: 0,
  activeSourceCount: 0,
  lockedOutSources: [],
};

function metricLine(name: string, labels: Record<string, string>, value: number): string {
  const labelText = formatLabels(labels);
  return `${name}${labelText} ${formatNumber(value)}`;
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(',')}}`;
}

function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

function msToSeconds(ms: number): number {
  return ms / 1000;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return String(value);
}

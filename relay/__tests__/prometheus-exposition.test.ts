import { describe, expect, it } from 'vitest';

import { PROMETHEUS_CONTENT_TYPE, renderRelayPrometheusExposition } from '../prometheus-exposition.js';
import type { HostedRelayAlert, HostedRelayMetricSnapshot } from '../../src/shared/contracts/hosted-relay.js';

function baseMetrics(overrides: Partial<HostedRelayMetricSnapshot> = {}): HostedRelayMetricSnapshot {
  return {
    ticketsCreated: 5,
    ticketsAccepted: 3,
    ticketsRevoked: 1,
    ticketsExpired: 2,
    acceptFailuresByReason: { expired: 4, revoked: 1 },
    rateLimitHits: 7,
    perShareLockCount: 1,
    securityEvents: 0,
    activeNodeSockets: 2,
    activeClientSockets: 6,
    maxNodeHeartbeatAgeMs: 12000,
    lastRevokePropagationLatencyMs: 250,
    policySyncFailures: 0,
    http5xxCount: 3,
    recentWindowMs: 60000,
    recent: { rateLimitHits: 2, perShareLockCount: 0, securityEvents: 0, http5xxCount: 1 },
    ...overrides,
  };
}

describe('renderRelayPrometheusExposition', () => {
  it('uses the Prometheus text content type', () => {
    expect(PROMETHEUS_CONTENT_TYPE).toBe('text/plain; version=0.0.4');
  });

  it('renders counters, gauges, and the trailing newline', () => {
    const text = renderRelayPrometheusExposition(baseMetrics());
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('# TYPE kookr_relay_tickets_created_total counter');
    expect(text).toContain('kookr_relay_tickets_created_total 5');
    expect(text).toContain('# TYPE kookr_relay_active_node_sockets gauge');
    expect(text).toContain('kookr_relay_active_node_sockets 2');
    expect(text).toContain('kookr_relay_http_5xx_total 3');
  });

  it('renders per-reason accept failures with a reason label', () => {
    const text = renderRelayPrometheusExposition(baseMetrics());
    expect(text).toContain('kookr_relay_accept_failures_total{reason="expired"} 4');
    expect(text).toContain('kookr_relay_accept_failures_total{reason="revoked"} 1');
  });

  it('converts millisecond gauges to seconds', () => {
    const text = renderRelayPrometheusExposition(baseMetrics());
    expect(text).toContain('kookr_relay_max_node_heartbeat_age_seconds 12');
    expect(text).toContain('kookr_relay_last_revoke_propagation_latency_seconds 0.25');
  });

  it('omits null-valued gauges rather than emitting a bogus zero', () => {
    const text = renderRelayPrometheusExposition(
      baseMetrics({ maxNodeHeartbeatAgeMs: null, lastRevokePropagationLatencyMs: null }),
    );
    expect(text).not.toContain('kookr_relay_max_node_heartbeat_age_seconds');
    expect(text).not.toContain('kookr_relay_last_revoke_propagation_latency_seconds');
  });

  it('labels recent-window gauges with the window duration', () => {
    const text = renderRelayPrometheusExposition(baseMetrics());
    expect(text).toContain('kookr_relay_recent_rate_limit_hits{window_ms="60000"} 2');
  });

  it('models the monotonic per-share lockout count as a counter', () => {
    const text = renderRelayPrometheusExposition(baseMetrics());
    expect(text).toContain('# TYPE kookr_relay_per_share_lockouts_total counter');
    expect(text).toContain('kookr_relay_per_share_lockouts_total 1');
  });

  it('omits the recent-window series when no recent block is present', () => {
    const text = renderRelayPrometheusExposition(baseMetrics({ recent: undefined, recentWindowMs: undefined }));
    expect(text).not.toContain('kookr_relay_recent_rate_limit_hits');
    expect(text).not.toContain('kookr_relay_recent_http_5xx');
  });

  it('emits only the header for an empty accept-failure map', () => {
    const text = renderRelayPrometheusExposition(baseMetrics({ acceptFailuresByReason: {} }));
    expect(text).toContain('# TYPE kookr_relay_accept_failures_total counter');
    expect(text).not.toContain('kookr_relay_accept_failures_total{');
  });

  it('escapes special characters in label values', () => {
    const alerts: HostedRelayAlert[] = [
      { code: 'weird"code\\with\nnewline', severity: 'warning', message: 'z' },
    ];
    const text = renderRelayPrometheusExposition(baseMetrics(), alerts);
    expect(text).toContain('code="weird\\"code\\\\with\\nnewline"');
  });

  it('exposes active alerts as firing series so they can be graphed', () => {
    const alerts: HostedRelayAlert[] = [
      { code: 'security-events', severity: 'critical', message: 'x' },
      { code: 'rate-limit-hits', severity: 'warning', message: 'y' },
    ];
    const text = renderRelayPrometheusExposition(baseMetrics(), alerts);
    expect(text).toContain('kookr_relay_alert_active{code="security-events",severity="critical"} 1');
    expect(text).toContain('kookr_relay_alert_active{code="rate-limit-hits",severity="warning"} 1');
  });

  it('emits the alert HELP/TYPE header even when no alerts are firing', () => {
    const text = renderRelayPrometheusExposition(baseMetrics(), []);
    expect(text).toContain('# TYPE kookr_relay_alert_active gauge');
  });
});

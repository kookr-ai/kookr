import type { HostedRelayAlert, HostedRelayMetricSnapshot } from '../src/shared/contracts/hosted-relay.js';

// The relay is a separately-built process with an enforced import boundary
// (scripts/check-remote-import-boundaries.ts, tsconfig.relay.json), so it cannot
// pull in the main server's exposition renderer (src/server/prometheus-exposition.ts)
// without dragging that file's server-only dependency tree into the relay build.
// The Prometheus text primitives are ~20 lines of pure string formatting, so we
// keep a self-contained copy here rather than share across the boundary (#1383).

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4';

function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(',')}}`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return String(value);
}

function metricLine(name: string, labels: Record<string, string>, value: number): string {
  return `${name}${formatLabels(labels)} ${formatNumber(value)}`;
}

/**
 * Render the relay's existing metric snapshot (and its computed alerts) as a
 * Prometheus text exposition, so an operator already scraping the Kookr server
 * can graph relay time-series and let `relayAlerts()` fire, instead of only
 * seeing them in a point-in-time admin JSON response (#1383).
 */
export function renderRelayPrometheusExposition(
  metrics: HostedRelayMetricSnapshot,
  alerts: HostedRelayAlert[] = [],
): string {
  const lines: string[] = [];

  const counter = (name: string, help: string, value: number, labels: Record<string, string> = {}): void => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`, metricLine(name, labels, value));
  };
  const gauge = (name: string, help: string, value: number, labels: Record<string, string> = {}): void => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, metricLine(name, labels, value));
  };

  counter('kookr_relay_tickets_created_total', 'Total share tickets created.', metrics.ticketsCreated);
  counter('kookr_relay_tickets_accepted_total', 'Total share tickets accepted.', metrics.ticketsAccepted);
  counter('kookr_relay_tickets_revoked_total', 'Total share tickets revoked.', metrics.ticketsRevoked);
  gauge('kookr_relay_tickets_expired', 'Share tickets currently expired but not revoked.', metrics.ticketsExpired);

  lines.push(
    '# HELP kookr_relay_accept_failures_total Total share-accept failures by reason.',
    '# TYPE kookr_relay_accept_failures_total counter',
  );
  for (const [reason, count] of Object.entries(metrics.acceptFailuresByReason)) {
    lines.push(metricLine('kookr_relay_accept_failures_total', { reason }, count));
  }

  counter('kookr_relay_rate_limit_hits_total', 'Total requests blocked by relay rate limits.', metrics.rateLimitHits);
  // perShareLockCount only ever increments (relay/server.ts) — a cumulative
  // counter, not a current-state gauge, so model it as one for rate()/increase().
  counter('kookr_relay_per_share_lockouts_total', 'Total share-ticket lockouts after repeated failures.', metrics.perShareLockCount);
  counter('kookr_relay_security_events_total', 'Total relay security events observed.', metrics.securityEvents);
  gauge('kookr_relay_active_node_sockets', 'Currently connected node WebSocket sessions.', metrics.activeNodeSockets);
  gauge('kookr_relay_active_client_sockets', 'Currently connected client WebSocket sessions.', metrics.activeClientSockets);
  counter('kookr_relay_policy_sync_failures_total', 'Total policy-sync message failures.', metrics.policySyncFailures);
  counter('kookr_relay_http_5xx_total', 'Total 5xx responses served by the relay.', metrics.http5xxCount);

  if (metrics.maxNodeHeartbeatAgeMs !== null) {
    gauge(
      'kookr_relay_max_node_heartbeat_age_seconds',
      'Oldest node heartbeat age across connected nodes, in seconds.',
      metrics.maxNodeHeartbeatAgeMs / 1000,
    );
  }
  if (metrics.lastRevokePropagationLatencyMs !== null) {
    gauge(
      'kookr_relay_last_revoke_propagation_latency_seconds',
      'Latency of the most recent revoke propagation, in seconds.',
      metrics.lastRevokePropagationLatencyMs / 1000,
    );
  }

  if (metrics.recent) {
    const windowLabel = { window_ms: String(metrics.recentWindowMs ?? 0) };
    gauge('kookr_relay_recent_rate_limit_hits', 'Rate-limit hits within the recent window.', metrics.recent.rateLimitHits, windowLabel);
    gauge('kookr_relay_recent_per_share_lockouts', 'Per-share lockouts within the recent window.', metrics.recent.perShareLockCount, windowLabel);
    gauge('kookr_relay_recent_security_events', 'Security events within the recent window.', metrics.recent.securityEvents, windowLabel);
    gauge('kookr_relay_recent_http_5xx', '5xx responses within the recent window.', metrics.recent.http5xxCount, windowLabel);
  }

  // Expose alerts as a firing series so they can be graphed and alerted on,
  // instead of only being visible to whoever curls the admin JSON at that instant.
  lines.push(
    '# HELP kookr_relay_alert_active Active relay alert (value 1), labelled by code and severity.',
    '# TYPE kookr_relay_alert_active gauge',
  );
  for (const alert of alerts) {
    lines.push(metricLine('kookr_relay_alert_active', { code: alert.code, severity: alert.severity }, 1));
  }

  return `${lines.join('\n')}\n`;
}

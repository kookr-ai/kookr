import { describe, expect, test } from 'vitest';
import type { CircuitBreakerSnapshot } from '../core/circuit-breaker.js';
import { AttentionQueue } from '../core/attention-queue.js';
import type { Anomaly } from '../core/types.js';
import type { RequestDurationMetricsSnapshot } from './request-duration-metrics.js';
import { renderPrometheusExposition } from './prometheus-exposition.js';
import type { WebhookDeliveryCounts } from '../integrations/webhook/index.js';
import type { ToolLatencyMetricsSnapshot } from '../core/tool-latency-metrics.js';

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
      rejectedCalls: 4,
      tripCount: 2,
      lastFailureTime: 123,
      lastStateChange: 456,
      resetTimeoutMs: 30_000,
    }];

    const toolLatencies: ToolLatencyMetricsSnapshot = {
      schemaVersion: 'tool-latency-metrics.v1',
      maxTools: 64,
      maxSamplesPerTool: 256,
      toolCount: 1,
      droppedToolCount: 1,
      tools: [{
        toolName: 'Bash/"nested"\\path',
        count: 5,
        sampleCount: 3,
        p50Ms: 100,
        p95Ms: 250,
        p99Ms: 300,
      }],
    };

    const output = renderPrometheusExposition({ requestDurations, circuitBreakers, toolLatencies });

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
    expect(output).toContain('# HELP kookr_tool_duration_observations_total Total recorded PreToolUse→PostToolUse observations by tool name.');
    expect(output).toContain('# TYPE kookr_tool_duration_observations_total counter');
    expect(output).toContain('kookr_tool_duration_observations_total{tool="Bash/\\"nested\\"\\\\path"} 5');
    expect(output).toContain('# TYPE kookr_tool_duration_sample_count gauge');
    expect(output).toContain('kookr_tool_duration_sample_count{tool="Bash/\\"nested\\"\\\\path"} 3');
    expect(output).toContain('# TYPE kookr_tool_duration_seconds gauge');
    expect(output).toContain('kookr_tool_duration_seconds{tool="Bash/\\"nested\\"\\\\path",quantile="0.5"} 0.1');
    expect(output).toContain('kookr_tool_duration_seconds{tool="Bash/\\"nested\\"\\\\path",quantile="0.95"} 0.25');
    expect(output).toContain('kookr_tool_duration_seconds{tool="Bash/\\"nested\\"\\\\path",quantile="0.99"} 0.3');
    expect(output).toContain('kookr_tool_duration_dropped_tools_total 1');
    expect(output).toContain('# HELP kookr_circuit_breaker_state Current circuit-breaker state. The active state is 1 and inactive states are 0.');
    expect(output).toContain('# TYPE kookr_circuit_breaker_state gauge');
    expect(output).toContain('kookr_circuit_breaker_state{name="llm",state="closed"} 0');
    expect(output).toContain('kookr_circuit_breaker_state{name="llm",state="open"} 1');
    expect(output).toContain('kookr_circuit_breaker_state{name="llm",state="half-open"} 0');
    expect(output).toContain('kookr_circuit_breaker_failures{name="llm"} 3');
    expect(output).toContain('# TYPE kookr_circuit_breaker_rejected_total counter');
    expect(output).toContain('kookr_circuit_breaker_rejected_total{name="llm"} 4');
    expect(output).toContain('# TYPE kookr_circuit_breaker_trips_total counter');
    expect(output).toContain('kookr_circuit_breaker_trips_total{name="llm"} 2');
    expect(output).toContain('# TYPE kookr_attention_suppressed_total counter');
    expect(output).toContain('kookr_attention_suppressed_total{reason="queue_dedupe"} 0');
    expect(output).toContain('kookr_attention_suppressed_total{reason="queue_snoozed"} 0');
    expect(output).toContain('# TYPE kookr_audit_sink_writable gauge');
    expect(output).toContain('# TYPE kookr_audit_append_failures_total counter');
    expect(output).toContain('# TYPE kookr_webhook_deliveries_total counter');
    expect(output).toContain('kookr_webhook_deliveries_total{outcome="success"} 0');
    expect(output).toContain('kookr_webhook_deliveries_total{outcome="failed"} 0');
    expect(output).toContain('kookr_webhook_deliveries_total{outcome="dropped"} 0');
    expect(output.endsWith('\n')).toBe(true);
  });

  test('renders idempotency retention gauges and compaction counters', () => {
    const output = renderPrometheusExposition({
      requestDurations: EMPTY_REQUEST_DURATIONS,
      circuitBreakers: [],
      idempotencyLedger: {
        schemaVersion: 'idempotency-ledger-metrics.v1',
        entryCount: 7,
        pendingCount: 1,
        maxEntries: 100,
        ttlMs: 86_400_000,
        expiredTotal: 3,
        evictedTotal: 2,
      },
    });
    expect(output).toContain('kookr_idempotency_ledger_entries 7');
    expect(output).toContain('kookr_idempotency_ledger_pending 1');
    expect(output).toContain('kookr_idempotency_ledger_max_entries 100');
    expect(output).toContain('kookr_idempotency_ledger_ttl_seconds 86400');
    expect(output).toContain('kookr_idempotency_ledger_expired_total 3');
    expect(output).toContain('kookr_idempotency_ledger_evicted_total 2');
  });

  test('renders webhook delivery outcome counters', () => {
    const webhookDeliveries: WebhookDeliveryCounts = {
      success: 4,
      failed: 2,
      dropped: 1,
    };
    const output = renderPrometheusExposition({
      requestDurations: EMPTY_REQUEST_DURATIONS,
      circuitBreakers: [],
      webhookDeliveries,
    });

    expect(output).toContain('# HELP kookr_webhook_deliveries_total Total outbound finding-webhook delivery outcomes by result.');
    expect(output).toContain('# TYPE kookr_webhook_deliveries_total counter');
    expect(output).toContain('kookr_webhook_deliveries_total{outcome="success"} 4');
    expect(output).toContain('kookr_webhook_deliveries_total{outcome="failed"} 2');
    expect(output).toContain('kookr_webhook_deliveries_total{outcome="dropped"} 1');
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

  test('renders per-repo GitHub state-fetch failure counters (issue #1946)', () => {
    const output = renderPrometheusExposition({
      requestDurations: EMPTY_REQUEST_DURATIONS,
      circuitBreakers: [],
      githubStateFetchFailures: [
        {
          repo: 'acme/app',
          failures: 3,
          lastError: 'Could not resolve to a Repository',
          lastAtMs: 1_700_000_000_000,
        },
        {
          repo: 'octo/widgets',
          failures: 1,
          lastError: 'gh exited 1',
          lastAtMs: 1_700_000_000_100,
        },
      ],
    });

    expect(output).toContain(
      '# HELP kookr_github_state_fetch_failures_total Total non-rate-limit GitHub state-batch fetch failures by repository.',
    );
    expect(output).toContain('# TYPE kookr_github_state_fetch_failures_total counter');
    expect(output).toContain('kookr_github_state_fetch_failures_total{repo="acme/app"} 3');
    expect(output).toContain('kookr_github_state_fetch_failures_total{repo="octo/widgets"} 1');
    // Diagnostic fields stay off the scrape surface (labels + counter only).
    expect(output).not.toContain('lastError');
    expect(output).not.toContain('Could not resolve');
  });

  test('emits GitHub state-fetch failure HELP/TYPE with no series when empty (issue #1946)', () => {
    const output = renderPrometheusExposition({
      requestDurations: EMPTY_REQUEST_DURATIONS,
      circuitBreakers: [],
      githubStateFetchFailures: [],
    });

    expect(output).toContain('# TYPE kookr_github_state_fetch_failures_total counter');
    expect(output).not.toMatch(/kookr_github_state_fetch_failures_total\{/);
  });

  test('renders terminalWrite saturation gauges (issue #1776)', () => {
    const output = renderPrometheusExposition({
      requestDurations: EMPTY_REQUEST_DURATIONS,
      circuitBreakers: [],
      terminalWrite: {
        pendingWriters: 2,
        maxPendingWriters: 5,
        writeTimeoutCount: 3,
        pendingWrites: 1,
        maxPendingWrites: 4,
      },
    });

    expect(output).toContain('# TYPE kookr_terminal_write_pending_writers gauge');
    expect(output).toContain('kookr_terminal_write_pending_writers 2');
    expect(output).toContain('kookr_terminal_write_max_pending_writers 5');
    expect(output).toContain('# TYPE kookr_terminal_write_timeouts_total counter');
    expect(output).toContain('kookr_terminal_write_timeouts_total 3');
    expect(output).toContain('kookr_terminal_write_pending_writes 1');
    expect(output).toContain('kookr_terminal_write_max_pending_writes 4');
  });

  test('renders ring fleet budget pressure gauges (issue #1779)', () => {
    const output = renderPrometheusExposition({
      requestDurations: EMPTY_REQUEST_DURATIONS,
      circuitBreakers: [],
      ringFleetBudget: {
        ringFleetBytes: 2_097_152,
        ringFleetBudgetBytes: 1_048_576,
        ringFleetOverBudgetBytes: 65_536,
        ringShrunkenSessions: 3,
        ringShrinkCount: 5,
      },
    });

    expect(output).toContain('# TYPE kookr_ring_fleet_bytes gauge');
    expect(output).toContain('kookr_ring_fleet_bytes 2097152');
    expect(output).toContain('kookr_ring_fleet_budget_bytes 1048576');
    expect(output).toContain('kookr_ring_fleet_over_budget_bytes 65536');
    expect(output).toContain('kookr_ring_shrunken_sessions 3');
    expect(output).toContain('# TYPE kookr_ring_shrink_events_total counter');
    expect(output).toContain('kookr_ring_shrink_events_total 5');
  });

  test('renders zeroed ring fleet budget gauges when snapshot omitted (issue #1779)', () => {
    const output = renderPrometheusExposition({
      requestDurations: EMPTY_REQUEST_DURATIONS,
      circuitBreakers: [],
    });
    expect(output).toContain('kookr_ring_fleet_bytes 0');
    expect(output).toContain('kookr_ring_fleet_budget_bytes 0');
    expect(output).toContain('kookr_ring_shrink_events_total 0');
  });

  test('renders terminal input RTT quantiles (seconds) and observation count (issue #1773)', () => {
    const output = renderPrometheusExposition({
      requestDurations: EMPTY_REQUEST_DURATIONS,
      circuitBreakers: [],
      terminalInputRtt: {
        schemaVersion: 'terminal-input-rtt-metrics.v1',
        maxSamples: 512,
        count: 42,
        sampleCount: 42,
        p50Ms: 3.5,
        p95Ms: 18,
        p99Ms: 2000,
      },
    });

    // Snapshot is milliseconds; exposition converts to Prometheus base-unit seconds.
    expect(output).toContain('# TYPE kookr_terminal_input_rtt_seconds gauge');
    expect(output).toContain('kookr_terminal_input_rtt_seconds{quantile="0.5"} 0.0035');
    expect(output).toContain('kookr_terminal_input_rtt_seconds{quantile="0.95"} 0.018');
    expect(output).toContain('kookr_terminal_input_rtt_seconds{quantile="0.99"} 2');
    expect(output).toContain('# TYPE kookr_terminal_input_rtt_observations_total counter');
    expect(output).toContain('kookr_terminal_input_rtt_observations_total 42');
  });

  test('renders zeroed terminal input RTT metrics when the snapshot is absent (issue #1773)', () => {
    const output = renderPrometheusExposition({
      requestDurations: EMPTY_REQUEST_DURATIONS,
      circuitBreakers: [],
    });

    expect(output).toContain('kookr_terminal_input_rtt_seconds{quantile="0.5"} 0');
    expect(output).toContain('kookr_terminal_input_rtt_seconds{quantile="0.95"} 0');
    expect(output).toContain('kookr_terminal_input_rtt_seconds{quantile="0.99"} 0');
    expect(output).toContain('kookr_terminal_input_rtt_observations_total 0');
  });

  test('renders task-save timing gauges (issue #1777)', () => {
    const output = renderPrometheusExposition({
      requestDurations: EMPTY_REQUEST_DURATIONS,
      circuitBreakers: [],
      taskSave: {
        schemaVersion: 'task-save-metrics.v1',
        maxSamples: 64,
        sampleCount: 12,
        totalObservations: 40,
        p95SerializeMs: 25,
        p95WriteMs: 80,
        p95TotalMs: 100,
        last: {
          serializeMs: 12,
          writeMs: 45,
          totalMs: 57,
          bytes: 42_000_000,
          taskCount: 180,
          relationCount: 4,
          backend: 'json',
        },
      },
    });

    expect(output).toContain('# TYPE kookr_task_save_observations_total counter');
    expect(output).toContain('kookr_task_save_observations_total 40');
    expect(output).toContain('# TYPE kookr_task_save_sample_count gauge');
    expect(output).toContain('kookr_task_save_sample_count 12');
    expect(output).toContain('kookr_task_save_duration_seconds{phase="serialize",quantile="0.95"} 0.025');
    expect(output).toContain('kookr_task_save_duration_seconds{phase="write",quantile="0.95"} 0.08');
    expect(output).toContain('kookr_task_save_duration_seconds{phase="total",quantile="0.95"} 0.1');
    expect(output).toContain('kookr_task_save_last_bytes 42000000');
    expect(output).toContain('kookr_task_save_last_task_count 180');
    expect(output).toContain('kookr_task_save_last_duration_seconds{phase="serialize"} 0.012');
    expect(output).toContain('kookr_task_save_last_duration_seconds{phase="write"} 0.045');
    expect(output).toContain('kookr_task_save_last_duration_seconds{phase="total"} 0.057');
  });

  test('renders zeroed task-save gauges when no samples have been recorded', () => {
    const output = renderPrometheusExposition({
      requestDurations: EMPTY_REQUEST_DURATIONS,
      circuitBreakers: [],
    });

    expect(output).toContain('kookr_task_save_observations_total 0');
    expect(output).toContain('kookr_task_save_sample_count 0');
    expect(output).toContain('kookr_task_save_last_bytes 0');
    expect(output).toContain('kookr_task_save_duration_seconds{phase="serialize",quantile="0.95"} 0');
  });

  test('renders non-critical timer pause gauges and pause counter (issue #1785)', () => {
    const output = renderPrometheusExposition({
      requestDurations: EMPTY_REQUEST_DURATIONS,
      circuitBreakers: [],
      nonCriticalTimerPause: {
        paused: true,
        thresholdMs: 1_500,
        lastEventLoopDelayP95Ms: 2_400,
        pausedTicksTotal: 7,
      },
    });

    expect(output).toContain('# TYPE kookr_non_critical_timer_pause_active gauge');
    expect(output).toContain('kookr_non_critical_timer_pause_active 1');
    expect(output).toContain('kookr_non_critical_timer_pause_threshold_ms 1500');
    expect(output).toContain('kookr_non_critical_timer_pause_last_event_loop_delay_p95_ms 2400');
    expect(output).toContain('# TYPE kookr_non_critical_timer_pauses_total counter');
    expect(output).toContain('kookr_non_critical_timer_pauses_total 7');
  });

  test('renders non-critical timer pause zeros when omitted (always-visible defaults)', () => {
    const output = renderPrometheusExposition({
      requestDurations: EMPTY_REQUEST_DURATIONS,
      circuitBreakers: [],
    });
    expect(output).toContain('kookr_non_critical_timer_pause_active 0');
    expect(output).toContain('kookr_non_critical_timer_pauses_total 0');
    expect(output).toContain('kookr_non_critical_timer_pause_last_event_loop_delay_p95_ms -1');
  });

  test('renders snapshot shed counter and gauges (issue #1775)', () => {
    const output = renderPrometheusExposition({
      requestDurations: EMPTY_REQUEST_DURATIONS,
      circuitBreakers: [],
      snapshotShed: {
        thresholdMs: 1_500,
        lastEventLoopDelayP95Ms: 2_400,
        shedTotal: 11,
        gateShedTotal: 4,
      },
    });

    expect(output).toContain('# TYPE kookr_snapshot_shed_total counter');
    expect(output).toContain('kookr_snapshot_shed_total 11');
    // #2409: gate-driven sheds are attributed separately from p95-driven ones.
    expect(output).toContain('# TYPE kookr_snapshot_shed_gate_total counter');
    expect(output).toContain('kookr_snapshot_shed_gate_total 4');
    expect(output).toContain('kookr_snapshot_shed_threshold_ms 1500');
    expect(output).toContain('kookr_snapshot_shed_last_event_loop_delay_p95_ms 2400');
  });

  test('renders snapshot shed zeros when omitted (always-visible defaults)', () => {
    const output = renderPrometheusExposition({
      requestDurations: EMPTY_REQUEST_DURATIONS,
      circuitBreakers: [],
    });
    expect(output).toContain('kookr_snapshot_shed_total 0');
    expect(output).toContain('kookr_snapshot_shed_gate_total 0');
    expect(output).toContain('kookr_snapshot_shed_threshold_ms 0');
    expect(output).toContain('kookr_snapshot_shed_last_event_loop_delay_p95_ms -1');
  });

  test('renders snapshot shed gate counter as 0 when the field is absent (pre-#2409 producer)', () => {
    const output = renderPrometheusExposition({
      requestDurations: EMPTY_REQUEST_DURATIONS,
      circuitBreakers: [],
      snapshotShed: {
        thresholdMs: 1_500,
        lastEventLoopDelayP95Ms: 2_400,
        shedTotal: 11,
      },
    });
    expect(output).toContain('kookr_snapshot_shed_gate_total 0');
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

  test('renders capacity ledger gauges with fixed byClass labels (issue #1856)', () => {
    const output = renderPrometheusExposition({
      requestDurations: EMPTY_REQUEST_DURATIONS,
      circuitBreakers: [],
      capacity: {
        maxActiveTasks: 12,
        active: 5,
        free: 7,
        byClass: {
          working: 2,
          finishedAwaitingAck: 1,
          hungSuspect: 1,
          launching: 1,
        },
        finishedAwaitingAckByCause: {
          awaiting_poll: 0,
          ack_sweep_backlog: 1,
          manual_review_gate: 0,
          auto_close_disabled: 0,
        },
        effectiveWorking: 3,
        phantomActive: 2,
        pendingQueueDepth: 3,
        oldestPendingAgeMs: 45_000,
        oldestFinishedAwaitingAckAgeMs: 120_000,
      },
    });

    expect(output).toContain('# TYPE kookr_capacity_active gauge');
    expect(output).toContain('kookr_capacity_active 5');
    expect(output).toContain('kookr_capacity_free 7');
    expect(output).toContain('kookr_capacity_max 12');
    expect(output).toContain('kookr_capacity_effective_working 3');
    expect(output).toContain('kookr_capacity_phantom_active 2');
    expect(output).toContain('# TYPE kookr_capacity_by_class gauge');
    expect(output).toContain('kookr_capacity_by_class{class="working"} 2');
    expect(output).toContain('kookr_capacity_by_class{class="finishedAwaitingAck"} 1');
    expect(output).toContain('kookr_capacity_by_class{class="hungSuspect"} 1');
    expect(output).toContain('kookr_capacity_by_class{class="launching"} 1');
    expect(output).toContain('# TYPE kookr_capacity_finished_awaiting_ack_by_cause gauge');
    expect(output).toContain('kookr_capacity_finished_awaiting_ack_by_cause{cause="ack_sweep_backlog"} 1');
    expect(output).toContain('kookr_capacity_finished_awaiting_ack_by_cause{cause="awaiting_poll"} 0');
    expect(output).toContain('kookr_capacity_finished_awaiting_ack_by_cause{cause="manual_review_gate"} 0');
    expect(output).toContain('kookr_capacity_finished_awaiting_ack_by_cause{cause="auto_close_disabled"} 0');
    expect(output).toContain('kookr_capacity_pending_queue_depth 3');
    expect(output).toContain('kookr_capacity_oldest_pending_age_seconds 45');
    expect(output).toContain('kookr_capacity_oldest_finished_awaiting_ack_age_seconds 120');
  });

  test('renders zeroed capacity gauges with -1 ages when snapshot omitted (issue #1856)', () => {
    const output = renderPrometheusExposition({
      requestDurations: EMPTY_REQUEST_DURATIONS,
      circuitBreakers: [],
    });
    expect(output).toContain('kookr_capacity_active 0');
    expect(output).toContain('kookr_capacity_free 0');
    expect(output).toContain('kookr_capacity_max 0');
    expect(output).toContain('kookr_capacity_by_class{class="working"} 0');
    expect(output).toContain('kookr_capacity_by_class{class="finishedAwaitingAck"} 0');
    expect(output).toContain('kookr_capacity_by_class{class="hungSuspect"} 0');
    expect(output).toContain('kookr_capacity_by_class{class="launching"} 0');
    expect(output).toContain('kookr_capacity_finished_awaiting_ack_by_cause{cause="ack_sweep_backlog"} 0');
    expect(output).toContain('kookr_capacity_finished_awaiting_ack_by_cause{cause="awaiting_poll"} 0');
    expect(output).toContain('kookr_capacity_pending_queue_depth 0');
    expect(output).toContain('kookr_capacity_oldest_pending_age_seconds -1');
    expect(output).toContain('kookr_capacity_oldest_finished_awaiting_ack_age_seconds -1');
  });

  test('renders lesson-yield gauges from an injected warm snapshot (issue #1857)', () => {
    const output = renderPrometheusExposition({
      requestDurations: EMPTY_REQUEST_DURATIONS,
      circuitBreakers: [],
      lessonYield: {
        schemaVersion: 'lesson-yield.v1',
        generatedAt: '2026-08-01T12:00:00.000Z',
        windowDays: 1,
        windowStartMs: 0,
        tasksInWindow: 20,
        completedInWindow: 10,
        completedWithLogs: 8,
        buckets: {
          wroteLesson: 4,
          explicitSkip: 3,
          searchOnly: 1,
          noKbActivity: 2,
        },
        decided: 7,
        yieldRate: 0.7,
        yieldRateAmongLogged: 0.875,
        byCompletionPath: {},
        gateExemptReasons: {},
        explainedExceptions: 0,
        contractRate: 0.7,
      },
    });

    expect(output).toContain('# TYPE kookr_lesson_yield_decided gauge');
    expect(output).toContain('kookr_lesson_yield_decided 7');
    expect(output).toContain('kookr_lesson_yield_completed 10');
    expect(output).toContain('kookr_lesson_yield_wrote_lesson 4');
    expect(output).toContain('kookr_lesson_yield_explicit_skip 3');
    expect(output).toContain('kookr_lesson_yield_no_kb_activity 2');
    expect(output).toContain('kookr_lesson_yield_ratio 0.7');
  });

  test('omits lesson-yield series when cache is cold (issue #1857)', () => {
    const output = renderPrometheusExposition({
      requestDurations: EMPTY_REQUEST_DURATIONS,
      circuitBreakers: [],
    });
    expect(output).not.toContain('kookr_lesson_yield_');
  });

  test('renders health-body cache gauges in seconds (issue #2497)', () => {
    const output = renderPrometheusExposition({
      requestDurations: EMPTY_REQUEST_DURATIONS,
      circuitBreakers: [],
      healthBodyCache: { assemblyMs: 42, cacheAgeMs: 1_250 },
    });
    expect(output).toContain('# TYPE kookr_health_body_assembly_seconds gauge');
    expect(output).toContain('kookr_health_body_assembly_seconds 0.042');
    expect(output).toContain('# TYPE kookr_health_body_cache_age_seconds gauge');
    // Age can exceed the 1s TTL during a stale-while-revalidate refresh (#2492).
    expect(output).toContain('kookr_health_body_cache_age_seconds 1.25');
  });

  test('omits health-body cache series when cache is cold (issue #2497)', () => {
    const output = renderPrometheusExposition({
      requestDurations: EMPTY_REQUEST_DURATIONS,
      circuitBreakers: [],
    });
    expect(output).not.toContain('kookr_health_body_');
  });
});

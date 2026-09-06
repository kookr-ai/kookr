import type { CircuitBreakerSnapshot, CircuitBreakerState } from '../core/circuit-breaker.js';
import {
  ATTENTION_QUEUE_SUPPRESSION_REASONS,
  type AttentionQueueSuppressionCounts,
} from '../core/attention-queue.js';
import {
  WEBHOOK_DELIVERY_OUTCOMES,
  type WebhookDeliveryCounts,
} from '../integrations/webhook/index.js';
import type { AuthThrottleSnapshot } from './auth-throttle.js';
import type { RequestDurationMetricsSnapshot } from './request-duration-metrics.js';
import type { ControlPlaneLatencyMetricsSnapshot } from './control-plane-latency-metrics.js';
import {
  EMPTY_TERMINAL_INPUT_RTT_SNAPSHOT,
  type TerminalInputRttMetricsSnapshot,
} from './terminal-input-rtt-metrics.js';
import type { ToolLatencyMetricsSnapshot } from '../core/tool-latency-metrics.js';
import { emptyToolLatencyMetricsSnapshot } from '../core/tool-latency-metrics.js';
import type { TaskSaveMetricsSnapshot } from '../core/task-save-metrics.js';
import { emptyTaskSaveMetricsSnapshot } from '../core/task-save-metrics.js';
import {
  TASK_CAPACITY_CLASSES,
  type CapacityLedger,
} from '../core/capacity-ledger.js';
import { FAA_ROOT_CAUSES } from '../core/faa-root-cause.js';
import type { LessonYieldSnapshot } from '../core/lesson-decision.js';
import type { GitHubStateFetchFailureSnapshotEntry } from '../adapters/github-fetcher.js';
import type { IdempotencyLedgerMetrics } from '../core/idempotency-ledger.js';

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4';

/** Terminal write-path saturation gauges (issue #1776). */
export interface TerminalWriteMetricsSnapshot {
  pendingWriters: number;
  maxPendingWriters: number;
  writeTimeoutCount: number;
  pendingWrites: number;
  maxPendingWrites: number;
}

/** Fleet-wide ring buffer memory budget gauges (issue #1779). */
export interface RingFleetBudgetMetricsSnapshot {
  ringFleetBytes: number;
  ringFleetBudgetBytes: number;
  ringFleetOverBudgetBytes: number;
  ringShrunkenSessions: number;
  ringShrinkCount: number;
}

/** Non-critical timer pause gauges/counters (issue #1785). */
export interface NonCriticalTimerPauseMetricsSnapshot {
  paused: boolean;
  thresholdMs: number;
  lastEventLoopDelayP95Ms: number | null;
  pausedTicksTotal: number;
}

/** Full-snapshot rebuild shed counter (issue #1775). */
export interface SnapshotShedMetricsExposition {
  thresholdMs: number;
  lastEventLoopDelayP95Ms: number | null;
  shedTotal: number;
  /** Subset of `shedTotal` caused by the #1725 load-shed gate (issue #2409). */
  gateShedTotal?: number;
}

export interface PrometheusExpositionSnapshot {
  requestDurations: RequestDurationMetricsSnapshot;
  /**
   * Control-plane probe latency + completion status (issue #2774) for
   * `/api/health`, health subroutes, and `/api/ready`. When undefined (metrics
   * not wired) the series are omitted so scrapers see no fabricated zeros.
   */
  controlPlaneLatencies?: ControlPlaneLatencyMetricsSnapshot;
  circuitBreakers: CircuitBreakerSnapshot[];
  toolLatencies?: ToolLatencyMetricsSnapshot;
  attentionQueueSuppressions?: AttentionQueueSuppressionCounts;
  auditSinks?: AuditSinkMetricsSnapshot[];
  authThrottle?: AuthThrottleSnapshot;
  webhookDeliveries?: WebhookDeliveryCounts;
  terminalWrite?: TerminalWriteMetricsSnapshot;
  terminalInputRtt?: TerminalInputRttMetricsSnapshot;
  /** Always-on tasks.json / tasks.sqlite save timing (issue #1777). */
  taskSave?: TaskSaveMetricsSnapshot;
  nonCriticalTimerPause?: NonCriticalTimerPauseMetricsSnapshot;
  /** Non-critical full-snapshot rebuilds skipped under loop saturation (#1775). */
  snapshotShed?: SnapshotShedMetricsExposition;
  /** Fleet ring buffer budget pressure (issue #1779) — always-on zeros. */
  ringFleetBudget?: RingFleetBudgetMetricsSnapshot;
  /**
   * Task capacity ledger gauges (issue #1856). Same shape as `/api/health`
   * `capacity` so scrapers can alert on hungSuspect / finishedAwaitingAck /
   * pendingQueueDepth without polling JSON health.
   */
  capacity?: CapacityLedger;
  /**
   * Last warm 24h lesson-yield snapshot (issue #1857). When undefined (cache
   * cold), series are omitted so scrapers stay fast and never trigger a
   * hook-log scan. Same fields as `/api/health` `lessonYield`.
   */
  lessonYield?: LessonYieldSnapshot;
  /** Idempotency replay-retention count and compaction counters (issue #2763). */
  idempotencyLedger?: IdempotencyLedgerMetrics;
  /**
   * `/api/health` body-cache timing gauges (issue #2497): the last full
   * assembly duration and the current cached body's age. When undefined (cache
   * cold — never assembled) the series are omitted. Same values `/api/health`
   * reports as `healthAssemblyMs` / `healthCacheAgeMs`.
   */
  healthBodyCache?: { assemblyMs: number; cacheAgeMs: number };
  /**
   * finishedAwaitingAck TTL reclaim counters (issues #1884 / #2070 / #2084).
   * Cumulative reclaimed + skip-reason breakdown since process start. Omitted
   * only in harnesses that never wire the sweep.
   */
  finishedAwaitingAckReclaim?: {
    reclaimedTotal: number;
    reclaimAttempted?: number;
    reclaimSucceeded?: number;
    /** Soft-TTL capacity-pressure reclaim subset of reclaimedTotal (issue #2355). */
    capacityPressureEarlyReclaimedTotal?: number;
    skippedBadRaisedAt?: number;
    skippedOpenPrFailsafe?: number;
    skippedOpenPrConfirmed?: number;
    skippedOpenPrUnknown?: number;
    skippedUnderTtl?: number;
    autoCompletedTotal?: number;
    autoCompleteDeferredTotal?: number;
    /** Strict/soft/capacity-pressure reclaims deferred by the live-turn/pane veto (issue #3040). */
    reclaimDeferredTotal?: number;
    autoCompleteAgeHistogram?: Record<string, number>;
  };
  /**
   * hungSuspect TTL reclaim counters (issues #1935 / #2045). Cumulative
   * reclaimed + skip-reason breakdown since process start. Omitted only in
   * harnesses that never wire the sweep.
   */
  hungSuspectReclaim?: {
    reclaimedTotal: number;
    reclaimAttempted?: number;
    reclaimSucceeded?: number;
    skippedNoLiveness?: number;
    skippedOpenPrFailsafe?: number;
    skippedOpenPrConfirmed?: number;
    skippedOpenPrUnknown?: number;
    skippedUnderTtl?: number;
    skippedExemptAnomaly?: number;
    skippedProviderPaused?: number;
    /** Cumulative sweep passes that threw before completing (issue #2897). */
    sweepFailuresTotal?: number;
    /** Epoch-ms of the most recent sweep failure; null once cleared (issue #2897). */
    lastFailureAtMs?: number | null;
  };
  /**
   * provider_paused occupancy + hard-TTL reclaim (issue #2079). Live count
   * plus cumulative reclaim / skip-reason counters. Omitted when not wired.
   */
  providerPausedOccupancy?: {
    count: number;
    oldestPauseAgeMs?: number | null;
    reclaimedTotal: number;
    reclaimAttempted?: number;
    reclaimSucceeded?: number;
    skippedUnderTtl?: number;
    skippedOpenPrFailsafe?: number;
    skippedOpenPrConfirmed?: number;
    skippedOpenPrUnknown?: number;
    skippedNoPauseStart?: number;
    skippedAwaitingProviderReset?: number;
  };
  /**
   * First-hook miss counter (issue #2036). Cumulative post-spawn sessions
   * reaped for never emitting SessionStart / any agent hook. Omitted when
   * the reaper is not wired.
   */
  firstHookMiss?: { firstHookMissTotal: number };
  /**
   * Watchdog sweep fairness counters (issue #2770). Probe-timeout counters plus
   * last-sweep gauges (checked/skipped/duration, oldest-check age). Omitted when
   * the watchdog sweep metrics are not wired.
   */
  watchdogSweep?: import('./watchdog-sweep-metrics.js').WatchdogSweepMetricsSnapshot;
  /**
   * Per-repo GitHub state-fetch non-rate-limit failure counters (issue #1946).
   * Empty array / omitted → HELP/TYPE only (no series) so scrapers see the
   * family without fabricated zero-label series.
   */
  githubStateFetchFailures?: GitHubStateFetchFailureSnapshotEntry[];
}

export interface AuditSinkMetricsSnapshot {
  sink: string;
  writable: boolean;
  appendFailureCount: number;
}

export function renderPrometheusExposition(snapshot: PrometheusExpositionSnapshot): string {
  const lines: string[] = [];

  appendRequestDurationMetrics(lines, snapshot.requestDurations);
  appendControlPlaneLatencyMetrics(lines, snapshot.controlPlaneLatencies);
  appendToolLatencyMetrics(lines, snapshot.toolLatencies ?? emptyToolLatencyMetricsSnapshot());
  appendCircuitBreakerMetrics(lines, snapshot.circuitBreakers);
  appendAttentionQueueSuppressionMetrics(lines, snapshot.attentionQueueSuppressions);
  appendAuditSinkMetrics(lines, snapshot.auditSinks ?? []);
  appendAuthThrottleMetrics(lines, snapshot.authThrottle);
  appendWebhookDeliveryMetrics(lines, snapshot.webhookDeliveries);
  appendTerminalWriteMetrics(lines, snapshot.terminalWrite);
  appendTerminalInputRttMetrics(lines, snapshot.terminalInputRtt);
  appendTaskSaveMetrics(lines, snapshot.taskSave ?? emptyTaskSaveMetricsSnapshot());
  appendNonCriticalTimerPauseMetrics(lines, snapshot.nonCriticalTimerPause);
  appendSnapshotShedMetrics(lines, snapshot.snapshotShed);
  appendRingFleetBudgetMetrics(lines, snapshot.ringFleetBudget);
  appendCapacityMetrics(lines, snapshot.capacity);
  appendLessonYieldMetrics(lines, snapshot.lessonYield);
  appendIdempotencyLedgerMetrics(lines, snapshot.idempotencyLedger);
  appendHealthBodyCacheMetrics(lines, snapshot.healthBodyCache);
  appendFinishedAwaitingAckReclaimMetrics(lines, snapshot.finishedAwaitingAckReclaim);
  appendHungSuspectReclaimMetrics(lines, snapshot.hungSuspectReclaim);
  appendProviderPausedOccupancyMetrics(lines, snapshot.providerPausedOccupancy);
  appendFirstHookMissMetrics(lines, snapshot.firstHookMiss);
  appendWatchdogSweepMetrics(lines, snapshot.watchdogSweep);
  appendGitHubStateFetchMetrics(lines, snapshot.githubStateFetchFailures);

  return `${lines.join('\n')}\n`;
}

function appendIdempotencyLedgerMetrics(
  lines: string[],
  snapshot: IdempotencyLedgerMetrics | undefined,
): void {
  lines.push(
    '# HELP kookr_idempotency_ledger_entries Current finalized idempotency entries retained.',
    '# TYPE kookr_idempotency_ledger_entries gauge',
    metricLine('kookr_idempotency_ledger_entries', {}, snapshot?.entryCount ?? 0),
    '# HELP kookr_idempotency_ledger_pending Current in-flight idempotency reservations.',
    '# TYPE kookr_idempotency_ledger_pending gauge',
    metricLine('kookr_idempotency_ledger_pending', {}, snapshot?.pendingCount ?? 0),
    '# HELP kookr_idempotency_ledger_max_entries Configured maximum finalized idempotency entries.',
    '# TYPE kookr_idempotency_ledger_max_entries gauge',
    metricLine('kookr_idempotency_ledger_max_entries', {}, snapshot?.maxEntries ?? 0),
    '# HELP kookr_idempotency_ledger_ttl_seconds Configured idempotency replay-protection TTL in seconds.',
    '# TYPE kookr_idempotency_ledger_ttl_seconds gauge',
    metricLine('kookr_idempotency_ledger_ttl_seconds', {}, snapshot ? snapshot.ttlMs / 1000 : 0),
    '# HELP kookr_idempotency_ledger_expired_total Total finalized entries removed after TTL expiry.',
    '# TYPE kookr_idempotency_ledger_expired_total counter',
    metricLine('kookr_idempotency_ledger_expired_total', {}, snapshot?.expiredTotal ?? 0),
    '# HELP kookr_idempotency_ledger_evicted_total Total finalized entries removed by the size bound.',
    '# TYPE kookr_idempotency_ledger_evicted_total counter',
    metricLine('kookr_idempotency_ledger_evicted_total', {}, snapshot?.evictedTotal ?? 0),
  );
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

function appendControlPlaneLatencyMetrics(
  lines: string[],
  snapshot: ControlPlaneLatencyMetricsSnapshot | undefined,
): void {
  // Omit the whole family when metrics are unwired (cold) so scrapers never see
  // fabricated zero-label series for control-plane probes.
  if (!snapshot) return;

  lines.push(
    '# HELP kookr_control_plane_probe_observations_total Total recorded control-plane probe observations by route template.',
    '# TYPE kookr_control_plane_probe_observations_total counter',
  );
  for (const route of snapshot.routes) {
    lines.push(metricLine('kookr_control_plane_probe_observations_total', {
      method: route.method,
      route: route.route,
    }, route.count));
  }

  lines.push(
    '# HELP kookr_control_plane_probe_sample_count Number of retained control-plane probe duration samples by route template.',
    '# TYPE kookr_control_plane_probe_sample_count gauge',
  );
  for (const route of snapshot.routes) {
    lines.push(metricLine('kookr_control_plane_probe_sample_count', {
      method: route.method,
      route: route.route,
    }, route.sampleCount));
  }

  lines.push(
    '# HELP kookr_control_plane_probe_errors_total Control-plane probe responses with an HTTP status >= 400 by route template.',
    '# TYPE kookr_control_plane_probe_errors_total counter',
  );
  for (const route of snapshot.routes) {
    lines.push(metricLine('kookr_control_plane_probe_errors_total', {
      method: route.method,
      route: route.route,
    }, route.errorCount));
  }

  lines.push(
    `# HELP kookr_control_plane_probe_slow_total Control-plane probe observations at or above the ${snapshot.slowThresholdMs}ms slow threshold by route template.`,
    '# TYPE kookr_control_plane_probe_slow_total counter',
  );
  for (const route of snapshot.routes) {
    lines.push(metricLine('kookr_control_plane_probe_slow_total', {
      method: route.method,
      route: route.route,
    }, route.slowCount));
  }

  lines.push(
    '# HELP kookr_control_plane_probe_duration_seconds Control-plane probe duration quantiles by route template.',
    '# TYPE kookr_control_plane_probe_duration_seconds gauge',
  );
  for (const route of snapshot.routes) {
    const baseLabels = { method: route.method, route: route.route };
    lines.push(
      metricLine('kookr_control_plane_probe_duration_seconds', { ...baseLabels, quantile: '0.5' }, msToSeconds(route.p50Ms)),
      metricLine('kookr_control_plane_probe_duration_seconds', { ...baseLabels, quantile: '0.95' }, msToSeconds(route.p95Ms)),
      metricLine('kookr_control_plane_probe_duration_seconds', { ...baseLabels, quantile: '0.99' }, msToSeconds(route.p99Ms)),
    );
  }

  lines.push(
    '# HELP kookr_control_plane_probe_dropped_routes_total Total control-plane route templates dropped after the probe route limit was reached.',
    '# TYPE kookr_control_plane_probe_dropped_routes_total counter',
    metricLine('kookr_control_plane_probe_dropped_routes_total', {}, snapshot.droppedRouteCount),
  );
}

function appendToolLatencyMetrics(lines: string[], snapshot: ToolLatencyMetricsSnapshot): void {
  lines.push(
    '# HELP kookr_tool_duration_observations_total Total recorded PreToolUse→PostToolUse observations by tool name.',
    '# TYPE kookr_tool_duration_observations_total counter',
  );
  for (const tool of snapshot.tools) {
    lines.push(metricLine('kookr_tool_duration_observations_total', {
      tool: tool.toolName,
    }, tool.count));
  }

  lines.push(
    '# HELP kookr_tool_duration_sample_count Number of retained tool-duration samples by tool name.',
    '# TYPE kookr_tool_duration_sample_count gauge',
  );
  for (const tool of snapshot.tools) {
    lines.push(metricLine('kookr_tool_duration_sample_count', {
      tool: tool.toolName,
    }, tool.sampleCount));
  }

  lines.push(
    '# HELP kookr_tool_duration_seconds Tool-duration quantiles by tool name (PreToolUse→PostToolUse).',
    '# TYPE kookr_tool_duration_seconds gauge',
  );
  for (const tool of snapshot.tools) {
    const baseLabels = { tool: tool.toolName };
    lines.push(
      metricLine('kookr_tool_duration_seconds', { ...baseLabels, quantile: '0.5' }, msToSeconds(tool.p50Ms)),
      metricLine('kookr_tool_duration_seconds', { ...baseLabels, quantile: '0.95' }, msToSeconds(tool.p95Ms)),
      metricLine('kookr_tool_duration_seconds', { ...baseLabels, quantile: '0.99' }, msToSeconds(tool.p99Ms)),
    );
  }

  lines.push(
    '# HELP kookr_tool_duration_dropped_tools_total Total tool names dropped after the tool-latency tool limit was reached.',
    '# TYPE kookr_tool_duration_dropped_tools_total counter',
    metricLine('kookr_tool_duration_dropped_tools_total', {}, snapshot.droppedToolCount),
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

const EMPTY_WEBHOOK_DELIVERIES: WebhookDeliveryCounts = {
  success: 0,
  failed: 0,
  dropped: 0,
};

function appendWebhookDeliveryMetrics(
  lines: string[],
  counts: WebhookDeliveryCounts = EMPTY_WEBHOOK_DELIVERIES,
): void {
  lines.push(
    '# HELP kookr_webhook_deliveries_total Total outbound finding-webhook delivery outcomes by result.',
    '# TYPE kookr_webhook_deliveries_total counter',
  );
  for (const outcome of WEBHOOK_DELIVERY_OUTCOMES) {
    lines.push(metricLine('kookr_webhook_deliveries_total', { outcome }, counts[outcome]));
  }
}

const EMPTY_TERMINAL_WRITE: TerminalWriteMetricsSnapshot = {
  pendingWriters: 0,
  maxPendingWriters: 0,
  writeTimeoutCount: 0,
  pendingWrites: 0,
  maxPendingWrites: 0,
};

const EMPTY_RING_FLEET_BUDGET: RingFleetBudgetMetricsSnapshot = {
  ringFleetBytes: 0,
  ringFleetBudgetBytes: 0,
  ringFleetOverBudgetBytes: 0,
  ringShrunkenSessions: 0,
  ringShrinkCount: 0,
};

function appendTerminalWriteMetrics(
  lines: string[],
  snapshot: TerminalWriteMetricsSnapshot = EMPTY_TERMINAL_WRITE,
): void {
  lines.push(
    '# HELP kookr_terminal_write_pending_writers Current callers queued or executing under a session writeMutex.',
    '# TYPE kookr_terminal_write_pending_writers gauge',
    metricLine('kookr_terminal_write_pending_writers', {}, snapshot.pendingWriters),
    '# HELP kookr_terminal_write_max_pending_writers High-water mark of writeMutex queue depth since process start.',
    '# TYPE kookr_terminal_write_max_pending_writers gauge',
    metricLine('kookr_terminal_write_max_pending_writers', {}, snapshot.maxPendingWriters),
    '# HELP kookr_terminal_write_timeouts_total Total WriteTimeoutError events from the terminal write path.',
    '# TYPE kookr_terminal_write_timeouts_total counter',
    metricLine('kookr_terminal_write_timeouts_total', {}, snapshot.writeTimeoutCount),
    '# HELP kookr_terminal_write_pending_writes Current in-flight TerminalInputCoordinator writes across sessions.',
    '# TYPE kookr_terminal_write_pending_writes gauge',
    metricLine('kookr_terminal_write_pending_writes', {}, snapshot.pendingWrites),
    '# HELP kookr_terminal_write_max_pending_writes High-water mark of coordinator pendingWrites since process start.',
    '# TYPE kookr_terminal_write_max_pending_writes gauge',
    metricLine('kookr_terminal_write_max_pending_writes', {}, snapshot.maxPendingWrites),
  );
}

function appendRingFleetBudgetMetrics(
  lines: string[],
  snapshot: RingFleetBudgetMetricsSnapshot = EMPTY_RING_FLEET_BUDGET,
): void {
  lines.push(
    '# HELP kookr_ring_fleet_bytes Sum of live session ring buffer capacities in bytes.',
    '# TYPE kookr_ring_fleet_bytes gauge',
    metricLine('kookr_ring_fleet_bytes', {}, snapshot.ringFleetBytes),
    '# HELP kookr_ring_fleet_budget_bytes Configured fleet ring capacity budget (0 = unlimited).',
    '# TYPE kookr_ring_fleet_budget_bytes gauge',
    metricLine('kookr_ring_fleet_budget_bytes', {}, snapshot.ringFleetBudgetBytes),
    '# HELP kookr_ring_fleet_over_budget_bytes Bytes of ring capacity above the fleet budget after shrink.',
    '# TYPE kookr_ring_fleet_over_budget_bytes gauge',
    metricLine('kookr_ring_fleet_over_budget_bytes', {}, snapshot.ringFleetOverBudgetBytes),
    '# HELP kookr_ring_shrunken_sessions Sessions currently holding a sub-full ring capacity.',
    '# TYPE kookr_ring_shrunken_sessions gauge',
    metricLine('kookr_ring_shrunken_sessions', {}, snapshot.ringShrunkenSessions),
    '# HELP kookr_ring_shrink_events_total Cumulative ring shrink events under fleet budget pressure.',
    '# TYPE kookr_ring_shrink_events_total counter',
    metricLine('kookr_ring_shrink_events_total', {}, snapshot.ringShrinkCount),
  );
}

const EMPTY_CAPACITY: CapacityLedger = {
  maxActiveTasks: 0,
  active: 0,
  free: 0,
  byClass: {
    working: 0,
    finishedAwaitingAck: 0,
    hungSuspect: 0,
    launching: 0,
  },
  finishedAwaitingAckByCause: {
    awaiting_poll: 0,
    ack_sweep_backlog: 0,
    manual_review_gate: 0,
    auto_close_disabled: 0,
  },
  effectiveWorking: 0,
  phantomActive: 0,
  utilizationPct: 0,
  effectiveUtilizationPct: 0,
  pendingQueueDepth: 0,
  oldestPendingAgeMs: null,
  oldestFinishedAwaitingAckAgeMs: null,
};

/** Task capacity ledger gauges for Prometheus scrapes (issue #1856). */
function appendCapacityMetrics(
  lines: string[],
  snapshot: CapacityLedger = EMPTY_CAPACITY,
): void {
  lines.push(
    '# HELP kookr_capacity_active Tasks currently occupying a concurrency slot (all capacity classes).',
    '# TYPE kookr_capacity_active gauge',
    metricLine('kookr_capacity_active', {}, snapshot.active),
    '# HELP kookr_capacity_free Free concurrency slots (maxActiveTasks - active, floored at 0).',
    '# TYPE kookr_capacity_free gauge',
    metricLine('kookr_capacity_free', {}, snapshot.free),
    '# HELP kookr_capacity_max Configured max active tasks (settings.maxActiveTasks).',
    '# TYPE kookr_capacity_max gauge',
    metricLine('kookr_capacity_max', {}, snapshot.maxActiveTasks),
    // Productive vs phantom split (issue #1935) — scrapers can alert on
    // phantom occupancy without re-deriving hungSuspect + FAA from by_class.
    '# HELP kookr_capacity_effective_working Productive occupancy (working + launching); excludes hungSuspect / finishedAwaitingAck phantoms.',
    '# TYPE kookr_capacity_effective_working gauge',
    metricLine('kookr_capacity_effective_working', {}, snapshot.effectiveWorking),
    '# HELP kookr_capacity_phantom_active Phantom occupancy (hungSuspect + finishedAwaitingAck) holding slots without forward progress.',
    '# TYPE kookr_capacity_phantom_active gauge',
    metricLine('kookr_capacity_phantom_active', {}, snapshot.phantomActive),
    '# HELP kookr_capacity_by_class Tasks occupying a concurrency slot by capacity class (fixed TaskCapacityClass set).',
    '# TYPE kookr_capacity_by_class gauge',
  );
  for (const capacityClass of TASK_CAPACITY_CLASSES) {
    lines.push(metricLine('kookr_capacity_by_class', { class: capacityClass }, snapshot.byClass[capacityClass]));
  }
  // FAA root-cause breakdown (issue #2142): classifies WHY each
  // finishedAwaitingAck task's ack lags so a window of scraped data names the
  // dominant cause — instead of another symptom-plumbing PR. Sums to the
  // finishedAwaitingAck by_class gauge.
  lines.push(
    '# HELP kookr_capacity_finished_awaiting_ack_by_cause finishedAwaitingAck tasks by root cause (why the ack lags).',
    '# TYPE kookr_capacity_finished_awaiting_ack_by_cause gauge',
  );
  for (const cause of FAA_ROOT_CAUSES) {
    lines.push(
      metricLine('kookr_capacity_finished_awaiting_ack_by_cause', { cause }, snapshot.finishedAwaitingAckByCause[cause]),
    );
  }
  lines.push(
    '# HELP kookr_capacity_pending_queue_depth Tasks in status=pending waiting for a free concurrency slot.',
    '# TYPE kookr_capacity_pending_queue_depth gauge',
    metricLine('kookr_capacity_pending_queue_depth', {}, snapshot.pendingQueueDepth),
    // Ages as Prometheus base-unit seconds; -1 when no sample (matches other
    // kookr gauges that cannot express "absent" as a missing series).
    '# HELP kookr_capacity_oldest_pending_age_seconds Age of the oldest pending queued task in seconds; -1 when none.',
    '# TYPE kookr_capacity_oldest_pending_age_seconds gauge',
    metricLine(
      'kookr_capacity_oldest_pending_age_seconds',
      {},
      snapshot.oldestPendingAgeMs === null ? -1 : msToSeconds(snapshot.oldestPendingAgeMs),
    ),
    '# HELP kookr_capacity_oldest_finished_awaiting_ack_age_seconds Age of the oldest finishedAwaitingAck signal in seconds; -1 when none.',
    '# TYPE kookr_capacity_oldest_finished_awaiting_ack_age_seconds gauge',
    metricLine(
      'kookr_capacity_oldest_finished_awaiting_ack_age_seconds',
      {},
      snapshot.oldestFinishedAwaitingAckAgeMs === null
        ? -1
        : msToSeconds(snapshot.oldestFinishedAwaitingAckAgeMs),
    ),
  );
}

/**
 * First-hook miss counter (issue #2036). Omitted when the reaper is not wired.
 */
function appendFirstHookMissMetrics(
  lines: string[],
  snapshot: { firstHookMissTotal: number } | undefined,
): void {
  if (!snapshot) return;

  lines.push(
    '# HELP kookr_first_hook_miss_total Total post-spawn sessions reaped for never emitting SessionStart / any agent hook since process start.',
    '# TYPE kookr_first_hook_miss_total counter',
    metricLine('kookr_first_hook_miss_total', {}, snapshot.firstHookMissTotal),
  );
}

/**
 * Watchdog sweep fairness counters (issue #2770). Omitted when the sweep
 * metrics are not wired. Cumulative counters expose as Prometheus counters;
 * the last-sweep observations (checked/skipped/duration, oldest-check age,
 * tracked agents) expose as gauges.
 */
function appendWatchdogSweepMetrics(
  lines: string[],
  snapshot: import('./watchdog-sweep-metrics.js').WatchdogSweepMetricsSnapshot | undefined,
): void {
  if (!snapshot) return;

  lines.push(
    '# HELP kookr_watchdog_sweeps_total Completed watchdog sweeps since process start.',
    '# TYPE kookr_watchdog_sweeps_total counter',
    metricLine('kookr_watchdog_sweeps_total', {}, snapshot.sweepsTotal),
    '# HELP kookr_watchdog_agents_checked_total Cumulative agent health checks across all watchdog sweeps.',
    '# TYPE kookr_watchdog_agents_checked_total counter',
    metricLine('kookr_watchdog_agents_checked_total', {}, snapshot.agentsCheckedTotal),
    '# HELP kookr_watchdog_agents_skipped_total Cumulative agent checks deferred to a later tick because the sweep budget ran out.',
    '# TYPE kookr_watchdog_agents_skipped_total counter',
    metricLine('kookr_watchdog_agents_skipped_total', {}, snapshot.skippedTotal),
    '# HELP kookr_watchdog_probe_timeouts_total Watchdog external probes that hit their per-agent deadline, by probe kind.',
    '# TYPE kookr_watchdog_probe_timeouts_total counter',
    metricLine('kookr_watchdog_probe_timeouts_total', { kind: 'capture' }, snapshot.captureTimeoutsTotal),
    metricLine('kookr_watchdog_probe_timeouts_total', { kind: 'drain' }, snapshot.drainTimeoutsTotal),
    '# HELP kookr_watchdog_last_sweep_checked Agents checked in the most recent watchdog sweep.',
    '# TYPE kookr_watchdog_last_sweep_checked gauge',
    metricLine('kookr_watchdog_last_sweep_checked', {}, snapshot.lastSweepCheckedCount),
    '# HELP kookr_watchdog_last_sweep_skipped Agents deferred in the most recent watchdog sweep.',
    '# TYPE kookr_watchdog_last_sweep_skipped gauge',
    metricLine('kookr_watchdog_last_sweep_skipped', {}, snapshot.lastSweepSkippedCount),
    '# HELP kookr_watchdog_last_sweep_duration_ms Wall-clock duration of the most recent watchdog sweep, milliseconds.',
    '# TYPE kookr_watchdog_last_sweep_duration_ms gauge',
    metricLine('kookr_watchdog_last_sweep_duration_ms', {}, snapshot.lastSweepDurationMs),
    '# HELP kookr_watchdog_oldest_check_age_ms Oldest time-since-last-check across tracked agents at the most recent sweep, milliseconds.',
    '# TYPE kookr_watchdog_oldest_check_age_ms gauge',
    metricLine('kookr_watchdog_oldest_check_age_ms', {}, snapshot.oldestCheckAgeMs),
    '# HELP kookr_watchdog_tracked_agents Tracked agents observed at the start of the most recent watchdog sweep.',
    '# TYPE kookr_watchdog_tracked_agents gauge',
    metricLine('kookr_watchdog_tracked_agents', {}, snapshot.trackedAgents),
  );
}

/**
 * finishedAwaitingAck TTL reclaim + meta auto-complete counters (issues
 * #1884 / #2070). Omitted when the sweep is not wired (lightweight unit
 * harnesses) rather than emitting a fabricated zero series.
 */
/**
 * finishedAwaitingAck TTL reclaim counters (issues #1884 / #2070 / #2084).
 * Omitted when the sweep is not wired. Skip-reason series always emit when the
 * snapshot is present so scrapers can chart why reclaimedTotal stays flat.
 */
function appendFinishedAwaitingAckReclaimMetrics(
  lines: string[],
  snapshot:
    | {
        reclaimedTotal: number;
        reclaimAttempted?: number;
        reclaimSucceeded?: number;
        capacityPressureEarlyReclaimedTotal?: number;
        skippedBadRaisedAt?: number;
        skippedOpenPrFailsafe?: number;
        skippedOpenPrConfirmed?: number;
        skippedOpenPrUnknown?: number;
        skippedUnderTtl?: number;
        autoCompletedTotal?: number;
        autoCompleteDeferredTotal?: number;
        reclaimDeferredTotal?: number;
        autoCompleteAgeHistogram?: Record<string, number>;
      }
    | undefined,
): void {
  if (!snapshot) return;

  lines.push(
    '# HELP kookr_finished_awaiting_ack_ttl_reclaimed_total Total finishedAwaitingAck tasks force-completed by the TTL reclaim since process start.',
    '# TYPE kookr_finished_awaiting_ack_ttl_reclaimed_total counter',
    metricLine('kookr_finished_awaiting_ack_ttl_reclaimed_total', {}, snapshot.reclaimedTotal),
    '# HELP kookr_finished_awaiting_ack_ttl_reclaim_attempted_total Total finishedAwaitingAck candidates selected for reclaim (complete attempted) since process start.',
    '# TYPE kookr_finished_awaiting_ack_ttl_reclaim_attempted_total counter',
    metricLine(
      'kookr_finished_awaiting_ack_ttl_reclaim_attempted_total',
      {},
      snapshot.reclaimAttempted ?? 0,
    ),
    '# HELP kookr_finished_awaiting_ack_ttl_reclaim_succeeded_total Total successful finishedAwaitingAck TTL reclaim force-completes since process start.',
    '# TYPE kookr_finished_awaiting_ack_ttl_reclaim_succeeded_total counter',
    metricLine(
      'kookr_finished_awaiting_ack_ttl_reclaim_succeeded_total',
      {},
      snapshot.reclaimSucceeded ?? snapshot.reclaimedTotal,
    ),
    '# HELP kookr_finished_awaiting_ack_capacity_pressure_early_reclaimed_total finishedAwaitingAck tasks reclaimed under capacity-pressure soft TTL (issue #2355; subset of reclaimed_total).',
    '# TYPE kookr_finished_awaiting_ack_capacity_pressure_early_reclaimed_total counter',
    metricLine(
      'kookr_finished_awaiting_ack_capacity_pressure_early_reclaimed_total',
      {},
      snapshot.capacityPressureEarlyReclaimedTotal ?? 0,
    ),
  );

  // Keep the skip-reason block contiguous; the capacity-pressure counter sits
  // above it so hard vs soft reclaim is scannable next to reclaimed_total.
  lines.push(
    '# HELP kookr_finished_awaiting_ack_ttl_reclaim_skipped_total FinishedAwaitingAck TTL reclaim skips by reason (cumulative since process start; issue #2084 / #2228).',
    '# TYPE kookr_finished_awaiting_ack_ttl_reclaim_skipped_total counter',
    metricLine(
      'kookr_finished_awaiting_ack_ttl_reclaim_skipped_total',
      { reason: 'bad_raised_at' },
      snapshot.skippedBadRaisedAt ?? 0,
    ),
    metricLine(
      'kookr_finished_awaiting_ack_ttl_reclaim_skipped_total',
      { reason: 'open_pr_failsafe' },
      snapshot.skippedOpenPrFailsafe ?? 0,
    ),
    metricLine(
      'kookr_finished_awaiting_ack_ttl_reclaim_skipped_total',
      { reason: 'open_pr_confirmed' },
      snapshot.skippedOpenPrConfirmed ?? 0,
    ),
    metricLine(
      'kookr_finished_awaiting_ack_ttl_reclaim_skipped_total',
      { reason: 'open_pr_unknown' },
      snapshot.skippedOpenPrUnknown ?? 0,
    ),
    metricLine(
      'kookr_finished_awaiting_ack_ttl_reclaim_skipped_total',
      { reason: 'under_ttl' },
      snapshot.skippedUnderTtl ?? 0,
    ),
  );

  if (typeof snapshot.autoCompletedTotal === 'number') {
    lines.push(
      '# HELP kookr_finished_awaiting_ack_auto_completed_total Total meta/playbook finishedAwaitingAck tasks auto-completed past the age gate (issue #2070).',
      '# TYPE kookr_finished_awaiting_ack_auto_completed_total counter',
      metricLine('kookr_finished_awaiting_ack_auto_completed_total', {}, snapshot.autoCompletedTotal),
    );
  }
  if (typeof snapshot.autoCompleteDeferredTotal === 'number') {
    lines.push(
      '# HELP kookr_finished_awaiting_ack_auto_complete_deferred_total Total meta FAA auto-complete TOCTOU deferrals (live turn / interactive pane).',
      '# TYPE kookr_finished_awaiting_ack_auto_complete_deferred_total counter',
      metricLine(
        'kookr_finished_awaiting_ack_auto_complete_deferred_total',
        {},
        snapshot.autoCompleteDeferredTotal,
      ),
    );
  }
  if (typeof snapshot.reclaimDeferredTotal === 'number') {
    lines.push(
      '# HELP kookr_finished_awaiting_ack_ttl_reclaim_deferred_total Total strict/soft/capacity-pressure FAA reclaims deferred by the TOCTOU re-check — resumed live turn, interactive pane, or confirmed-open PR hold (issue #3040).',
      '# TYPE kookr_finished_awaiting_ack_ttl_reclaim_deferred_total counter',
      metricLine(
        'kookr_finished_awaiting_ack_ttl_reclaim_deferred_total',
        {},
        snapshot.reclaimDeferredTotal,
      ),
    );
  }
  if (snapshot.autoCompleteAgeHistogram) {
    lines.push(
      '# HELP kookr_finished_awaiting_ack_auto_complete_age_bucket Age-at-auto-complete histogram counts by upper-bound minutes (issue #2070).',
      '# TYPE kookr_finished_awaiting_ack_auto_complete_age_bucket counter',
    );
    for (const [le, count] of Object.entries(snapshot.autoCompleteAgeHistogram)) {
      lines.push(
        metricLine('kookr_finished_awaiting_ack_auto_complete_age_bucket', { le }, count),
      );
    }
  }
}

/**
 * hungSuspect TTL reclaim counters (issues #1935 / #2045). Omitted when the
 * sweep is not wired — same optional convention as the FAA reclaim counter.
 * Skip-reason series always emit when the snapshot is present so scrapers
 * can chart why reclaimedTotal stays flat.
 */
function appendHungSuspectReclaimMetrics(
  lines: string[],
  snapshot:
    | {
        reclaimedTotal: number;
        reclaimAttempted?: number;
        reclaimSucceeded?: number;
        skippedNoLiveness?: number;
        skippedOpenPrFailsafe?: number;
        skippedOpenPrConfirmed?: number;
        skippedOpenPrUnknown?: number;
        skippedUnderTtl?: number;
        skippedExemptAnomaly?: number;
        skippedProviderPaused?: number;
        sweepFailuresTotal?: number;
        lastFailureAtMs?: number | null;
      }
    | undefined,
): void {
  if (!snapshot) return;

  lines.push(
    '# HELP kookr_hung_suspect_ttl_reclaimed_total Total hungSuspect tasks terminated by the TTL reclaim since process start.',
    '# TYPE kookr_hung_suspect_ttl_reclaimed_total counter',
    metricLine('kookr_hung_suspect_ttl_reclaimed_total', {}, snapshot.reclaimedTotal),
    '# HELP kookr_hung_suspect_ttl_reclaim_attempted_total Total hungSuspect candidates selected for reclaim (terminate attempted) since process start.',
    '# TYPE kookr_hung_suspect_ttl_reclaim_attempted_total counter',
    metricLine('kookr_hung_suspect_ttl_reclaim_attempted_total', {}, snapshot.reclaimAttempted ?? 0),
    '# HELP kookr_hung_suspect_ttl_reclaim_succeeded_total Total successful hungSuspect TTL reclaim terminates since process start.',
    '# TYPE kookr_hung_suspect_ttl_reclaim_succeeded_total counter',
    metricLine(
      'kookr_hung_suspect_ttl_reclaim_succeeded_total',
      {},
      snapshot.reclaimSucceeded ?? snapshot.reclaimedTotal,
    ),
    '# HELP kookr_hung_suspect_ttl_reclaim_skipped_total HungSuspect TTL reclaim skips by reason (cumulative since process start; issue #2228 splits open_pr).',
    '# TYPE kookr_hung_suspect_ttl_reclaim_skipped_total counter',
    metricLine(
      'kookr_hung_suspect_ttl_reclaim_skipped_total',
      { reason: 'no_liveness' },
      snapshot.skippedNoLiveness ?? 0,
    ),
    metricLine(
      'kookr_hung_suspect_ttl_reclaim_skipped_total',
      { reason: 'open_pr_failsafe' },
      snapshot.skippedOpenPrFailsafe ?? 0,
    ),
    metricLine(
      'kookr_hung_suspect_ttl_reclaim_skipped_total',
      { reason: 'open_pr_confirmed' },
      snapshot.skippedOpenPrConfirmed ?? 0,
    ),
    metricLine(
      'kookr_hung_suspect_ttl_reclaim_skipped_total',
      { reason: 'open_pr_unknown' },
      snapshot.skippedOpenPrUnknown ?? 0,
    ),
    metricLine(
      'kookr_hung_suspect_ttl_reclaim_skipped_total',
      { reason: 'under_ttl' },
      snapshot.skippedUnderTtl ?? 0,
    ),
    metricLine(
      'kookr_hung_suspect_ttl_reclaim_skipped_total',
      { reason: 'exempt_anomaly' },
      snapshot.skippedExemptAnomaly ?? 0,
    ),
    metricLine(
      'kookr_hung_suspect_ttl_reclaim_skipped_total',
      { reason: 'provider_paused' },
      snapshot.skippedProviderPaused ?? 0,
    ),
    // Issue #2897: bounded sweep-failure signal. The counter never resets; the
    // timestamp gauge is 0 once a later successful pass cleared the error. No
    // raw exception text — the sanitized category lives on /api/health only.
    '# HELP kookr_hung_suspect_ttl_sweep_failures_total HungSuspect TTL sweep passes that threw before completing since process start (issue #2897).',
    '# TYPE kookr_hung_suspect_ttl_sweep_failures_total counter',
    metricLine('kookr_hung_suspect_ttl_sweep_failures_total', {}, snapshot.sweepFailuresTotal ?? 0),
    '# HELP kookr_hung_suspect_ttl_sweep_last_failure_timestamp_seconds Unix time of the most recent hungSuspect TTL sweep failure; 0 after a later successful pass cleared it (issue #2897).',
    '# TYPE kookr_hung_suspect_ttl_sweep_last_failure_timestamp_seconds gauge',
    metricLine(
      'kookr_hung_suspect_ttl_sweep_last_failure_timestamp_seconds',
      {},
      snapshot.lastFailureAtMs != null ? msToSeconds(snapshot.lastFailureAtMs) : 0,
    ),
  );
}

/**
 * provider_paused occupancy + hard-TTL reclaim counters (issue #2079).
 * Omitted when the sweep is not wired.
 */
function appendProviderPausedOccupancyMetrics(
  lines: string[],
  snapshot:
    | {
        count: number;
        oldestPauseAgeMs?: number | null;
        reclaimedTotal: number;
        reclaimAttempted?: number;
        reclaimSucceeded?: number;
        skippedUnderTtl?: number;
        skippedOpenPrFailsafe?: number;
        skippedOpenPrConfirmed?: number;
        skippedOpenPrUnknown?: number;
        skippedNoPauseStart?: number;
        skippedAwaitingProviderReset?: number;
      }
    | undefined,
): void {
  if (!snapshot) return;

  lines.push(
    '# HELP kookr_provider_paused_occupancy Current inProgress tasks classified provider_paused (billing/quota hold).',
    '# TYPE kookr_provider_paused_occupancy gauge',
    metricLine('kookr_provider_paused_occupancy', {}, snapshot.count),
    '# HELP kookr_provider_paused_oldest_age_ms Age of the oldest continuous provider_pause in milliseconds (0 when none or unknown).',
    '# TYPE kookr_provider_paused_oldest_age_ms gauge',
    metricLine(
      'kookr_provider_paused_oldest_age_ms',
      {},
      typeof snapshot.oldestPauseAgeMs === 'number' && Number.isFinite(snapshot.oldestPauseAgeMs)
        ? snapshot.oldestPauseAgeMs
        : 0,
    ),
    '# HELP kookr_provider_paused_ttl_reclaimed_total Total provider_paused tasks terminated by the hard TTL reclaim since process start.',
    '# TYPE kookr_provider_paused_ttl_reclaimed_total counter',
    metricLine('kookr_provider_paused_ttl_reclaimed_total', {}, snapshot.reclaimedTotal),
    '# HELP kookr_provider_paused_ttl_reclaim_attempted_total Total provider_paused candidates selected for hard-TTL reclaim since process start.',
    '# TYPE kookr_provider_paused_ttl_reclaim_attempted_total counter',
    metricLine('kookr_provider_paused_ttl_reclaim_attempted_total', {}, snapshot.reclaimAttempted ?? 0),
    '# HELP kookr_provider_paused_ttl_reclaim_succeeded_total Total successful provider_paused hard-TTL reclaim terminates since process start.',
    '# TYPE kookr_provider_paused_ttl_reclaim_succeeded_total counter',
    metricLine(
      'kookr_provider_paused_ttl_reclaim_succeeded_total',
      {},
      snapshot.reclaimSucceeded ?? snapshot.reclaimedTotal,
    ),
    '# HELP kookr_provider_paused_ttl_reclaim_skipped_total Provider_paused hard-TTL reclaim skips by reason (cumulative since process start; issue #2228 splits open_pr).',
    '# TYPE kookr_provider_paused_ttl_reclaim_skipped_total counter',
    metricLine(
      'kookr_provider_paused_ttl_reclaim_skipped_total',
      { reason: 'under_ttl' },
      snapshot.skippedUnderTtl ?? 0,
    ),
    metricLine(
      'kookr_provider_paused_ttl_reclaim_skipped_total',
      { reason: 'open_pr_failsafe' },
      snapshot.skippedOpenPrFailsafe ?? 0,
    ),
    metricLine(
      'kookr_provider_paused_ttl_reclaim_skipped_total',
      { reason: 'open_pr_confirmed' },
      snapshot.skippedOpenPrConfirmed ?? 0,
    ),
    metricLine(
      'kookr_provider_paused_ttl_reclaim_skipped_total',
      { reason: 'open_pr_unknown' },
      snapshot.skippedOpenPrUnknown ?? 0,
    ),
    metricLine(
      'kookr_provider_paused_ttl_reclaim_skipped_total',
      { reason: 'no_pause_start' },
      snapshot.skippedNoPauseStart ?? 0,
    ),
    metricLine(
      'kookr_provider_paused_ttl_reclaim_skipped_total',
      { reason: 'awaiting_provider_reset' },
      snapshot.skippedAwaitingProviderReset ?? 0,
    ),
  );
}

/**
 * Per-repo GitHub state-fetch failure counter (issue #1946). Always emits
 * HELP/TYPE so scrapers discover the family; series appear only for repos
 * that have recorded at least one non-rate-limit batch failure.
 */
function appendGitHubStateFetchMetrics(
  lines: string[],
  entries: GitHubStateFetchFailureSnapshotEntry[] = [],
): void {
  lines.push(
    '# HELP kookr_github_state_fetch_failures_total Total non-rate-limit GitHub state-batch fetch failures by repository.',
    '# TYPE kookr_github_state_fetch_failures_total counter',
  );
  for (const entry of entries) {
    lines.push(metricLine('kookr_github_state_fetch_failures_total', { repo: entry.repo }, entry.failures));
  }
}

/**
 * Lesson-yield gauges from the last warm 24h health-cache snapshot (issue #1857).
 * Omitted entirely when the cache is cold — scrape path must not invent zeros
 * that look like "zero yield" and must never trigger a hook-log scan.
 */
function appendLessonYieldMetrics(
  lines: string[],
  snapshot: LessonYieldSnapshot | undefined,
): void {
  if (!snapshot) return;

  lines.push(
    '# HELP kookr_lesson_yield_decided Completed tasks in the last 24h that wrote a lesson or declared an explicit skip.',
    '# TYPE kookr_lesson_yield_decided gauge',
    metricLine('kookr_lesson_yield_decided', {}, snapshot.decided),
    '# HELP kookr_lesson_yield_completed Completed tasks in the last 24h (yield denominator).',
    '# TYPE kookr_lesson_yield_completed gauge',
    metricLine('kookr_lesson_yield_completed', {}, snapshot.completedInWindow),
    '# HELP kookr_lesson_yield_wrote_lesson Completed tasks in the last 24h that wrote a kb lesson.',
    '# TYPE kookr_lesson_yield_wrote_lesson gauge',
    metricLine('kookr_lesson_yield_wrote_lesson', {}, snapshot.buckets.wroteLesson),
    '# HELP kookr_lesson_yield_explicit_skip Completed tasks in the last 24h that declared an explicit no-lesson skip.',
    '# TYPE kookr_lesson_yield_explicit_skip gauge',
    metricLine('kookr_lesson_yield_explicit_skip', {}, snapshot.buckets.explicitSkip),
    '# HELP kookr_lesson_yield_no_kb_activity Completed tasks in the last 24h with neither a lesson decision nor kb search activity.',
    '# TYPE kookr_lesson_yield_no_kb_activity gauge',
    metricLine('kookr_lesson_yield_no_kb_activity', {}, snapshot.buckets.noKbActivity),
    '# HELP kookr_lesson_yield_ratio decided / completedInWindow for the last 24h (0 when denominator is 0). Target ≥ 1.0.',
    '# TYPE kookr_lesson_yield_ratio gauge',
    metricLine('kookr_lesson_yield_ratio', {}, snapshot.yieldRate),
  );
}

/**
 * `/api/health` body-cache timing gauges (issue #2497). Seconds base unit to
 * match the other duration families. Omitted entirely when the cache is cold
 * (never assembled) so scrapers never see fabricated zeros. `cache_age_seconds`
 * can briefly exceed the 1s TTL during a stale-while-revalidate refresh (#2492).
 */
function appendHealthBodyCacheMetrics(
  lines: string[],
  snapshot: { assemblyMs: number; cacheAgeMs: number } | undefined,
): void {
  if (!snapshot) return;

  lines.push(
    '# HELP kookr_health_body_assembly_seconds Duration of the most recent /api/health body assembly walk.',
    '# TYPE kookr_health_body_assembly_seconds gauge',
    metricLine('kookr_health_body_assembly_seconds', {}, msToSeconds(snapshot.assemblyMs)),
    '# HELP kookr_health_body_cache_age_seconds Age of the currently-cached /api/health body; may exceed the 1s TTL during a stale-while-revalidate refresh.',
    '# TYPE kookr_health_body_cache_age_seconds gauge',
    metricLine('kookr_health_body_cache_age_seconds', {}, msToSeconds(snapshot.cacheAgeMs)),
  );
}

function appendTerminalInputRttMetrics(
  lines: string[],
  snapshot: TerminalInputRttMetricsSnapshot = EMPTY_TERMINAL_INPUT_RTT_SNAPSHOT,
): void {
  lines.push(
    // Seconds + `_observations_total`, matching kookr_http_request_duration_*
    // and kookr_tool_duration_* so all three latency families share one unit
    // and one counter idiom (Prometheus base-unit guidance).
    '# HELP kookr_terminal_input_rtt_observations_total Total terminal input write round-trip observations since process start.',
    '# TYPE kookr_terminal_input_rtt_observations_total counter',
    metricLine('kookr_terminal_input_rtt_observations_total', {}, snapshot.count),
    '# HELP kookr_terminal_input_rtt_seconds Terminal input write round-trip latency (keystroke enqueue → backend write-ack) quantiles in seconds.',
    '# TYPE kookr_terminal_input_rtt_seconds gauge',
    metricLine('kookr_terminal_input_rtt_seconds', { quantile: '0.5' }, msToSeconds(snapshot.p50Ms)),
    metricLine('kookr_terminal_input_rtt_seconds', { quantile: '0.95' }, msToSeconds(snapshot.p95Ms)),
    metricLine('kookr_terminal_input_rtt_seconds', { quantile: '0.99' }, msToSeconds(snapshot.p99Ms)),
  );
}

/** Always-on task-state save timing (issue #1777). No env flag required. */
function appendTaskSaveMetrics(lines: string[], snapshot: TaskSaveMetricsSnapshot): void {
  const last = snapshot.last;
  lines.push(
    '# HELP kookr_task_save_observations_total Total task-state save observations recorded by this process.',
    '# TYPE kookr_task_save_observations_total counter',
    metricLine('kookr_task_save_observations_total', {}, snapshot.totalObservations),
    '# HELP kookr_task_save_sample_count Number of retained task-state save samples in the ring buffer.',
    '# TYPE kookr_task_save_sample_count gauge',
    metricLine('kookr_task_save_sample_count', {}, snapshot.sampleCount),
    '# HELP kookr_task_save_duration_seconds Task-state save duration quantiles by phase (serialize vs write).',
    '# TYPE kookr_task_save_duration_seconds gauge',
    metricLine('kookr_task_save_duration_seconds', { phase: 'serialize', quantile: '0.95' }, msToSeconds(snapshot.p95SerializeMs)),
    metricLine('kookr_task_save_duration_seconds', { phase: 'write', quantile: '0.95' }, msToSeconds(snapshot.p95WriteMs)),
    metricLine('kookr_task_save_duration_seconds', { phase: 'total', quantile: '0.95' }, msToSeconds(snapshot.p95TotalMs)),
    '# HELP kookr_task_save_last_bytes Payload bytes of the most recent task-state save (JSON envelope or SQLite task blobs).',
    '# TYPE kookr_task_save_last_bytes gauge',
    metricLine('kookr_task_save_last_bytes', {}, last?.bytes ?? 0),
    '# HELP kookr_task_save_last_task_count Task count involved in the most recent task-state save.',
    '# TYPE kookr_task_save_last_task_count gauge',
    metricLine('kookr_task_save_last_task_count', {}, last?.taskCount ?? 0),
    '# HELP kookr_task_save_last_duration_seconds Duration of the most recent task-state save by phase.',
    '# TYPE kookr_task_save_last_duration_seconds gauge',
    metricLine('kookr_task_save_last_duration_seconds', { phase: 'serialize' }, msToSeconds(last?.serializeMs ?? 0)),
    metricLine('kookr_task_save_last_duration_seconds', { phase: 'write' }, msToSeconds(last?.writeMs ?? 0)),
    metricLine('kookr_task_save_last_duration_seconds', { phase: 'total' }, msToSeconds(last?.totalMs ?? 0)),
  );
}

const EMPTY_NON_CRITICAL_TIMER_PAUSE: NonCriticalTimerPauseMetricsSnapshot = {
  paused: false,
  thresholdMs: 0,
  lastEventLoopDelayP95Ms: null,
  pausedTicksTotal: 0,
};

function appendNonCriticalTimerPauseMetrics(
  lines: string[],
  snapshot: NonCriticalTimerPauseMetricsSnapshot = EMPTY_NON_CRITICAL_TIMER_PAUSE,
): void {
  lines.push(
    '# HELP kookr_non_critical_timer_pause_active Whether non-critical timer ticks are currently skipping (1) due to elevated event-loop delay p95.',
    '# TYPE kookr_non_critical_timer_pause_active gauge',
    metricLine('kookr_non_critical_timer_pause_active', {}, snapshot.paused ? 1 : 0),
    '# HELP kookr_non_critical_timer_pause_threshold_ms Configured event-loop delay p95 threshold (ms); 0 means the gate is disabled.',
    '# TYPE kookr_non_critical_timer_pause_threshold_ms gauge',
    metricLine('kookr_non_critical_timer_pause_threshold_ms', {}, snapshot.thresholdMs),
    '# HELP kookr_non_critical_timer_pause_last_event_loop_delay_p95_ms Last finite event-loop delay p95 sample (ms) fed to the pause gate; -1 when none.',
    '# TYPE kookr_non_critical_timer_pause_last_event_loop_delay_p95_ms gauge',
    metricLine(
      'kookr_non_critical_timer_pause_last_event_loop_delay_p95_ms',
      {},
      snapshot.lastEventLoopDelayP95Ms ?? -1,
    ),
    '# HELP kookr_non_critical_timer_pauses_total Total non-critical timer ticks skipped because event-loop delay p95 was elevated.',
    '# TYPE kookr_non_critical_timer_pauses_total counter',
    metricLine('kookr_non_critical_timer_pauses_total', {}, snapshot.pausedTicksTotal),
  );
}

const EMPTY_SNAPSHOT_SHED: SnapshotShedMetricsExposition = {
  thresholdMs: 0,
  lastEventLoopDelayP95Ms: null,
  shedTotal: 0,
  gateShedTotal: 0,
};

function appendSnapshotShedMetrics(
  lines: string[],
  snapshot: SnapshotShedMetricsExposition = EMPTY_SNAPSHOT_SHED,
): void {
  lines.push(
    '# HELP kookr_snapshot_shed_total Total non-critical full-snapshot rebuilds skipped because event-loop delay p95 was elevated.',
    '# TYPE kookr_snapshot_shed_total counter',
    metricLine('kookr_snapshot_shed_total', {}, snapshot.shedTotal),
    '# HELP kookr_snapshot_shed_gate_total Subset of kookr_snapshot_shed_total skipped because the #1725 WS load-shed gate was active (vs the instantaneous p95 threshold).',
    '# TYPE kookr_snapshot_shed_gate_total counter',
    metricLine('kookr_snapshot_shed_gate_total', {}, snapshot.gateShedTotal ?? 0),
    '# HELP kookr_snapshot_shed_threshold_ms Configured event-loop delay p95 threshold (ms) for snapshot rebuild shed; 0 means disabled.',
    '# TYPE kookr_snapshot_shed_threshold_ms gauge',
    metricLine('kookr_snapshot_shed_threshold_ms', {}, snapshot.thresholdMs),
    '# HELP kookr_snapshot_shed_last_event_loop_delay_p95_ms Last finite event-loop delay p95 sample (ms) consulted for snapshot shed; -1 when none.',
    '# TYPE kookr_snapshot_shed_last_event_loop_delay_p95_ms gauge',
    metricLine(
      'kookr_snapshot_shed_last_event_loop_delay_p95_ms',
      {},
      snapshot.lastEventLoopDelayP95Ms ?? -1,
    ),
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

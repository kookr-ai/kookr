import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { CircuitBreaker, CircuitBreakerRegistry } from '../../core/circuit-breaker.js';
import { AttentionQueue } from '../../core/attention-queue.js';
import type { Anomaly } from '../../core/types.js';
import { Watchdog } from '../../core/watchdog.js';
import { TaskSaveMetricsRecorder } from '../../core/task-save-metrics.js';
import { AuthThrottle } from '../auth-throttle.js';
import { RequestDurationMetrics } from '../request-duration-metrics.js';
import { PROMETHEUS_CONTENT_TYPE } from '../prometheus-exposition.js';
import { TerminalInputRttMetrics } from '../terminal-input-rtt-metrics.js';
import { TerminalInputCoordinator } from '../terminal-input-coordinator.js';
import { FakeTerminalBackend } from '../../adapters/fake-terminal-backend.js';
import { registerMetricsRoutes } from './metrics-routes.js';
import type { RouteDeps } from './shared.js';
import { LessonYieldHealthCache } from '../lesson-yield-health-cache.js';
import { LESSON_YIELD_SCHEMA_VERSION } from '../../core/lesson-decision.js';
import { HealthBodyCacheStats } from '../health-body-cache-stats.js';

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

  test('serves live idempotency ledger metrics', async () => {
    const res = await mkApp({
      idempotencyLedger: {
        getMetrics: () => ({
          schemaVersion: 'idempotency-ledger-metrics.v1' as const,
          entryCount: 7,
          pendingCount: 1,
          maxEntries: 100,
          ttlMs: 86_400_000,
          expiredTotal: 3,
          evictedTotal: 2,
        }),
      },
    }).request('/metrics');

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('kookr_idempotency_ledger_entries 7');
    expect(body).toContain('kookr_idempotency_ledger_expired_total 3');
    expect(body).toContain('kookr_idempotency_ledger_evicted_total 2');
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

  test('serves always-on task-save timing metrics without env flag (issue #1777)', async () => {
    // Private recorder so parallel vitest files cannot pollute exact counters.
    const recorder = new TaskSaveMetricsRecorder();
    recorder.record({
      serializeMs: 10,
      writeMs: 40,
      totalMs: 50,
      bytes: 1_500_000,
      taskCount: 42,
      relationCount: 2,
      backend: 'json',
    });

    const res = await mkApp({ taskSaveMetrics: recorder }).request('/metrics');

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('kookr_task_save_observations_total 1');
    expect(body).toContain('kookr_task_save_sample_count 1');
    expect(body).toContain('kookr_task_save_duration_seconds{phase="write",quantile="0.95"} 0.04');
    expect(body).toContain('kookr_task_save_last_bytes 1500000');
    expect(body).toContain('kookr_task_save_last_task_count 42');
    expect(process.env.KOOKR_LOG_TASK_SAVE_METRICS).not.toBe('1');
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

  test('serves capacity ledger gauges from a fixture task list (issue #1856)', async () => {
    const now = Date.now();
    const raisedAt = new Date(now - 60_000).toISOString();
    const res = await mkApp({
      getMaxActiveTasks: () => 10,
      taskStore: {
        listTasks: () => [
          {
            id: 'working-1',
            status: 'inProgress',
            createdAt: new Date(now - 120_000),
            sessions: [{ tmuxSession: 'agent-working' }],
          },
          {
            id: 'ack-1',
            status: 'inProgress',
            createdAt: new Date(now - 90_000),
            pendingSignal: { kind: 'completion_ready', raisedAt },
            sessions: [{ tmuxSession: 'agent-ack' }],
          },
          {
            id: 'pending-1',
            status: 'pending',
            createdAt: new Date(now - 30_000),
            sessions: [],
          },
        ],
        hasFreshActiveLaunchReservation: () => false,
      } as never,
    }).request('/metrics');

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('# TYPE kookr_capacity_active gauge');
    expect(body).toContain('kookr_capacity_active 2');
    expect(body).toContain('kookr_capacity_free 8');
    expect(body).toContain('kookr_capacity_max 10');
    expect(body).toContain('kookr_capacity_by_class{class="working"} 1');
    expect(body).toContain('kookr_capacity_by_class{class="finishedAwaitingAck"} 1');
    expect(body).toContain('kookr_capacity_by_class{class="hungSuspect"} 0');
    expect(body).toContain('kookr_capacity_by_class{class="launching"} 0');
    expect(body).toContain('kookr_capacity_pending_queue_depth 1');
    expect(body).toMatch(/kookr_capacity_oldest_pending_age_seconds [0-9.]+/);
    expect(body).toMatch(/kookr_capacity_oldest_finished_awaiting_ack_age_seconds [0-9.]+/);
  });

  test('serves lesson-yield gauges from a warm health cache without scanning (issue #1857)', async () => {
    const lessonYieldHealth = new LessonYieldHealthCache();
    lessonYieldHealth.set(1, {
      schemaVersion: LESSON_YIELD_SCHEMA_VERSION,
      generatedAt: '2026-08-01T12:00:00.000Z',
      windowDays: 1,
      windowStartMs: 0,
      tasksInWindow: 12,
      completedInWindow: 5,
      completedWithLogs: 5,
      buckets: {
        wroteLesson: 2,
        explicitSkip: 1,
        searchOnly: 1,
        noKbActivity: 1,
      },
      decided: 3,
      yieldRate: 0.6,
      yieldRateAmongLogged: 0.6,
      byCompletionPath: {},
      gateExemptReasons: {},
      explainedExceptions: 0,
      contractRate: 0.6,
    }, Date.now() + 60_000);

    const res = await mkApp({ lessonYieldHealth }).request('/metrics');

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('# TYPE kookr_lesson_yield_decided gauge');
    expect(body).toContain('kookr_lesson_yield_decided 3');
    expect(body).toContain('kookr_lesson_yield_completed 5');
    expect(body).toContain('kookr_lesson_yield_wrote_lesson 2');
    expect(body).toContain('kookr_lesson_yield_explicit_skip 1');
    expect(body).toContain('kookr_lesson_yield_no_kb_activity 1');
    expect(body).toContain('kookr_lesson_yield_ratio 0.6');
  });

  test('omits lesson-yield series when health cache is cold (issue #1857)', async () => {
    const res = await mkApp({ lessonYieldHealth: new LessonYieldHealthCache() }).request('/metrics');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('kookr_lesson_yield_');
  });

  test('serves health-body cache gauges from the shared stats (issue #2497)', async () => {
    const healthBodyCacheStats = new HealthBodyCacheStats();
    healthBodyCacheStats.record(42, 1_700_000_000_000);
    // Read 250ms after the body landed ⇒ cacheAgeMs = 250.
    const res = await mkApp({
      healthBodyCacheStats,
      nowMs: () => 1_700_000_000_250,
    }).request('/metrics');

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('# TYPE kookr_health_body_assembly_seconds gauge');
    expect(body).toContain('kookr_health_body_assembly_seconds 0.042');
    expect(body).toContain('# TYPE kookr_health_body_cache_age_seconds gauge');
    expect(body).toContain('kookr_health_body_cache_age_seconds 0.25');
  });

  test('omits health-body cache series when the cache is cold (issue #2497)', async () => {
    const res = await mkApp({ healthBodyCacheStats: new HealthBodyCacheStats() }).request('/metrics');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('kookr_health_body_');
  });
});

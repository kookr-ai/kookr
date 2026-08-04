import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../../core/tasks.js';
import { AttentionQueue } from '../../core/attention-queue.js';
import { CircuitBreaker, CircuitBreakerRegistry } from '../../core/circuit-breaker.js';
import { ShadowDetectorRegistry } from '../../core/shadow-detector.js';
import { GitHubStateStore } from '../../core/github-state-store.js';
import { recordSuppression, resetDetectionStats } from '../../core/detection-stats.js';
import { recordWaitingOnInputOutcome, resetStuckFlagPrecision } from '../../core/stuck-flag-precision.js';
import { extractRawHookHeader, HookParseError, parseHookEvent } from '../../core/hook-parser.js';
import { Monitor } from '../../core/monitor.js';
import { Watchdog } from '../../core/watchdog.js';
import {
  registerDiagnosticsRoutes,
  SCHEDULER_TICK_STALE_INTERVALS,
  checkSchedulerTickReadiness,
  checkHookIngestionReadiness,
} from './diagnostics-routes.js';
import { RequestDurationMetrics } from '../request-duration-metrics.js';
import { HotPathSampler } from '../../core/hot-path-sampler.js';
import { TerminalInputRttMetrics } from '../terminal-input-rtt-metrics.js';
import { AuthThrottle } from '../auth-throttle.js';
import { ViewerGrantStore } from '../../core/viewer-grants.js';
import { ViewerConnectionRegistry } from '../viewer-connection-registry.js';
import { CollaborationAuditLog } from '../collaboration-audit-log.js';
import { DrainController } from '../drain-state.js';
import { DeliveryTraceBuffer } from '../../core/delivery-trace.js';
import { HookIngestion, REPLAY_SESSION_PREFIX, type HookEventInjector } from '../hook-ingestion.js';
import { HungSuspectTtlReclaimMetrics } from '../hung-suspect-ttl-sweep.js';
import { SCHEDULE_TICK_INTERVAL_MS } from '../schedule-runner.js';
import type { RouteDeps } from './shared.js';
import type { AgentEvent, Anomaly, InjectHookEventResult } from '../../core/types.js';
import type { LlmClient } from '../../core/llm-client.js';
import type { HelperLlmDiagnosticsCounters, HelperLlmDiagnosticsSnapshot } from '../../shared/contracts/diagnostic.js';
import type { ScheduleStatusSnapshot } from '../../shared/contracts/schedule.js';

function mkApp(deps: Partial<RouteDeps>): Hono {
  const app = new Hono();
  registerDiagnosticsRoutes(app, deps as unknown as RouteDeps);
  return app;
}

function fakeLlm(output: string | null): LlmClient {
  return {
    provider: 'fake-provider',
    model: 'fake-model',
    complete: vi.fn(async () => output),
  };
}

function helperLlmCounters(overrides: Partial<HelperLlmDiagnosticsCounters> = {}): HelperLlmDiagnosticsCounters {
  return {
    requestCount: 0,
    successCount: 0,
    failureCount: 0,
    nullResponseCount: 0,
    errorCount: 0,
    abortedCount: 0,
    totalLatencyMs: 0,
    averageLatencyMs: 0,
    maxLatencyMs: 0,
    failureCategories: {},
    ...overrides,
  };
}

function helperLlmSnapshot(overrides: Partial<HelperLlmDiagnosticsSnapshot> = {}): HelperLlmDiagnosticsSnapshot {
  return {
    schemaVersion: 'helper-llm-diagnostics.v1',
    generatedAt: 123,
    totals: helperLlmCounters(),
    byUseCase: [],
    byProvider: [],
    byUseCaseProvider: [],
    ...overrides,
  } satisfies HelperLlmDiagnosticsSnapshot;
}

function anomaly(overrides: Partial<Anomaly> = {}): Anomaly {
  return {
    agentId: 'session-1',
    type: 'permission_blocked',
    severity: 'warning',
    explanation: 'Raw finding explanation should not be in delivery diagnostics',
    detectedAt: new Date('2026-06-13T10:00:00.000Z'),
    eventId: 'hook-event-1',
    ...overrides,
  };
}

interface HookRouteHarness {
  app: Hono;
  ingestion: HookIngestion;
  monitor: Monitor;
  calls: Array<{
    tmuxName: string;
    sequence?: number;
    options?: Parameters<HookEventInjector['injectHookEvent']>[3];
    result: InjectHookEventResult;
  }>;
}

function mkHookRouteHarness(): HookRouteHarness {
  const taskStore = new TaskStore();
  const monitor = new Monitor(taskStore, new AttentionQueue());
  const calls: HookRouteHarness['calls'] = [];
  const adapter: HookEventInjector = {
    injectHookEvent(tmuxName, rawJson, sequence, options) {
      const result = parseForRouteReplay(rawJson, sequence);
      const event = result.parseStatus === 'ok' ? parseHookEvent(rawJson) : null;
      calls.push({
        tmuxName,
        sequence,
        options,
        result,
      });
      if (event) {
        monitor.registerAgent(tmuxName);
        monitor.processEvents(tmuxName, [event]);
      }
      return result;
    },
  };
  const ingestion = new HookIngestion({ adapter, now: () => 1_800_000_000_000 });
  return {
    app: mkApp({ hookIngestion: ingestion }),
    ingestion,
    monitor,
    calls,
  };
}

function parseForRouteReplay(rawJson: string, sequence?: number): InjectHookEventResult {
  let header: ReturnType<typeof extractRawHookHeader>;
  try {
    header = extractRawHookHeader(rawJson);
  } catch (err) {
    return {
      parseStatus: 'malformed',
      agentType: 'codex-cli',
      error: err instanceof HookParseError ? err.message : String(err),
    };
  }

  let event: AgentEvent | null;
  try {
    event = parseHookEvent(rawJson);
  } catch (err) {
    return {
      parseStatus: 'malformed',
      agentType: 'codex-cli',
      rawSessionId: header.rawSessionId,
      rawTurnId: header.rawTurnId,
      rawHookEventName: header.rawHookEventName,
      error: err instanceof HookParseError ? err.message : String(err),
    };
  }

  if (!event) {
    return {
      parseStatus: 'dropped',
      agentType: 'codex-cli',
      rawSessionId: header.rawSessionId,
      rawTurnId: header.rawTurnId,
      rawHookEventName: header.rawHookEventName,
      parentage: 'unknown',
      sequence,
    };
  }

  return {
    parseStatus: 'ok',
    agentType: 'codex-cli',
    rawSessionId: header.rawSessionId,
    rawTurnId: header.rawTurnId,
    rawHookEventName: header.rawHookEventName,
    parentage: 'parent',
    sequence,
  };
}

describe('diagnostics routes', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'diag-routes-test-'));
    delete process.env.KOOKR_FINDING_REVIEW_ENABLED;
    delete process.env.KOOKR_FINDING_REVIEW_DAILY_COST_CENTS;
    delete process.env.KOOKR_FINDING_REVIEW_TOKEN;
    delete process.env.KOOKR_FINDING_REVIEW_ADMIN_TOKEN;
    resetDetectionStats();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.KOOKR_FINDING_REVIEW_ENABLED;
    delete process.env.KOOKR_FINDING_REVIEW_DAILY_COST_CENTS;
    delete process.env.KOOKR_FINDING_REVIEW_TOKEN;
    delete process.env.KOOKR_FINDING_REVIEW_ADMIN_TOKEN;
    resetDetectionStats();
  });

  function createLaunchDependencyDiagnosticsFixture(): {
    taskStore: TaskStore;
    firstTaskId: string;
    secondTaskId: string;
  } {
    const taskStore = new TaskStore();
    const first = taskStore.createTask({
      prompt: 'first',
      cwd: '/repo',
      launchHealthSummary: {
        degradedDependencies: ['kb'],
        findings: [
          {
            dependency: 'kb',
            status: 'failed',
            category: 'cli_unavailable',
            summary: 'kb unavailable',
            recommendedAction: 'restart kb',
          },
        ],
      },
    });
    const second = taskStore.createTask({
      prompt: 'second',
      cwd: '/repo',
      launchHealthSummary: {
        degradedDependencies: ['kb', 'gh'],
        findings: [
          {
            dependency: 'kb',
            status: 'failed',
            category: 'cli_unavailable',
            summary: 'kb still unavailable',
            recommendedAction: 'restart kb',
          },
          {
            dependency: 'gh',
            status: 'failed',
            category: 'auth',
            summary: 'gh auth unavailable',
            recommendedAction: 'run gh auth login',
          },
        ],
      },
    });
    return { taskStore, firstTaskId: first.id, secondTaskId: second.id };
  }

  function expectLaunchDependencyDiagnostics(
    diagnostics: {
      schemaVersion: string;
      totalDegradedTasks: number;
      totalFindings: number;
      dependencies: Array<{
        dependency: string;
        degradedTaskCount: number;
        findingCount: number;
        affectedTaskIds: string[];
        categories: string[];
      }>;
      categories: Array<{
        category: string;
        degradedTaskCount: number;
        findingCount: number;
        affectedTaskIds: string[];
        dependencies: string[];
      }>;
    },
    taskIds: { firstTaskId: string; secondTaskId: string },
  ): void {
    expect(diagnostics).toMatchObject({
      schemaVersion: 'launch-dependency-diagnostics.v1',
      totalDegradedTasks: 2,
      totalFindings: 3,
      dependencies: [
        {
          dependency: 'kb',
          degradedTaskCount: 2,
          findingCount: 2,
          affectedTaskIds: [taskIds.firstTaskId, taskIds.secondTaskId].sort(),
          categories: ['cli_unavailable'],
        },
        {
          dependency: 'gh',
          degradedTaskCount: 1,
          findingCount: 1,
          affectedTaskIds: [taskIds.secondTaskId],
          categories: ['auth'],
        },
      ],
      categories: [
        {
          category: 'cli_unavailable',
          degradedTaskCount: 2,
          findingCount: 2,
          affectedTaskIds: [taskIds.firstTaskId, taskIds.secondTaskId].sort(),
          dependencies: ['kb'],
        },
        {
          category: 'auth',
          degradedTaskCount: 1,
          findingCount: 1,
          affectedTaskIds: [taskIds.secondTaskId],
          dependencies: ['gh'],
        },
      ],
    });
    expect(diagnostics.dependencies[0]).toHaveProperty('lastOccurredAt');
    expect(diagnostics.categories[0]).toHaveProperty('lastOccurredAt');
  }

  // ---------------------------------------------------------------------------
  // GET /api/diagnostics/request-latencies
  // ---------------------------------------------------------------------------
  describe('GET /api/diagnostics/request-latencies', () => {
    test('returns an empty v1 snapshot when request duration metrics are not wired', async () => {
      const res = await mkApp({}).request('/api/diagnostics/request-latencies');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        schemaVersion: 'request-duration-metrics.v1',
        maxRoutes: 0,
        maxSamplesPerRoute: 0,
        routeCount: 0,
        droppedRouteCount: 0,
        routes: [],
      });
    });

    test('exposes count and p50/p95/p99 per route template', async () => {
      const metrics = new RequestDurationMetrics();
      for (const durationMs of [5, 10, 15, 20]) {
        metrics.record({ method: 'GET', route: '/api/tasks/:taskId/activity-diagnostics', durationMs });
      }

      const res = await mkApp({ requestDurationMetrics: metrics }).request('/api/diagnostics/request-latencies');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        schemaVersion: 'request-duration-metrics.v1',
        maxRoutes: 128,
        maxSamplesPerRoute: 256,
        routeCount: 1,
        droppedRouteCount: 0,
        routes: [{
          method: 'GET',
          route: '/api/tasks/:taskId/activity-diagnostics',
          count: 4,
          sampleCount: 4,
          p50Ms: 10,
          p95Ms: 20,
          p99Ms: 20,
        }],
      });
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/diagnostics/hot-paths
  // ---------------------------------------------------------------------------
  describe('GET /api/diagnostics/hot-paths', () => {
    test('returns a valid schema-versioned snapshot from the process-wide singleton', async () => {
      const res = await mkApp({}).request('/api/diagnostics/hot-paths');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.schemaVersion).toBe('hot-path-sampler.v1');
      expect(Array.isArray(body.windows)).toBe(true);
      expect(body.windows.map((w: { windowMinutes: number }) => w.windowMinutes)).toEqual([5, 15]);
    });

    test('ranks the top event-loop contributors from the injected sampler', async () => {
      const sampler = new HotPathSampler({ windowsMinutes: [5], topK: 10 });
      sampler.record('snapshot_rebuild', 40);
      sampler.record('task_save', 100);
      sampler.record('hook_parse', 5);

      const res = await mkApp({ hotPathSampler: sampler }).request('/api/diagnostics/hot-paths');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.windows[0].paths.map((p: { label: string }) => p.label)).toEqual([
        'task_save',
        'snapshot_rebuild',
        'hook_parse',
      ]);
      expect(body.windows[0].paths[0]).toMatchObject({ label: 'task_save', totalMs: 100 });
    });

    test('honors a ?topK query override', async () => {
      const sampler = new HotPathSampler({ windowsMinutes: [5], topK: 10 });
      sampler.record('a', 3);
      sampler.record('b', 2);
      sampler.record('c', 1);

      const res = await mkApp({ hotPathSampler: sampler }).request('/api/diagnostics/hot-paths?topK=2');
      const body = await res.json();
      expect(body.topK).toBe(2);
      expect(body.windows[0].paths.map((p: { label: string }) => p.label)).toEqual(['a', 'b']);
    });

    test('falls back to the default topK when ?topK is non-positive or non-numeric', async () => {
      const sampler = new HotPathSampler({ windowsMinutes: [5], topK: 10 });
      for (const q of ['abc', '0', '-3']) {
        const res = await mkApp({ hotPathSampler: sampler }).request(`/api/diagnostics/hot-paths?topK=${q}`);
        expect((await res.json()).topK).toBe(10);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/diagnostics/terminal-input-rtt (issue #1773)
  // ---------------------------------------------------------------------------
  describe('GET /api/diagnostics/terminal-input-rtt', () => {
    test('returns an empty v1 snapshot when the histogram is not wired', async () => {
      const res = await mkApp({}).request('/api/diagnostics/terminal-input-rtt');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        schemaVersion: 'terminal-input-rtt-metrics.v1',
        maxSamples: 0,
        count: 0,
        sampleCount: 0,
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
      });
    });

    test('exposes count and p50/p95/p99 over recorded samples', async () => {
      const metrics = new TerminalInputRttMetrics();
      for (const ms of [5, 10, 15, 20]) metrics.record(ms);

      const res = await mkApp({ terminalInputRttMetrics: metrics }).request('/api/diagnostics/terminal-input-rtt');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        schemaVersion: 'terminal-input-rtt-metrics.v1',
        maxSamples: 512,
        count: 4,
        sampleCount: 4,
        p50Ms: 10,
        p95Ms: 20,
        p99Ms: 20,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/diagnostics/auth-throttle
  // ---------------------------------------------------------------------------
  describe('GET /api/diagnostics/auth-throttle', () => {
    test('returns the shared auth throttle snapshot when wired', async () => {
      const authThrottle = new AuthThrottle({ freeFailures: 0, audit: () => {} });
      authThrottle.recordFailure('10.0.0.11', 'bad_token');

      const res = await mkApp({
        apiAuth: { required: true, token: 'secret', authThrottle },
      }).request('/api/diagnostics/auth-throttle');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(expect.objectContaining({
        schemaVersion: 'auth-throttle.v1',
        totalFailedAttempts: 1,
        lockedOutSources: [expect.objectContaining({ source: '10.0.0.11', failures: 1 })],
      }));
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/diagnostics/delivery-trace
  // ---------------------------------------------------------------------------
  describe('GET /api/diagnostics/delivery-trace', () => {
    test('returns an empty v1 snapshot when the delivery trace is not wired', async () => {
      const res = await mkApp({}).request('/api/diagnostics/delivery-trace');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        schemaVersion: 'delivery-trace.v1',
        maxRecords: 0,
        totalRecorded: 0,
        records: [],
      });
    });

    test('exposes a bounded privacy-safe delivery trace with filters and limit', async () => {
      const nowValues = [
        new Date('2026-06-13T10:00:01.000Z'),
        new Date('2026-06-13T10:00:02.000Z'),
        new Date('2026-06-13T10:00:03.000Z'),
      ];
      const deliveryTrace = new DeliveryTraceBuffer({
        maxRecords: 2,
        now: () => nowValues.shift() ?? new Date('2026-06-13T10:00:09.000Z'),
      });
      deliveryTrace.recordAdmitted({
        agentId: 'session-1',
        anomaly: anomaly({ eventId: 'evicted-event' }),
        fingerprint: 'permission_blocked::evicted',
      });
      deliveryTrace.recordSuppressed({
        agentId: 'session-2',
        anomaly: anomaly({ agentId: 'session-2', eventId: 'correlation-2' }),
        fingerprint: 'needs_input::Raw finding explanation should not be in delivery diagnostics',
      }, 'queue_snoozed');
      deliveryTrace.recordWebhookResult({
        agentId: 'session-3',
        anomaly: anomaly({ agentId: 'session-3', type: 'budget_exceeded', severity: 'critical', eventId: 'correlation-3' }),
        fingerprint: 'budget_exceeded::expensive',
      }, {
        attempt: 2,
        outcome: 'failure',
        httpStatus: 502,
      });

      const all = await mkApp({ deliveryTrace }).request('/api/diagnostics/delivery-trace');
      const allBody = await all.json();
      expect(allBody).toEqual({
        schemaVersion: 'delivery-trace.v1',
        maxRecords: 2,
        totalRecorded: 3,
        records: [
          expect.objectContaining({
            stage: 'suppressed',
            reason: 'queue_snoozed',
            agentId: 'session-2',
            correlationId: 'correlation-2',
          }),
          expect.objectContaining({
            stage: 'webhook_result',
            outcome: 'failure',
            attempt: 2,
            httpStatus: 502,
            anomalyType: 'budget_exceeded',
            severity: 'critical',
            correlationId: 'correlation-3',
          }),
        ],
      });
      expect(JSON.stringify(allBody)).not.toContain('Raw finding explanation');

      const filtered = await mkApp({ deliveryTrace }).request('/api/diagnostics/delivery-trace?correlationId=correlation-3');
      expect((await filtered.json()).records).toEqual([
        expect.objectContaining({ agentId: 'session-3', fingerprintHash: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      ]);

      const limited = await mkApp({ deliveryTrace }).request('/api/diagnostics/delivery-trace?limit=1');
      expect((await limited.json()).records).toEqual([
        expect.objectContaining({ agentId: 'session-3' }),
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/diagnostics/timer-health (issue #1771)
  // ---------------------------------------------------------------------------
  describe('GET /api/diagnostics/timer-health', () => {
    test('returns empty loops when timer health is not wired', async () => {
      const res = await mkApp({}).request('/api/diagnostics/timer-health');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        schemaVersion: 'timer-health.v1',
        generatedAt: expect.any(String),
        loops: [],
      });
    });

    test('returns the tracker snapshot when wired', async () => {
      const snapshot = {
        schemaVersion: 'timer-health.v1' as const,
        generatedAt: '2026-08-01T16:00:00.000Z',
        loops: [
          {
            name: 'tokenScan' as const,
            lastFiredAt: '2026-08-01T15:59:55.000Z',
            expectedIntervalMs: 5_000,
            overdue: false,
          },
          {
            name: 'save' as const,
            lastFiredAt: null,
            expectedIntervalMs: 60_000,
            overdue: true,
          },
        ],
      };
      const res = await mkApp({
        timerHealth: { snapshot: () => snapshot },
      }).request('/api/diagnostics/timer-health');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(snapshot);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/diagnostics/launch-outcomes (issue #1808)
  // ---------------------------------------------------------------------------
  describe('GET /api/diagnostics/launch-outcomes', () => {
    test('returns an empty snapshot when metrics are not wired', async () => {
      const res = await mkApp({}).request('/api/diagnostics/launch-outcomes');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        schemaVersion: 'launch-outcome-metrics.v1',
        totalAttempts: 0,
        totalSuccesses: 0,
        totalFailures: 0,
        byAgentType: [],
      });
    });

    test('returns per-agent failure rates when metrics are wired', async () => {
      const { LaunchOutcomeMetrics } = await import('../../core/launch-outcome-metrics.js');
      const metrics = new LaunchOutcomeMetrics();
      metrics.record({ agentType: 'grok-build', outcome: 'failure', reason: 'handshake_timeout' });
      metrics.record({ agentType: 'claude-code', outcome: 'success' });
      const res = await mkApp({ launchOutcomeMetrics: metrics }).request('/api/diagnostics/launch-outcomes');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalAttempts).toBe(2);
      expect(body.totalFailures).toBe(1);
      expect(body.byAgentType).toEqual(expect.arrayContaining([
        expect.objectContaining({
          agentType: 'grok-build',
          failures: 1,
          failureRate: 1,
          lastFailureReason: 'handshake_timeout',
        }),
        expect.objectContaining({ agentType: 'claude-code', successes: 1, failures: 0 }),
      ]));
    });
  });

  // GET /api/diagnostics/agent-boot-latency (issue #1898)
  // ---------------------------------------------------------------------------
  describe('GET /api/diagnostics/agent-boot-latency', () => {
    test('returns an empty agents list when the monitor is not wired', async () => {
      const res = await mkApp({}).request('/api/diagnostics/agent-boot-latency');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        schemaVersion: 'agent-boot-latency-diagnostics-route.v1',
        agents: [],
      });
    });

    test('surfaces which agents the failover is deprioritizing and why', async () => {
      const { AgentBootLatencyMonitor } = await import('../../core/agent-boot-latency.js');
      const monitor = new AgentBootLatencyMonitor({ minSlowSamples: 2, now: () => 1_000 });
      const hung = {
        phases: [{ phase: 'agent-boot' as const, durationMs: 90_000, completed: false }],
        totalMs: 90_000,
        incompletePhase: 'agent-boot' as const,
      };
      monitor.record('grok-build', hung);
      monitor.record('grok-build', hung);
      const res = await mkApp({ agentBootLatency: monitor }).request('/api/diagnostics/agent-boot-latency');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.schemaVersion).toBe('agent-boot-latency-diagnostics-route.v1');
      expect(body.agents).toEqual([
        { agentType: 'grok-build', samples: 2, slowSamples: 2, unhealthy: true },
      ]);
    });
  });

  // GET /api/diagnostics/hook-ingestion
  // ---------------------------------------------------------------------------
  describe('GET /api/diagnostics/hook-ingestion', () => {
    test('returns empty v1 snapshots when hook services are not wired', async () => {
      const res = await mkApp({}).request('/api/diagnostics/hook-ingestion');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        schemaVersion: 'hook-ingestion-diagnostics-route.v1',
        ingestion: expect.objectContaining({
          schemaVersion: 'hook-ingestion-diagnostics.v1',
          sessionCount: 0,
          totalArrivals: 0,
          missingWriteTimestampCount: 0,
          notableLagCount: 0,
          sessions: [],
        }),
        watcher: expect.objectContaining({
          schemaVersion: 'hook-watcher-health.v1',
          sessionCount: 0,
          sessions: [],
        }),
      });
    });

    test('returns ingestion lag and watcher health snapshots when wired', async () => {
      const ingestionSnapshot = {
        schemaVersion: 'hook-ingestion-diagnostics.v1',
        generatedAt: '2026-06-11T12:00:00.000Z',
        lagWarningThresholdMs: 2000,
        sessionCount: 1,
        totalArrivals: 2,
        missingWriteTimestampCount: 0,
        notableLagCount: 1,
        sessions: [{
          kookrSessionId: 'kookr-1',
          totalArrivals: 2,
          dispatchedArrivals: 1,
          duplicateArrivals: 1,
          missingWriteTimestampCount: 0,
          invalidWriteTimestampCount: 0,
          futureWriteTimestampCount: 0,
          notableLagCount: 1,
          lastProcessedAt: '2026-06-11T12:00:02.000Z',
          lastWriteTimestampAt: '2026-06-11T12:00:00.000Z',
          lastWriteTimestampSource: 'payload',
          lag: { count: 2, lastMs: 2000, meanMs: 1500, maxMs: 2000, p95Ms: 2000 },
          sourceCounts: { file: 1, http: 1 },
          writeTimestampSourceCounts: { payload: 2, file_mtime: 0, missing: 0, invalid: 0 },
        }],
      };
      const watcherSnapshot = {
        schemaVersion: 'hook-watcher-health.v1',
        generatedAt: '2026-06-11T12:00:00.000Z',
        sessionCount: 1,
        sessions: [{
          tmuxName: 'kookr-1',
          mode: 'fs_watch',
          offset: 123,
          pollBackupActive: true,
          replayExisting: true,
          transitionCount: 1,
          lastTransitionAt: '2026-06-11T12:00:00.000Z',
          lastTransitionReason: 'watch_started',
          readCount: 1,
          recordCount: 2,
          replayRecordCount: 2,
          pollTickCount: 1,
          pollChangeDetectedCount: 0,
          drainNowCount: 1,
          drainNowSkippedCount: 0,
          lastPollDriftMs: 0,
          maxPollDriftMs: 0,
          p95PollDriftMs: 0,
          lastDrainLatencyMs: 1,
          maxDrainLatencyMs: 1,
          p95DrainLatencyMs: 1,
          lastReadAt: '2026-06-11T12:00:01.000Z',
          lastError: null,
        }],
      };
      const res = await mkApp({
        hookIngestion: { getDiagnosticsSnapshot: () => ingestionSnapshot } as never,
        hookWatcher: { getHealthSnapshot: () => watcherSnapshot } as never,
      }).request('/api/diagnostics/hook-ingestion');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        schemaVersion: 'hook-ingestion-diagnostics-route.v1',
        ingestion: ingestionSnapshot,
        watcher: watcherSnapshot,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/health — serving SHA (issue #1750)
  // ---------------------------------------------------------------------------
  describe('GET /api/health serving SHA (issue #1750)', () => {
    test('exposes top-level sha and gitSha aliases of build.commitHash', async () => {
      const res = await mkApp({
        taskStore: new TaskStore(),
        queue: new AttentionQueue(),
        buildInfo: {
          commitHash: 'deadbeef0123456789abcdef',
          commitShort: 'deadbeef',
          branch: 'main',
          buildTimestamp: '2026-08-01T00:00:00.000Z',
          version: '1.0.0',
        },
      }).request('/api/health');

      expect(res.status).toBe(200);
      const body = await res.json() as {
        sha?: string;
        gitSha?: string;
        build: { commitHash: string };
      };
      expect(body.sha).toBe('deadbeef0123456789abcdef');
      expect(body.gitSha).toBe('deadbeef0123456789abcdef');
      expect(body.build.commitHash).toBe('deadbeef0123456789abcdef');
    });

    test('omits sha/gitSha when buildInfo has no commitHash', async () => {
      const res = await mkApp({
        taskStore: new TaskStore(),
        queue: new AttentionQueue(),
        buildInfo: {} as never,
      }).request('/api/health');

      expect(res.status).toBe(200);
      const body = await res.json() as { sha?: string; gitSha?: string };
      expect(body.sha).toBeUndefined();
      expect(body.gitSha).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/health — terminalWrite block (issue #1776)
  // ---------------------------------------------------------------------------
  describe('GET /api/health terminalWrite block', () => {
    test('always includes zeroed terminalWrite when write deps are absent', async () => {
      const res = await mkApp({
        taskStore: new TaskStore(),
        queue: new AttentionQueue(),
        buildInfo: {} as never,
      }).request('/api/health');

      expect(res.status).toBe(200);
      const body = await res.json() as {
        terminalWrite: {
          pendingWriters: number;
          maxPendingWriters: number;
          writeTimeoutCount: number;
          pendingWrites: number;
          maxPendingWrites: number;
        };
      };
      expect(body.terminalWrite).toEqual({
        pendingWriters: 0,
        maxPendingWriters: 0,
        writeTimeoutCount: 0,
        pendingWrites: 0,
        maxPendingWrites: 0,
      });
    });

    test('surfaces backend queue depth/timeouts and coordinator pendingWrites', async () => {
      const res = await mkApp({
        taskStore: new TaskStore(),
        queue: new AttentionQueue(),
        buildInfo: {} as never,
        terminalBackend: {
          getStats: () => ({
            attachedSessions: 2,
            reattachCounts: {},
            pendingWriters: 3,
            maxPendingWriters: 9,
            writeTimeoutCount: 5,
            lastError: { kind: 'write-timed-out', id: 's1', durationMs: 2000 },
            errorCount: 5,
          }),
        } as never,
        terminalInputCoordinator: {
          getWriteMetrics: () => ({ pendingWrites: 2, maxPendingWrites: 4 }),
        } as never,
      }).request('/api/health');

      expect(res.status).toBe(200);
      const body = await res.json() as {
        terminalBackend: {
          pendingWriters: number;
          maxPendingWriters: number;
          writeTimeoutCount: number;
          status: string;
        };
        terminalWrite: {
          pendingWriters: number;
          maxPendingWriters: number;
          writeTimeoutCount: number;
          pendingWrites: number;
          maxPendingWrites: number;
        };
      };
      expect(body.terminalBackend).toMatchObject({
        status: 'degraded',
        pendingWriters: 3,
        maxPendingWriters: 9,
        writeTimeoutCount: 5,
      });
      expect(body.terminalWrite).toEqual({
        pendingWriters: 3,
        maxPendingWriters: 9,
        writeTimeoutCount: 5,
        pendingWrites: 2,
        maxPendingWrites: 4,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/health — launchDependencies block
  // ---------------------------------------------------------------------------
  describe('GET /api/health launchDependencies block', () => {
    test('includes launch dependency degradation counts', async () => {
      const { taskStore, firstTaskId, secondTaskId } = createLaunchDependencyDiagnosticsFixture();

      const res = await mkApp({ taskStore, queue: new AttentionQueue(), buildInfo: {} as never }).request('/api/health');

      expect(res.status).toBe(200);
      const body = await res.json() as {
        launchDependencies: {
          schemaVersion: string;
          totalDegradedTasks: number;
          totalFindings: number;
          dependencies: Array<{
            dependency: string;
            degradedTaskCount: number;
            findingCount: number;
            affectedTaskIds: string[];
            categories: string[];
          }>;
          categories: Array<{
            category: string;
            degradedTaskCount: number;
            findingCount: number;
            affectedTaskIds: string[];
            dependencies: string[];
          }>;
        };
      };
      expectLaunchDependencyDiagnostics(body.launchDependencies, { firstTaskId, secondTaskId });
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/health — attentionQueue block
  // ---------------------------------------------------------------------------
  describe('GET /api/health attentionQueue block', () => {
    test('samples attention queue saturation gauges', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'));
      try {
        const taskStore = new TaskStore();
        const queue = new AttentionQueue();
        queue.enqueue('agent-1', anomaly({
          agentId: 'agent-1',
          type: 'needs_input',
          detectedAt: new Date('2026-01-01T00:00:00.000Z'),
        }));
        queue.enqueue('agent-2', anomaly({
          agentId: 'agent-2',
          type: 'permission_blocked',
          detectedAt: new Date('2026-01-01T00:00:30.000Z'),
        }));

        const res = await mkApp({ taskStore, queue, buildInfo: {} as never }).request('/api/health');

        expect(res.status).toBe(200);
        const body = await res.json() as {
          attentionQueue: {
            activeFindingDepth: number;
            oldestFindingAgeMs: number;
          };
        };
        expect(body.attentionQueue).toEqual({
          activeFindingDepth: 2,
          oldestFindingAgeMs: 60_000,
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/diagnostics/lesson-yield + health.lessonYield (issue #1538)
  // ---------------------------------------------------------------------------
  describe('GET /api/diagnostics/lesson-yield', () => {
    test('returns lesson-yield.v2 for completed tasks in the window', async () => {
      const kookrDir = join(tempDir, 'kookr-state');
      mkdirSync(join(kookrDir, 'hooks'), { recursive: true });
      writeFileSync(
        join(kookrDir, 'hooks', 's-write.jsonl'),
        `${JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: {
            command: 'kb remember --kb=agent-task-lessons --title=t --stdin --yes',
          },
        })}\n`,
      );

      const taskStore = new TaskStore();
      const done = taskStore.createTask('Done', '/repo');
      taskStore.addSession(done.id, {
        tmuxSession: 's-write',
        agentType: 'claude-code',
        cwd: '/repo',
        createdAt: new Date(),
      });
      taskStore.completeTask(done.id);

      const res = await mkApp({
        taskStore,
        queue: new AttentionQueue(),
        buildInfo: {} as never,
        kookrDir,
      }).request('/api/diagnostics/lesson-yield?days=1');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.schemaVersion).toBe('lesson-yield.v2');
      expect(body.windowDays).toBe(1);
      expect(body.completedInWindow).toBe(1);
      expect(body.byCompletionPath).toBeTypeOf('object');
      expect(body.contractRate).toBeTypeOf('number');
      expect(body.buckets.wroteLesson).toBe(1);
      expect(body.decided).toBe(1);
      expect(body.yieldRate).toBe(1);
    });

    test('rejects non-positive days', async () => {
      const res = await mkApp({
        taskStore: new TaskStore(),
        queue: new AttentionQueue(),
        buildInfo: {} as never,
        kookrDir: tempDir,
      }).request('/api/diagnostics/lesson-yield?days=0');
      expect(res.status).toBe(400);
    });

    test('returns 503 when kookrDir is missing', async () => {
      const res = await mkApp({
        taskStore: new TaskStore(),
        queue: new AttentionQueue(),
        buildInfo: {} as never,
      }).request('/api/diagnostics/lesson-yield');
      expect(res.status).toBe(503);
    });
  });

  describe('GET /api/health lessonYield block', () => {
    test('serves lessonYield stale-while-revalidate without awaiting a scan (issue #1553)', async () => {
      const kookrDir = join(tempDir, 'health-yield');
      mkdirSync(join(kookrDir, 'hooks'), { recursive: true });
      const taskStore = new TaskStore();
      const app = mkApp({
        taskStore,
        queue: new AttentionQueue(),
        buildInfo: {} as never,
        kookrDir,
      });
      // Cold cache: the response returns immediately WITHOUT the block — the
      // request path never awaits a hook-log scan — and triggers a bounded
      // background refresh.
      const first = await app.request('/api/health');
      expect(first.status).toBe(200);
      const firstBody = await first.json() as { lessonYield?: unknown };
      expect(firstBody.lessonYield).toBeUndefined();
      // Once the background scan lands, later polls serve the cached block.
      await vi.waitFor(async () => {
        const res = await app.request('/api/health');
        expect(res.status).toBe(200);
        const body = await res.json() as { lessonYield?: unknown };
        expect(body.lessonYield).toMatchObject({
          schemaVersion: 'lesson-yield.v2',
          windowDays: 1,
        });
      });
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/health — capacity block (issue #1526 Phase B / FM9)
  // ---------------------------------------------------------------------------
  describe('GET /api/health capacity block', () => {
    test('classifies a mix of tasks into exact byClass counts, with oldest ages from a fixed clock', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-24T12:00:00.000Z'));
      try {
        const taskStore = new TaskStore();
        const queue = new AttentionQueue();
        const watchdog = new Watchdog();

        // working: inProgress, no pendingSignal, watchdog reports nothing queued.
        const working = taskStore.createTask('Working task', '/repo');
        taskStore.addSession(working.id, {
          tmuxSession: 'kookr-working', agentType: 'claude-code', cwd: '/repo-wt', createdAt: new Date(),
        });

        // finishedAwaitingAck: inProgress + pendingSignal completion_ready, raised 5 minutes ago.
        const awaitingAck = taskStore.createTask('Finished task', '/repo');
        taskStore.addSession(awaitingAck.id, {
          tmuxSession: 'kookr-ack', agentType: 'claude-code', cwd: '/repo-wt', createdAt: new Date(),
        });
        taskStore.setPendingSignal(awaitingAck.id, {
          kind: 'completion_ready',
          raisedAt: '2026-07-24T11:55:00.000Z', // 5 minutes before "now"
        });

        // hungSuspect: inProgress with a queued stale_agent verdict — this is
        // the incident's 33h-hung task, made visible instead of showing "running".
        const hung = taskStore.createTask('Hung task', '/repo');
        taskStore.addSession(hung.id, {
          tmuxSession: 'kookr-hung', agentType: 'claude-code', cwd: '/repo-wt', createdAt: new Date(),
        });
        queue.enqueue('kookr-hung', anomaly({
          agentId: 'kookr-hung',
          type: 'stale_agent',
          severity: 'warning',
          detectedAt: new Date('2026-07-24T09:00:00.000Z'),
        }));

        // launching: open task mid-launch (fresh reservation, no session attached yet).
        const launching = taskStore.createTask('Launching task', '/repo');
        taskStore.beginLaunch(launching.id);

        // pending backlog: two tasks queued, no reservation. Oldest is 90s old
        // ("now" - createdAt), created before the other fixtures above.
        vi.setSystemTime(new Date('2026-07-24T11:58:30.000Z'));
        const pendingOlder = taskStore.createTask('Queued older', '/repo');
        taskStore.pendTask(pendingOlder.id);
        vi.setSystemTime(new Date('2026-07-24T11:59:00.000Z'));
        const pendingNewer = taskStore.createTask('Queued newer', '/repo');
        taskStore.pendTask(pendingNewer.id);
        vi.setSystemTime(new Date('2026-07-24T12:00:00.000Z'));

        // Terminal task — must not be counted at all.
        const done = taskStore.createTask('Done task', '/repo');
        taskStore.addSession(done.id, {
          tmuxSession: 'kookr-done', agentType: 'claude-code', cwd: '/repo-wt', createdAt: new Date(),
        });
        taskStore.completeTask(done.id);

        const res = await mkApp({
          taskStore,
          queue,
          watchdog,
          buildInfo: {} as never,
          getMaxActiveTasks: () => 10,
        }).request('/api/health');

        expect(res.status).toBe(200);
        const body = await res.json() as {
          capacity: {
            maxActiveTasks: number;
            active: number;
            free: number;
            byClass: { working: number; finishedAwaitingAck: number; hungSuspect: number; launching: number };
            pendingQueueDepth: number;
            oldestPendingAgeMs: number | null;
            oldestFinishedAwaitingAckAgeMs: number | null;
          };
        };

        expect(body.capacity).toEqual({
          maxActiveTasks: 10,
          active: 4,
          free: 6,
          byClass: { working: 1, finishedAwaitingAck: 1, hungSuspect: 1, launching: 1 },
          effectiveWorking: 2, // working + launching
          phantomActive: 2, // hungSuspect + finishedAwaitingAck
          pendingQueueDepth: 2,
          oldestPendingAgeMs: 90_000,
          oldestFinishedAwaitingAckAgeMs: 5 * 60_000,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    test('defaults maxActiveTasks to the static config constant when getMaxActiveTasks is not wired', async () => {
      const res = await mkApp({
        taskStore: new TaskStore(),
        queue: new AttentionQueue(),
        buildInfo: {} as never,
      }).request('/api/health');

      expect(res.status).toBe(200);
      const body = await res.json() as { capacity: { maxActiveTasks: number; active: number; free: number } };
      expect(body.capacity.maxActiveTasks).toBe(10); // MAX_ACTIVE_TASKS
      expect(body.capacity.active).toBe(0);
      expect(body.capacity.free).toBe(10);
    });

    test('an empty task store reports all-zero counts and null oldest ages', async () => {
      const res = await mkApp({
        taskStore: new TaskStore(),
        queue: new AttentionQueue(),
        buildInfo: {} as never,
      }).request('/api/health');

      const body = await res.json() as {
        capacity: {
          byClass: Record<string, number>;
          pendingQueueDepth: number;
          oldestPendingAgeMs: number | null;
          oldestFinishedAwaitingAckAgeMs: number | null;
        };
      };
      expect(body.capacity.byClass).toEqual({ working: 0, finishedAwaitingAck: 0, hungSuspect: 0, launching: 0 });
      expect(body.capacity.pendingQueueDepth).toBe(0);
      expect(body.capacity.oldestPendingAgeMs).toBeNull();
      expect(body.capacity.oldestFinishedAwaitingAckAgeMs).toBeNull();
    });

    test('surfaces the reserved self-maintenance reservation when settings are wired (issue #1564)', async () => {
      const res = await mkApp({
        taskStore: new TaskStore(),
        queue: new AttentionQueue(),
        buildInfo: {} as never,
        getMaxActiveTasks: () => 10,
        settings: {
          get: () => ({ reservedActiveSlots: 3, reservedSlotSources: ['kookr'] } as never),
          getLoadedFromDefaults: () => false,
          update: async () => [],
        },
      }).request('/api/health');

      expect(res.status).toBe(200);
      const body = await res.json() as {
        capacity: {
          maxActiveTasks: number;
          reservedActiveSlots?: number;
          reservedSlotSources?: string[];
          freeForReservedSources?: number;
          freeForGeneralSources?: number;
        };
      };
      expect(body.capacity.reservedActiveSlots).toBe(3);
      expect(body.capacity.reservedSlotSources).toEqual(['kookr']);
      // Idle store: reserved sources see the whole pool, general sources see it minus the reservation.
      expect(body.capacity.freeForReservedSources).toBe(10);
      expect(body.capacity.freeForGeneralSources).toBe(7);
    });

    test('omits the reservation block when settings are not wired', async () => {
      const res = await mkApp({
        taskStore: new TaskStore(),
        queue: new AttentionQueue(),
        buildInfo: {} as never,
      }).request('/api/health');
      const body = await res.json() as { capacity: { reservedActiveSlots?: number } };
      expect(body.capacity.reservedActiveSlots).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/health — hungSuspectTtlReclaim block (issue #1989)
  // ---------------------------------------------------------------------------
  describe('GET /api/health hungSuspectTtlReclaim block (issue #1989)', () => {
    test('omits the block when reclaim metrics are not wired', async () => {
      const res = await mkApp({
        taskStore: new TaskStore(),
        queue: new AttentionQueue(),
        buildInfo: {} as never,
      }).request('/api/health');
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty('hungSuspectTtlReclaim');
    });

    test('includes reclaimedTotal and increments after a reclaim', async () => {
      const metrics = new HungSuspectTtlReclaimMetrics();
      const baseDeps = {
        taskStore: new TaskStore(),
        queue: new AttentionQueue(),
        buildInfo: {} as never,
        hungSuspectTtlReclaimMetrics: metrics,
      };

      const before = await mkApp(baseDeps).request('/api/health');
      expect(before.status).toBe(200);
      const beforeBody = (await before.json()) as {
        hungSuspectTtlReclaim?: { reclaimedTotal: number };
      };
      expect(beforeBody.hungSuspectTtlReclaim).toEqual({ reclaimedTotal: 0 });

      metrics.recordReclaimed(2);

      const after = await mkApp(baseDeps).request('/api/health');
      expect(after.status).toBe(200);
      const afterBody = (await after.json()) as {
        hungSuspectTtlReclaim?: { reclaimedTotal: number };
      };
      expect(afterBody.hungSuspectTtlReclaim).toEqual({ reclaimedTotal: 2 });
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/health — prodSmokeTick block (issue #2031)
  // ---------------------------------------------------------------------------
  describe('GET /api/health prodSmokeTick block (issue #2031)', () => {
    test('omits the block when the tick is disabled (dep not wired)', async () => {
      const res = await mkApp({
        taskStore: new TaskStore(),
        queue: new AttentionQueue(),
        buildInfo: {} as never,
      }).request('/api/health');
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty('prodSmokeTick');
    });

    test('projects status, consecutiveFailures, and failingChecks from a fixture alert artifact', async () => {
      // Fixture-style stub: getHealthSnapshot returns what a real tick would
      // project after reading prod-smoke-tick-alert.json (no smoke checks run).
      const fixtureSnapshot = {
        schemaVersion: 'prod-smoke-tick.v1' as const,
        status: 'alert' as const,
        consecutiveFailures: 113,
        failingChecks: ['health'],
        generatedAt: '2026-08-04T12:00:00.000Z',
        firstFailedAt: '2026-07-30T12:00:00.000Z',
      };
      const getHealthSnapshot = vi.fn(() => fixtureSnapshot);

      const res = await mkApp({
        taskStore: new TaskStore(),
        queue: new AttentionQueue(),
        buildInfo: {} as never,
        prodSmokeTick: { getHealthSnapshot },
      }).request('/api/health');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        prodSmokeTick?: typeof fixtureSnapshot;
      };
      expect(body.prodSmokeTick).toEqual(fixtureSnapshot);
      expect(getHealthSnapshot).toHaveBeenCalledTimes(1);
    });

    test('projects null-safe empty when tick is enabled but no artifact exists yet', async () => {
      const getHealthSnapshot = vi.fn(() => ({
        schemaVersion: 'prod-smoke-tick.v1' as const,
        status: 'unknown' as const,
        consecutiveFailures: 0,
        failingChecks: [] as string[],
      }));

      const res = await mkApp({
        taskStore: new TaskStore(),
        queue: new AttentionQueue(),
        buildInfo: {} as never,
        prodSmokeTick: { getHealthSnapshot },
      }).request('/api/health');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        prodSmokeTick?: { status: string; consecutiveFailures: number; failingChecks: string[] };
      };
      expect(body.prodSmokeTick).toEqual({
        schemaVersion: 'prod-smoke-tick.v1',
        status: 'unknown',
        consecutiveFailures: 0,
        failingChecks: [],
      });
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/health — viewerBroadcaster block (#808 / R10)
  // ---------------------------------------------------------------------------
  describe('GET /api/health viewerBroadcaster block', () => {
    test('omits the block when the share feature is not wired', async () => {
      const res = await mkApp({
        taskStore: new TaskStore(),
        queue: new AttentionQueue(),
        buildInfo: {} as never,
      }).request('/api/health');
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty('viewerBroadcaster');
    });

    test('reports sweep liveness + grant-store writability when wired', async () => {
      const grantStore = new ViewerGrantStore(tempDir);
      await grantStore.load();
      const registry = new ViewerConnectionRegistry({ autoStartSweep: false, sweepIntervalMs: 10_000 });
      const auditLog = new CollaborationAuditLog({ kookrDir: tempDir });
      const res = await mkApp({
        taskStore: new TaskStore(),
        queue: new AttentionQueue(),
        buildInfo: {} as never,
        viewerShare: { grantStore, registry, auditLog },
      }).request('/api/health');
      registry.stopSweep();

      expect(res.status).toBe(200);
      const body = (await res.json()) as { viewerBroadcaster?: Record<string, unknown> };
      expect(body.viewerBroadcaster).toEqual({
        sweepIntervalMs: 10_000,
        lastSweepAt: null,
        sweepTickCount: 0,
        connectedViewerCount: 0,
        grantStoreWritable: true,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/health/stt
  // ---------------------------------------------------------------------------
  describe('GET /api/health/stt', () => {
    test('returns {status:"disabled"} when sttUrl is not configured', async () => {
      const res = await mkApp({}).request('/api/health/stt');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'disabled' });
    });

    test('returns {status:"unavailable"} with 200 when STT service is unreachable', async () => {
      // Connecting to port 1 on loopback fails fast with ECONNREFUSED —
      // handler is documented to return 200 with status:"unavailable" so the
      // polling UI does not fire fetch() error handlers.
      const res = await mkApp({ sttUrl: 'ws://127.0.0.1:1' }).request('/api/health/stt');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('unavailable');
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/health/tts
  // ---------------------------------------------------------------------------
  describe('GET /api/health/tts', () => {
    test('returns {status:"disabled"} when ttsUrl is not configured', async () => {
      const res = await mkApp({}).request('/api/health/tts');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'disabled' });
    });

    test('returns the TTS service health response when reachable', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'ok' }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

      const res = await mkApp({ ttsUrl: 'http://tts.local/' }).request('/api/health/tts');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
      expect(fetchSpy).toHaveBeenCalledWith('http://tts.local/health', {
        signal: expect.any(AbortSignal),
      });
      expect(timeoutSpy).toHaveBeenCalledWith(3000);
    });

    test('returns {status:"unavailable"} with 200 when TTS service reports unhealthy', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: 'Model not loaded' }), { status: 503 }),
      );

      const res = await mkApp({ ttsUrl: 'http://tts.local' }).request('/api/health/tts');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'unavailable' });
    });

    test('returns {status:"unavailable"} with 200 when TTS service is unreachable', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('connection refused'));

      const res = await mkApp({ ttsUrl: 'http://tts.local' }).request('/api/health/tts');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'unavailable' });
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/diagnostics/launch-dependencies
  // ---------------------------------------------------------------------------
  describe('GET /api/diagnostics/launch-dependencies', () => {
    test('aggregates degraded launch dependencies', async () => {
      const { taskStore, firstTaskId, secondTaskId } = createLaunchDependencyDiagnosticsFixture();

      const res = await mkApp({ taskStore }).request('/api/diagnostics/launch-dependencies');

      expect(res.status).toBe(200);
      const body = await res.json() as Parameters<typeof expectLaunchDependencyDiagnostics>[0];
      expectLaunchDependencyDiagnostics(body, { firstTaskId, secondTaskId });
    });

    test('returns an empty launch dependency diagnostics snapshot without degraded tasks', async () => {
      const res = await mkApp({ taskStore: new TaskStore() }).request('/api/diagnostics/launch-dependencies');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        schemaVersion: 'launch-dependency-diagnostics.v1',
        totalDegradedTasks: 0,
        totalFindings: 0,
        dependencies: [],
        categories: [],
      });
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/ready  (issue #660 — subsystem-aware readiness verdict)
  // ---------------------------------------------------------------------------
  describe('GET /api/ready', () => {
    function backend(stats: Partial<{
      attachedSessions: number;
      reattachCounts: Record<string, number>;
      pendingWriters: number;
      maxPendingWriters: number;
      writeTimeoutCount: number;
      lastError: { kind: string } | null;
      errorCount: number;
    }>) {
      return {
        getStats: () => ({
          attachedSessions: 0,
          reattachCounts: {},
          pendingWriters: 0,
          maxPendingWriters: 0,
          writeTimeoutCount: 0,
          lastError: null,
          errorCount: 0,
          ...stats,
        }),
      };
    }

    test('healthy terminal backend + writable persistence ⇒ 200 ready', async () => {
      const res = await mkApp({
        terminalBackend: backend({}) as never,
        kookrDir: tempDir,
      }).request('/api/ready');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ready: true,
        checks: {
          terminalBackend: { critical: true, ready: true, status: 'ok' },
          persistence: { critical: true, ready: true, status: 'ok' },
        },
      });
    });

    test('terminal backend in error (dtach-unavailable) ⇒ 503 not ready', async () => {
      const res = await mkApp({
        terminalBackend: backend({ lastError: { kind: 'dtach-unavailable' }, errorCount: 1 }) as never,
        kookrDir: tempDir,
      }).request('/api/ready');

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.ready).toBe(false);
      expect(body.checks.terminalBackend).toEqual({ critical: true, ready: false, status: 'error' });
      expect(body.checks.persistence.ready).toBe(true);
    });

    test('terminal backend degraded (pending writers) ⇒ 200 ready, fail-open', async () => {
      const res = await mkApp({
        terminalBackend: backend({ pendingWriters: 2 }) as never,
        kookrDir: tempDir,
      }).request('/api/ready');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ready).toBe(true);
      expect(body.checks.terminalBackend).toEqual({ critical: true, ready: true, status: 'degraded' });
    });

    test('accepting drain controller ⇒ 200 ready with accepting drain check', async () => {
      const drainController = new DrainController();
      const res = await mkApp({
        terminalBackend: backend({}) as never,
        kookrDir: tempDir,
        drainController,
      }).request('/api/ready');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ready).toBe(true);
      expect(body.checks.drainMode).toEqual({ critical: true, ready: true, status: 'accepting' });
    });

    test('draining drain controller ⇒ 503 not ready so orchestrators cordon the node', async () => {
      const drainController = new DrainController();
      drainController.drain(new Date('2026-06-27T12:00:00.000Z'));

      const res = await mkApp({
        terminalBackend: backend({}) as never,
        kookrDir: tempDir,
        drainController,
      }).request('/api/ready');

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.ready).toBe(false);
      expect(body.checks.drainMode).toEqual({
        critical: true,
        ready: false,
        status: 'draining',
        reason: 'drain-mode',
      });
      expect(body.checks.terminalBackend.ready).toBe(true);
      expect(body.checks.persistence.ready).toBe(true);
    });

    test('unwritable persistence directory ⇒ 503 not ready', async () => {
      const res = await mkApp({
        terminalBackend: backend({}) as never,
        kookrDir: join(tempDir, 'does-not-exist'),
      }).request('/api/ready');

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.ready).toBe(false);
      expect(body.checks.persistence.ready).toBe(false);
      expect(body.checks.persistence.status).toBe('error');
      expect(typeof body.checks.persistence.reason).toBe('string');
    });

    test('no terminal backend wired + no kookrDir ⇒ 200 ready (fail-open)', async () => {
      const res = await mkApp({}).request('/api/ready');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ready: true,
        checks: {
          persistence: { critical: true, ready: true, status: 'unknown', reason: 'kookr-dir-unset' },
        },
      });
    });

    test('startup readiness gate 503 while recovering, 200 once ready (issue #1721)', async () => {
      const { StartupReadiness } = await import('../startup-readiness.js');
      const gate = new StartupReadiness('2026-07-30T21:27:39.918Z');
      gate.markRecovering('session reattach');

      const recovering = await mkApp({
        terminalBackend: backend({}) as never,
        kookrDir: tempDir,
        startupReadiness: gate,
      }).request('/api/ready');
      expect(recovering.status).toBe(503);
      const recoveringBody = await recovering.json();
      expect(recoveringBody.ready).toBe(false);
      expect(recoveringBody.checks.startup).toEqual({
        critical: true,
        ready: false,
        status: 'recovering',
        reason: 'startup-in-progress',
        detail: 'session reattach',
      });

      gate.markReady();
      const ready = await mkApp({
        terminalBackend: backend({}) as never,
        kookrDir: tempDir,
        startupReadiness: gate,
      }).request('/api/ready');
      expect(ready.status).toBe(200);
      const readyBody = await ready.json();
      expect(readyBody.ready).toBe(true);
      expect(readyBody.checks.startup).toEqual({
        critical: true,
        ready: true,
        status: 'ready',
      });
    });

    // Issue #1707 — schedule-runner tick liveness on /api/ready
    function scheduleService(snapshot: Partial<ScheduleStatusSnapshot>) {
      return {
        getStatusSnapshot: () =>
          ({
            timezone: 'UTC',
            catchUpMode: 'manual' as const,
            catchUpEnabled: false,
            schedulerHealthy: true,
            ...snapshot,
          }) satisfies ScheduleStatusSnapshot,
      };
    }

    test('recent lastTickCompletedAt ⇒ 200 ready with schedulerTick ok (issue #1707)', async () => {
      const res = await mkApp({
        terminalBackend: backend({}) as never,
        kookrDir: tempDir,
        scheduleService: scheduleService({
          lastTickCompletedAt: new Date().toISOString(),
          runnerStartedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        }) as never,
      }).request('/api/ready');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ready).toBe(true);
      expect(body.checks.schedulerTick).toEqual({
        critical: true,
        ready: true,
        status: 'ok',
      });
    });

    test('stale lastTickCompletedAt beyond N tick-intervals ⇒ 503 not ready (issue #1707)', async () => {
      const staleAgeMs =
        SCHEDULE_TICK_INTERVAL_MS * SCHEDULER_TICK_STALE_INTERVALS + 1_000;
      const res = await mkApp({
        terminalBackend: backend({}) as never,
        kookrDir: tempDir,
        scheduleService: scheduleService({
          lastTickCompletedAt: new Date(Date.now() - staleAgeMs).toISOString(),
          runnerStartedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        }) as never,
      }).request('/api/ready');

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.ready).toBe(false);
      expect(body.checks.schedulerTick).toEqual(expect.objectContaining({
        critical: true,
        ready: false,
        status: 'stale',
        reason: 'tick-stale',
      }));
      expect(typeof body.checks.schedulerTick.detail).toBe('string');
      // Other critical checks still pass — only schedulerTick flips the verdict.
      expect(body.checks.terminalBackend.ready).toBe(true);
      expect(body.checks.persistence.ready).toBe(true);
    });

    test('fresh runnerStartedAt without a completed tick yet ⇒ 200 awaiting-first-tick (issue #1707)', async () => {
      const res = await mkApp({
        terminalBackend: backend({}) as never,
        kookrDir: tempDir,
        scheduleService: scheduleService({
          runnerStartedAt: new Date().toISOString(),
        }) as never,
      }).request('/api/ready');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ready).toBe(true);
      expect(body.checks.schedulerTick).toEqual({
        critical: true,
        ready: true,
        status: 'awaiting-first-tick',
      });
    });

    test('no scheduleService wired ⇒ no schedulerTick check (fail-open)', async () => {
      const res = await mkApp({
        terminalBackend: backend({}) as never,
        kookrDir: tempDir,
      }).request('/api/ready');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.checks.schedulerTick).toBeUndefined();
    });

    test('checkSchedulerTickReadiness pure helper: boundary and invalid timestamp', () => {
      const now = Date.parse('2026-08-01T12:00:00.000Z');
      const justInside = new Date(
        now - SCHEDULE_TICK_INTERVAL_MS * SCHEDULER_TICK_STALE_INTERVALS,
      ).toISOString();
      const justOutside = new Date(
        now - SCHEDULE_TICK_INTERVAL_MS * SCHEDULER_TICK_STALE_INTERVALS - 1,
      ).toISOString();

      expect(checkSchedulerTickReadiness({ lastTickCompletedAt: justInside }, now)).toEqual({
        critical: true,
        ready: true,
        status: 'ok',
      });
      expect(checkSchedulerTickReadiness({ lastTickCompletedAt: justOutside }, now)).toEqual(
        expect.objectContaining({
          critical: true,
          ready: false,
          status: 'stale',
          reason: 'tick-stale',
        }),
      );
      expect(checkSchedulerTickReadiness({}, now)).toEqual({
        critical: true,
        ready: true,
        status: 'starting',
        reason: 'runner-not-started',
      });
      expect(checkSchedulerTickReadiness({ lastTickCompletedAt: 'not-a-date' }, now)).toEqual({
        critical: true,
        ready: false,
        status: 'error',
        reason: 'invalid-timestamp',
      });
    });

    // Issue #1870 — non-critical hook-ingestion lag visibility on /api/ready
    function sessionLag(lastMs: number | null, overrides: { kookrSessionId?: string } = {}) {
      return {
        kookrSessionId: overrides.kookrSessionId ?? 'kookr-1',
        totalArrivals: 1,
        dispatchedArrivals: 1,
        duplicateArrivals: 0,
        missingWriteTimestampCount: 0,
        invalidWriteTimestampCount: 0,
        futureWriteTimestampCount: 0,
        notableLagCount: lastMs != null && lastMs > 2000 ? 1 : 0,
        startupReplayArrivalCount: 0,
        lastProcessedAt: '2026-08-01T12:00:00.000Z',
        lastWriteTimestampAt: '2026-08-01T12:00:00.000Z',
        lastWriteTimestampSource: 'payload' as const,
        lag: { count: 1, lastMs, meanMs: lastMs, maxMs: lastMs, p95Ms: lastMs },
        sourceCounts: { file: 1, http: 0 },
        writeTimestampSourceCounts: { payload: 1, file_mtime: 0, missing: 0, invalid: 0 },
      };
    }

    test('healthy hook ingestion lag ⇒ 200 ready with non-critical hookIngestion ok (issue #1870)', async () => {
      const res = await mkApp({
        terminalBackend: backend({}) as never,
        kookrDir: tempDir,
        hookIngestion: {
          getDiagnosticsSnapshot: () => ({
            schemaVersion: 'hook-ingestion-diagnostics.v1',
            generatedAt: '2026-08-01T12:00:00.000Z',
            lagWarningThresholdMs: 2000,
            sessionCount: 1,
            totalArrivals: 1,
            missingWriteTimestampCount: 0,
            notableLagCount: 0,
            sessions: [sessionLag(500)],
          }),
        } as never,
      }).request('/api/ready');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ready).toBe(true);
      expect(body.checks.hookIngestion).toEqual({
        critical: false,
        ready: true,
        status: 'ok',
      });
    });

    test('stalled hook ingestion lag ⇒ check ready:false but overall 200 (non-critical, issue #1870)', async () => {
      const res = await mkApp({
        terminalBackend: backend({}) as never,
        kookrDir: tempDir,
        hookIngestion: {
          getDiagnosticsSnapshot: () => ({
            schemaVersion: 'hook-ingestion-diagnostics.v1',
            generatedAt: '2026-08-01T12:00:00.000Z',
            lagWarningThresholdMs: 2000,
            sessionCount: 1,
            totalArrivals: 2,
            missingWriteTimestampCount: 0,
            notableLagCount: 1,
            sessions: [sessionLag(5000)],
          }),
        } as never,
      }).request('/api/ready');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ready).toBe(true);
      expect(body.checks.hookIngestion).toEqual({
        critical: false,
        ready: false,
        status: 'stalled',
        reason: 'ingestion-lag',
        detail: 'last lag 5000ms exceeds threshold 2000ms across 1 session(s)',
      });
      // Critical checks still pass — only hookIngestion is not-ready.
      expect(body.checks.terminalBackend.ready).toBe(true);
      expect(body.checks.persistence.ready).toBe(true);
    });

    test('no hookIngestion wired ⇒ no hookIngestion check (fail-open)', async () => {
      const res = await mkApp({
        terminalBackend: backend({}) as never,
        kookrDir: tempDir,
      }).request('/api/ready');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.checks.hookIngestion).toBeUndefined();
    });

    test('checkHookIngestionReadiness pure helper: idle, ok, stalled', () => {
      expect(
        checkHookIngestionReadiness({
          lagWarningThresholdMs: 2000,
          sessionCount: 0,
          sessions: [],
        }),
      ).toEqual({ critical: false, ready: true, status: 'idle' });

      expect(
        checkHookIngestionReadiness({
          lagWarningThresholdMs: 2000,
          sessionCount: 1,
          sessions: [sessionLag(2000)],
        }),
      ).toEqual({ critical: false, ready: true, status: 'ok' });

      expect(
        checkHookIngestionReadiness({
          lagWarningThresholdMs: 2000,
          sessionCount: 2,
          sessions: [sessionLag(100, { kookrSessionId: 'a' }), sessionLag(9000, { kookrSessionId: 'b' })],
        }),
      ).toEqual({
        critical: false,
        ready: false,
        status: 'stalled',
        reason: 'ingestion-lag',
        detail: 'last lag 9000ms exceeds threshold 2000ms across 1 session(s)',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/anomaly-stats
  // ---------------------------------------------------------------------------
  describe('GET /api/anomaly-stats', () => {
    test('returns current DetectionStats shape', async () => {
      recordSuppression('hook_disconnected', 'systemic_hook_stall');

      const res = await mkApp({}).request('/api/anomaly-stats');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual(expect.objectContaining({
        checks: expect.any(Object),
        fires: expect.any(Object),
        falsePositives: expect.any(Object),
        suppressed: expect.any(Object),
        suppressionReasons: expect.any(Object),
        subagentOrphans: expect.any(Number),
        subagentSessionsWithOrphans: expect.any(Number),
        subagentTtlEvictions: expect.any(Number),
      }));
      expect(body.suppressionReasons.hook_disconnected.systemic_hook_stall).toBe(1);
    });

    test('#1653: includes the stuckFlagPrecision counters and derived ratio', async () => {
      resetStuckFlagPrecision();
      recordWaitingOnInputOutcome('agent-a', 'flag');
      recordWaitingOnInputOutcome('agent-b', 'suppressed');

      const res = await mkApp({}).request('/api/anomaly-stats');
      const body = await res.json();
      expect(body.stuckFlagPrecision).toEqual({ flags: 1, suppressed: 1, precision: 0.5 });
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/live-friction-calibration
  // ---------------------------------------------------------------------------
  describe('GET /api/live-friction-calibration', () => {
    test('returns diagnostics-only calibration without mutating the active queue', async () => {
      const logPath = join(tempDir, 'session', 'interactions.jsonl');
      mkdirSync(join(tempDir, 'session'), { recursive: true });
      writeFileSync(logPath, [
        JSON.stringify({ type: 'finding_skipped', agentId: 'agent-1', anomalyType: 'needs_input', timestamp: '2026-05-21T12:01:00.000Z' }),
        JSON.stringify({ type: 'finding_resolved', agentId: 'agent-1', anomalyType: 'needs_input', method: 'skip', durationMs: 1000, timestamp: '2026-05-21T12:01:00.000Z' }),
        JSON.stringify({ type: 'finding_skipped', agentId: 'agent-2', anomalyType: 'needs_input', timestamp: '2026-05-21T12:02:00.000Z' }),
        JSON.stringify({ type: 'finding_resolved', agentId: 'agent-2', anomalyType: 'needs_input', method: 'skip', durationMs: 1000, timestamp: '2026-05-21T12:02:00.000Z' }),
      ].join('\n'));

      const queue = new AttentionQueue();
      queue.enqueue('agent-3', {
        type: 'needs_input',
        severity: 'info',
        confidence: 'high',
        explanation: 'waiting',
        agentId: 'agent-3',
        detectedAt: new Date('2026-05-21T12:00:00.000Z'),
      });
      queue.enqueue('agent-4', {
        type: 'permission_blocked',
        severity: 'warning',
        confidence: 'high',
        explanation: 'permission',
        agentId: 'agent-4',
        detectedAt: new Date('2026-05-21T11:55:00.000Z'),
      });
      queue.snooze('agent-4', -1);
      const beforeActive = queue.inspectActive().map((entry) => entry.agentId);
      const beforeSnoozed = queue.getSnoozed().map((entry) => entry.agentId);
      const interactionLog = { getFilePath: () => logPath };

      const res = await mkApp({ queue, interactionLog: interactionLog as never }).request('/api/live-friction-calibration');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual(expect.objectContaining({
        schemaVersion: 'live-friction-calibration.v1',
        mode: 'diagnostics_only',
        routingMutationAllowed: false,
        interactionCount: 4,
        activeFindingCount: 1,
      }));
      expect(body.recommendations).toEqual([
        expect.objectContaining({
          id: 'down-weight:needs_input',
          affectedActiveAgentIds: ['agent-3'],
          wouldMutateQueue: false,
        }),
      ]);
      expect(queue.inspectActive().map((entry) => entry.agentId)).toEqual(beforeActive);
      expect(queue.getSnoozed().map((entry) => entry.agentId)).toEqual(beforeSnoozed);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/finding-evidence-audit
  // ---------------------------------------------------------------------------
  describe('GET /api/finding-evidence-audit', () => {
    test('returns records and review candidates from the monitor', async () => {
      const record = {
        id: 'finding-1',
        agentId: 'agent-1',
        anomalyType: 'needs_input',
        explanation: 'Waiting',
        detectedAt: '2026-05-18T10:00:00.000Z',
        updatedAt: '2026-05-18T10:00:05.000Z',
        status: 'active',
        verdict: 'supports_finding',
        observations: [],
        notes: [],
      };
      const monitor = {
        getFindingEvidenceAuditRecords: () => [record],
        getFindingEvidenceReviewCandidates: (limit: number) => [{ ...record, id: `candidate-${limit}` }],
      };

      const res = await mkApp({ monitor: monitor as never }).request('/api/finding-evidence-audit');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        records: [record],
        reviewCandidates: [{ ...record, id: 'candidate-20' }],
      });
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/finding-evidence-review
  // ---------------------------------------------------------------------------
  describe('POST /api/finding-evidence-review', () => {
    function reviewRecord() {
      return {
        id: 'finding-1',
        agentId: 'agent-1',
        anomalyType: 'needs_input',
        explanation: 'Raw explanation must stay private',
        detectedAt: '2026-05-18T10:00:00.000Z',
        updatedAt: '2026-05-18T10:00:12.000Z',
        status: 'active',
        verdict: 'possible_false_positive',
        observations: [
          {
            sampledAt: '2026-05-18T10:00:12.000Z',
            ageMs: 12_000,
            source: 'watchdog_tick',
            anomalyStillPresent: true,
            lastEventType: 'tool_use',
            eventCount: 5,
            paneExcerpt: 'Raw terminal text must stay private',
          },
        ],
        notes: ['private note'],
      };
    }

    function reviewDeps(llmClient: LlmClient | null = fakeLlm(null)): Partial<RouteDeps> {
      const monitor = {
        getFindingEvidenceReviewCandidates: () => [reviewRecord()],
        getFindingEvidenceAuditRecords: () => [reviewRecord()],
      };
      return {
        monitor: monitor as never,
        llmClient,
        kookrDir: tempDir,
        findingEvidenceReviewHmacKey: Buffer.from('0123456789abcdef0123456789abcdef'),
        buildInfo: {
          commitHash: 'abc123',
          commitShort: 'abc123',
          branch: 'test',
          buildTimestamp: '',
          version: 'test',
        },
      };
    }

    test('fails closed when the feature flag is disabled', async () => {
      const res = await mkApp(reviewDeps()).request('http://127.0.0.1/api/finding-evidence-review', {
        method: 'POST',
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'finding-review-disabled' });
    });

    test('requires an LLM provider even for estimate_only', async () => {
      process.env.KOOKR_FINDING_REVIEW_ENABLED = 'true';
      const res = await mkApp(reviewDeps(null)).request('http://127.0.0.1/api/finding-evidence-review', {
        method: 'POST',
      });

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'finding-review-llm-unavailable' });
    });

    test('rejects non-loopback requests and ignores forwarded loopback headers', async () => {
      process.env.KOOKR_FINDING_REVIEW_ENABLED = 'true';
      const res = await mkApp(reviewDeps()).request('http://example.com/api/finding-evidence-review', {
        method: 'POST',
        headers: { 'x-forwarded-for': '127.0.0.1' },
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'finding-review-forbidden' });
    });

    test('allows a configured admin token on a non-loopback request', async () => {
      process.env.KOOKR_FINDING_REVIEW_ENABLED = 'true';
      process.env.KOOKR_FINDING_REVIEW_ADMIN_TOKEN = 'admin-secret';
      const res = await mkApp(reviewDeps()).request('http://example.com/api/finding-evidence-review', {
        method: 'POST',
        headers: { 'x-kookr-admin-token': 'admin-secret' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.mode).toBe('estimate_only');
    });

    test('rejects wrong, short, and empty admin tokens on a non-loopback request', async () => {
      process.env.KOOKR_FINDING_REVIEW_ENABLED = 'true';
      process.env.KOOKR_FINDING_REVIEW_ADMIN_TOKEN = 'admin-secret';

      for (const presentedToken of ['admin-secreu', 'admin', '']) {
        const res = await mkApp(reviewDeps()).request('http://example.com/api/finding-evidence-review', {
          method: 'POST',
          headers: { 'x-kookr-admin-token': presentedToken },
        });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'finding-review-forbidden' });
      }
    });

    test('allows the correct review CSRF token when configured', async () => {
      process.env.KOOKR_FINDING_REVIEW_ENABLED = 'true';
      process.env.KOOKR_FINDING_REVIEW_ADMIN_TOKEN = 'admin-secret';
      process.env.KOOKR_FINDING_REVIEW_TOKEN = 'csrf-secret';

      const res = await mkApp(reviewDeps()).request('http://example.com/api/finding-evidence-review', {
        method: 'POST',
        headers: {
          'x-kookr-admin-token': 'admin-secret',
          'x-kookr-finding-review-token': 'csrf-secret',
        },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.mode).toBe('estimate_only');
    });

    test('rejects missing, wrong, short, or empty review CSRF token when configured', async () => {
      process.env.KOOKR_FINDING_REVIEW_ENABLED = 'true';
      process.env.KOOKR_FINDING_REVIEW_ADMIN_TOKEN = 'admin-secret';
      process.env.KOOKR_FINDING_REVIEW_TOKEN = 'csrf-secret';

      const missing = await mkApp(reviewDeps()).request('http://example.com/api/finding-evidence-review', {
        method: 'POST',
        headers: { 'x-kookr-admin-token': 'admin-secret' },
      });
      expect(missing.status).toBe(403);
      expect(await missing.json()).toEqual({ error: 'invalid-finding-review-token' });

      for (const presentedToken of ['csrf-secreu', 'csrf', '']) {
        const res = await mkApp(reviewDeps()).request('http://example.com/api/finding-evidence-review', {
          method: 'POST',
          headers: {
            'x-kookr-admin-token': 'admin-secret',
            'x-kookr-finding-review-token': presentedToken,
          },
        });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'invalid-finding-review-token' });
      }
    });

    test('rejects malformed JSON and invalid mode before service execution', async () => {
      process.env.KOOKR_FINDING_REVIEW_ENABLED = 'true';
      process.env.KOOKR_FINDING_REVIEW_ADMIN_TOKEN = 'admin-secret';

      const invalidJson = await mkApp(reviewDeps()).request('http://example.com/api/finding-evidence-review', {
        method: 'POST',
        headers: { 'x-kookr-admin-token': 'admin-secret' },
        body: '{',
      });
      expect(invalidJson.status).toBe(400);
      expect(await invalidJson.json()).toEqual({ error: 'invalid-json' });

      const invalidMode = await mkApp(reviewDeps()).request('http://example.com/api/finding-evidence-review', {
        method: 'POST',
        headers: { 'x-kookr-admin-token': 'admin-secret' },
        body: JSON.stringify({ mode: 'unexpected_mode' }),
      });
      expect(invalidMode.status).toBe(400);
      expect(await invalidMode.json()).toEqual({ error: 'invalid-mode' });
    });

    test('estimate_only returns safe projection by default', async () => {
      process.env.KOOKR_FINDING_REVIEW_ENABLED = 'true';
      process.env.KOOKR_FINDING_REVIEW_ADMIN_TOKEN = 'admin-secret';
      const res = await mkApp(reviewDeps()).request('http://example.com/api/finding-evidence-review', {
        method: 'POST',
        headers: { 'x-kookr-admin-token': 'admin-secret' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.mode).toBe('estimate_only');
      expect(body.dryRun.candidates).toEqual([
        expect.objectContaining({
          candidateId: 'finding-1',
          anomalyType: 'needs_input',
          auditVerdict: 'possible_false_positive',
          inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]);
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('Raw explanation');
      expect(serialized).not.toContain('Raw terminal text');
      expect(serialized).not.toContain('explanationHash');
    });

    test('model_review requires positive budget before model call', async () => {
      process.env.KOOKR_FINDING_REVIEW_ENABLED = 'true';
      process.env.KOOKR_FINDING_REVIEW_ADMIN_TOKEN = 'admin-secret';
      const model = fakeLlm(JSON.stringify({}));
      const res = await mkApp(reviewDeps(model)).request('http://example.com/api/finding-evidence-review', {
        method: 'POST',
        headers: { 'x-kookr-admin-token': 'admin-secret' },
        body: JSON.stringify({ mode: 'model_review' }),
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'finding-review-budget-required' });
      expect(model.complete).not.toHaveBeenCalled();
    });

    test('invalid model output returns invalid-attempt result', async () => {
      process.env.KOOKR_FINDING_REVIEW_ENABLED = 'true';
      process.env.KOOKR_FINDING_REVIEW_ADMIN_TOKEN = 'admin-secret';
      process.env.KOOKR_FINDING_REVIEW_DAILY_COST_CENTS = '5';
      const res = await mkApp(reviewDeps(fakeLlm('not-json'))).request('http://example.com/api/finding-evidence-review', {
        method: 'POST',
        headers: { 'x-kookr-admin-token': 'admin-secret' },
        body: JSON.stringify({ mode: 'model_review' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toEqual([
        {
          status: 'invalid_attempt',
          attempt: expect.objectContaining({
            schemaVersion: 'finding-evidence-review-invalid-attempt.v1',
            candidateId: 'finding-1',
            failureKind: 'malformed_json',
            rawOutputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            error: 'model output was not valid JSON',
          }),
        },
      ]);
    });

    test('persisted_review appends valid reviews and invalid attempts to diagnostics JSONL', async () => {
      process.env.KOOKR_FINDING_REVIEW_ENABLED = 'true';
      process.env.KOOKR_FINDING_REVIEW_ADMIN_TOKEN = 'admin-secret';
      process.env.KOOKR_FINDING_REVIEW_DAILY_COST_CENTS = '5';

      const valid = await mkApp(reviewDeps(fakeLlm(JSON.stringify({
        candidateId: 'finding-1',
        verdict: 'likely_false_positive',
        confidence: 'medium',
        evidenceRefs: ['finding-1:observation:1'],
        rationale: 'terminal activity continued after the finding',
      })))).request('http://example.com/api/finding-evidence-review', {
        method: 'POST',
        headers: { 'x-kookr-admin-token': 'admin-secret' },
        body: JSON.stringify({ mode: 'persisted_review' }),
      });
      expect(valid.status).toBe(200);
      expect(await valid.json()).toEqual(expect.objectContaining({
        mode: 'persisted_review',
        reviewLog: { appendedRecords: 1 },
      }));

      const invalid = await mkApp(reviewDeps(fakeLlm('not-json'))).request('http://example.com/api/finding-evidence-review', {
        method: 'POST',
        headers: { 'x-kookr-admin-token': 'admin-secret' },
        body: JSON.stringify({ mode: 'persisted_review' }),
      });
      expect(invalid.status).toBe(200);

      type ReviewLogLine = {
        kind: string;
        inputHash: string;
        review?: unknown;
        attempt?: { failureKind: string; rawOutputHash: string };
      };
      const rawLog = readFileSync(join(tempDir, 'finding-evidence-reviews.jsonl'), 'utf8');
      const lines = rawLog
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as ReviewLogLine);
      expect(lines).toEqual([
        expect.objectContaining({
          kind: 'valid_review',
          inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          review: expect.objectContaining({ verdict: 'likely_false_positive' }),
        }),
        expect.objectContaining({
          kind: 'invalid_attempt',
          inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          attempt: expect.objectContaining({
            failureKind: 'malformed_json',
            rawOutputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
        }),
      ]);
    });

    test('review-log diagnostics route skips invalid lines without requiring runtime state', async () => {
      process.env.KOOKR_FINDING_REVIEW_ADMIN_TOKEN = 'admin-secret';
      writeFileSync(join(tempDir, 'finding-evidence-reviews.jsonl'), [
        '{bad-json',
        JSON.stringify({ schemaVersion: 'finding-evidence-review-log-record.v1', kind: 'invalid_attempt' }),
      ].join('\n'));

      const res = await mkApp(reviewDeps(null)).request('http://example.com/api/finding-evidence-review-log?limit=10', {
        headers: { 'x-kookr-admin-token': 'admin-secret' },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        schemaVersion: 'finding-evidence-review-log-read.v1',
        records: [],
        diagnostics: [
          { lineNumber: 1, failureKind: 'malformed_json', message: 'line was not valid JSON' },
          { lineNumber: 2, failureKind: 'invalid_record', message: 'line did not match finding evidence review log schema' },
        ],
      });
    });

    test('operations diagnostics route exposes compact non-loopback summary without admin token', async () => {
      const target = {
        candidateKind: 'false_positive',
        detectorTarget: 'needs_input',
        inputSchemaVersion: 'finding-evidence-review-input.v1',
        promptVersion: 'finding-evidence-review-prompt.v1',
        appGitSha: 'abc123',
      };
      writeFileSync(join(tempDir, 'finding-evidence-reviews.jsonl'), `${JSON.stringify({
        schemaVersion: 'finding-evidence-review-log-record.v1',
        kind: 'valid_review',
        appendedAt: '2026-05-18T10:06:00.000Z',
        inputHash: 'a'.repeat(64),
        target,
        review: {
          schemaVersion: 'finding-evidence-review.v1',
          candidateId: 'finding-1',
          verdict: 'likely_false_positive',
          confidence: 'high',
          evidenceRefs: ['finding-1:observation:1'],
          rationale: 'private reviewer rationale',
          reviewedAt: '2026-05-18T10:05:00.000Z',
          reviewer: {
            provider: 'fake-provider',
            model: 'fake-model',
            promptVersion: 'finding-evidence-review-prompt.v1',
          },
        },
      })}\n`);
      const sampler = {
        getStatus: vi.fn(() => ({
          schemaVersion: 'finding-evidence-review-sampler-status.v1',
          enabled: true,
          running: false,
          providerAvailable: true,
          lastRun: null,
          nextRunAt: null,
          queue: { queued: 1, in_progress: 0, reviewed: 0, failed_retryable: 0, failed_terminal: 0 },
          budget: {
            date: '2026-05-18',
            dailyCostCents: 100,
            spentCostCents: 25,
            remainingCostCents: 75,
            dailyTokenBudget: 20000,
            spentTokens: 500,
            remainingTokens: 19500,
          },
        })),
      };

      const res = await mkApp({
        ...reviewDeps(null),
        findingEvidenceReviewSampler: sampler,
      }).request('http://example.com/api/finding-evidence-operations-diagnostics');

      expect(res.status).toBe(200);
      const bodyText = await res.text();
      expect(bodyText).not.toContain('private reviewer rationale');
      expect(bodyText).not.toContain('Raw explanation');
      expect(bodyText).not.toContain('Raw terminal text');
      expect(bodyText).not.toContain('private note');
      expect(bodyText).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      const body = JSON.parse(bodyText);
      expect(Object.keys(body).sort()).toEqual([
        'audit',
        'proposals',
        'reviewLog',
        'sampler',
        'schemaVersion',
      ]);
      expect(body).toEqual({
        schemaVersion: 'finding-evidence-operations-diagnostics.v1',
        audit: { recordsCount: 1, reviewCandidatesCount: 1 },
        reviewLog: {
          recordsCount: 1,
          validReviews: 1,
          invalidAttempts: 0,
          diagnosticsCount: 0,
          verdictCounts: { likely_false_positive: 1 },
        },
        sampler: {
          status: 'available',
          value: {
            schemaVersion: 'finding-evidence-review-sampler-status.v1',
            enabled: true,
            running: false,
            providerAvailable: true,
            lastRun: null,
            nextRunAt: null,
            queue: { queued: 1, in_progress: 0, reviewed: 0, failed_retryable: 0, failed_terminal: 0 },
            budget: {
              date: '2026-05-18',
              dailyCostCents: 100,
              spentCostCents: 25,
              remainingCostCents: 75,
              dailyTokenBudget: 20000,
              spentTokens: 500,
              remainingTokens: 19500,
            },
          },
        },
        proposals: {
          diagnosticsCount: 0,
          reports: [{
            detectorTarget: 'needs_input',
            candidateKind: 'false_positive',
            reviewCounts: {
              total: 1,
              falsePositive: 1,
              falseNegative: 0,
              invalid: 0,
              unclear: 0,
              supportsFinding: 0,
            },
            proposal: {
              status: 'insufficient_evidence',
              summary: 'needs_input has 1 repeated false positive review(s), including 1 high-confidence review(s); keep collecting evidence before proposing a detector change.',
            },
          }],
        },
      });
      expect(sampler.getStatus).toHaveBeenCalled();
    });

    test('operations diagnostics route reports sampler unavailable without failing the summary', async () => {
      const res = await mkApp(reviewDeps(null))
        .request('http://example.com/api/finding-evidence-operations-diagnostics');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(expect.objectContaining({
        schemaVersion: 'finding-evidence-operations-diagnostics.v1',
        audit: { recordsCount: 1, reviewCandidatesCount: 1 },
        sampler: {
          status: 'unavailable',
          error: 'finding-review-sampler-unavailable',
        },
      }));
    });

    test('detector proposal diagnostics groups repeated targets and escapes model text', async () => {
      process.env.KOOKR_FINDING_REVIEW_ADMIN_TOKEN = 'admin-secret';
      const target = {
        candidateKind: 'false_positive',
        detectorTarget: 'needs_input',
        inputSchemaVersion: 'finding-evidence-review-input.v1',
        promptVersion: 'finding-evidence-review-prompt.v1',
        appGitSha: 'abc123',
      };
      const reviewLine = (candidateId: string, inputHash: string, rationale: string) => JSON.stringify({
        schemaVersion: 'finding-evidence-review-log-record.v1',
        kind: 'valid_review',
        appendedAt: '2026-05-18T10:06:00.000Z',
        inputHash,
        target,
        review: {
          schemaVersion: 'finding-evidence-review.v1',
          candidateId,
          verdict: 'likely_false_positive',
          confidence: 'high',
          evidenceRefs: [`${candidateId}:observation:1`],
          rationale,
          reviewedAt: '2026-05-18T10:05:00.000Z',
          reviewer: {
            provider: 'fake-provider',
            model: 'fake-model',
            promptVersion: 'finding-evidence-review-prompt.v1',
          },
        },
      });
      writeFileSync(join(tempDir, 'finding-evidence-reviews.jsonl'), [
        reviewLine('finding-1', 'a'.repeat(64), '<script>alert("x")</script>'),
        reviewLine('finding-2', 'b'.repeat(64), 'terminal activity continued'),
      ].join('\n'));

      const res = await mkApp(reviewDeps(null)).request('http://example.com/api/finding-evidence-review-detector-proposals?minReviews=2', {
        headers: { 'x-kookr-admin-token': 'admin-secret' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual(expect.objectContaining({
        schemaVersion: 'detector-proposal-report-response.v1',
        diagnostics: [],
      }));
      expect(body.reports).toHaveLength(1);
      expect(body.reports[0]).toEqual(expect.objectContaining({
        detectorTarget: 'needs_input',
        reviewCounts: expect.objectContaining({
          falsePositive: 2,
          falseNegative: 0,
          invalid: 0,
          unclear: 0,
        }),
        proposal: expect.objectContaining({
          status: 'candidate',
          advisoryOnly: true,
          canExecuteCommands: false,
          canMutateDetectorConfig: false,
        }),
      }));
      const serialized = JSON.stringify(body);
      expect(serialized).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
      expect(serialized).not.toContain('<script>');
    });

    test('detector proposal diagnostics rejects unauthorized non-loopback requests', async () => {
      const res = await mkApp(reviewDeps(null)).request('http://example.com/api/finding-evidence-review-detector-proposals');

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'finding-review-forbidden' });
    });

    test('sampler diagnostics route exposes budget, queue, and provider status', async () => {
      process.env.KOOKR_FINDING_REVIEW_ADMIN_TOKEN = 'admin-secret';
      const sampler = {
        getStatus: vi.fn(() => ({
          schemaVersion: 'finding-evidence-review-sampler-status.v1',
          enabled: false,
          running: false,
          providerAvailable: true,
          lastRun: null,
          nextRunAt: null,
          queue: {
            queued: 0,
            in_progress: 0,
            reviewed: 0,
            failed_retryable: 0,
            failed_terminal: 0,
          },
          budget: {
            date: '2026-05-18',
            dailyCostCents: 0,
            spentCostCents: 0,
            remainingCostCents: 0,
            dailyTokenBudget: 20000,
            spentTokens: 0,
            remainingTokens: 20000,
          },
        })),
      };

      const res = await mkApp({
        ...reviewDeps(null),
        findingEvidenceReviewSampler: sampler,
      }).request('http://example.com/api/finding-evidence-review-sampler', {
        headers: { 'x-kookr-admin-token': 'admin-secret' },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(expect.objectContaining({
        schemaVersion: 'finding-evidence-review-sampler-status.v1',
        enabled: false,
        providerAvailable: true,
        queue: {
          queued: 0,
          in_progress: 0,
          reviewed: 0,
          failed_retryable: 0,
          failed_terminal: 0,
        },
        budget: {
          date: '2026-05-18',
          dailyCostCents: 0,
          spentCostCents: 0,
          remainingCostCents: 0,
          dailyTokenBudget: 20000,
          spentTokens: 0,
          remainingTokens: 20000,
        },
      }));
      expect(sampler.getStatus).toHaveBeenCalled();
    });

    test('sampler diagnostics route rejects unauthorized non-loopback requests', async () => {
      const res = await mkApp(reviewDeps(null)).request('http://example.com/api/finding-evidence-review-sampler');

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'finding-review-forbidden' });
    });

    test('sampler diagnostics route reports unavailable when no sampler is wired', async () => {
      process.env.KOOKR_FINDING_REVIEW_ADMIN_TOKEN = 'admin-secret';

      const res = await mkApp(reviewDeps(null)).request('http://example.com/api/finding-evidence-review-sampler', {
        headers: { 'x-kookr-admin-token': 'admin-secret' },
      });

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'finding-review-sampler-unavailable' });
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/circuit-breakers
  // ---------------------------------------------------------------------------
  describe('GET /api/circuit-breakers', () => {
    test('returns [] when no registry is wired', async () => {
      const res = await mkApp({}).request('/api/circuit-breakers');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    test('returns snapshots for all registered breakers', async () => {
      const registry = new CircuitBreakerRegistry();
      registry.register(new CircuitBreaker({ name: 'gh-api' }));
      registry.register(new CircuitBreaker({ name: 'worktree' }));

      const res = await mkApp({ circuitBreakerRegistry: registry }).request('/api/circuit-breakers');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(2);
      const names = body.map((b: { name: string }) => b.name).sort();
      expect(names).toEqual(['gh-api', 'worktree']);
      expect(body[0]).toEqual(expect.objectContaining({
        state: 'closed',
        failureCount: 0,
      }));
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/hook-event/:sessionId
  // ---------------------------------------------------------------------------
  describe('POST /api/hook-event/:sessionId', () => {
    test('replays a real hook fixture through HTTP ingestion and updates monitor state', async () => {
      const harness = mkHookRouteHarness();
      const sessionId = 'kookr-route-single';
      const fixture = readFileSync('src/__fixtures__/hook-pre-tool-use.json', 'utf8');

      const res = await harness.app.request(`/api/hook-event/${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: fixture,
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'received', dispatched: true });
      expect(harness.calls).toHaveLength(1);
      expect(harness.calls[0]).toEqual(expect.objectContaining({
        tmuxName: sessionId,
        sequence: 1,
        result: expect.objectContaining({
          parseStatus: 'ok',
          rawHookEventName: 'PreToolUse',
        }),
      }));
      expect(harness.monitor.getAgentEvents(sessionId).map((event) => event.type)).toEqual(['tool_use']);
      expect(harness.ingestion.getActivityMeta(sessionId)).toEqual(expect.objectContaining({
        totalEventsSeen: 1,
        parentEventCount: 1,
      }));
    });

    test('accepts a recorded JSONL hook fixture as one route-level replay request', async () => {
      const harness = mkHookRouteHarness();
      const sessionId = 'kookr-route-jsonl';
      const fixture = readFileSync('src/__fixtures__/hook-codex-mcp-startup.jsonl', 'utf8');

      const res = await harness.app.request(`/api/hook-event/${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/jsonl' },
        body: fixture,
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: 'received',
        dispatched: true,
        recordCount: 6,
        dispatchedCount: 6,
      });
      expect(harness.calls.map((call) => call.result.rawHookEventName)).toEqual([
        'Notification',
        'SessionStart',
        'PreToolUse',
        'PostToolUse',
        'Stop',
        'SessionEnd',
      ]);
      expect(harness.calls.map((call) => call.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(harness.monitor.getAgentEvents(sessionId)).toHaveLength(6);
      expect(harness.ingestion.getActivityMeta(sessionId)).toEqual(expect.objectContaining({
        totalEventsSeen: 6,
        parentEventCount: 6,
        malformedRecordCount: 0,
      }));
    });

    test('counts concatenated valid records and a malformed tail without dropping diagnostics', async () => {
      const harness = mkHookRouteHarness();
      const sessionId = 'kookr-route-concat';
      const preToolUse = readFileSync('src/__fixtures__/hook-pre-tool-use.json', 'utf8').trim();
      const postToolUse = readFileSync('src/__fixtures__/hook-post-tool-use.json', 'utf8').trim();

      const res = await harness.app.request(`/api/hook-event/${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: `${preToolUse}${postToolUse}\nnot-json\n`,
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: 'received',
        dispatched: true,
        recordCount: 3,
        dispatchedCount: 2,
      });
      expect(harness.calls.map((call) => call.result.parseStatus)).toEqual(['ok', 'ok', 'malformed']);
      expect(harness.monitor.getAgentEvents(sessionId).map((event) => event.type)).toEqual(['tool_use', 'tool_result']);
      expect(harness.ingestion.getActivityMeta(sessionId)).toEqual(expect.objectContaining({
        totalEventsSeen: 3,
        parentEventCount: 2,
        malformedRecordCount: 1,
      }));
    });

    test('continues JSONL route replay after a malformed opening line', async () => {
      const harness = mkHookRouteHarness();
      const sessionId = 'kookr-route-malformed-leading-line';
      const sessionStart = readFileSync('src/__fixtures__/hook-session-start.json', 'utf8').trim();

      const res = await harness.app.request(`/api/hook-event/${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/jsonl' },
        body: `{"broken":\n${sessionStart}\n`,
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: 'received',
        dispatched: true,
        recordCount: 2,
        dispatchedCount: 1,
      });
      expect(harness.calls.map((call) => call.result.parseStatus)).toEqual(['malformed', 'ok']);
      expect(harness.calls.map((call) => call.result.rawHookEventName)).toEqual([undefined, 'SessionStart']);
      expect(harness.monitor.getAgentEvents(sessionId).map((event) => event.type)).toEqual(['session_start']);
      expect(harness.ingestion.getActivityMeta(sessionId)).toEqual(expect.objectContaining({
        totalEventsSeen: 2,
        parentEventCount: 1,
        malformedRecordCount: 1,
      }));
    });

    test('keeps duplicate route replay records out of the monitor window', async () => {
      const harness = mkHookRouteHarness();
      const sessionId = 'kookr-route-duplicate';
      const fixture = readFileSync('src/__fixtures__/hook-stop.json', 'utf8');

      const first = await harness.app.request(`/api/hook-event/${sessionId}`, {
        method: 'POST',
        body: fixture,
      });
      const second = await harness.app.request(`/api/hook-event/${sessionId}`, {
        method: 'POST',
        body: fixture,
      });

      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ status: 'received', dispatched: true });
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({ status: 'received', dispatched: false });
      expect(harness.calls).toHaveLength(1);
      expect(harness.monitor.getAgentEvents(sessionId)).toHaveLength(1);
      expect(harness.ingestion.getActivityMeta(sessionId)).toEqual(expect.objectContaining({
        totalEventsSeen: 1,
        duplicateRecordCount: 1,
      }));
    });

    test('tags synthetic replay sessions before dispatching fixture records', async () => {
      const harness = mkHookRouteHarness();
      const sessionId = `${REPLAY_SESSION_PREFIX}route-fixture`;
      const fixture = readFileSync('src/__fixtures__/hook-session-start.json', 'utf8');

      const res = await harness.app.request(`/api/hook-event/${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: fixture,
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'received', dispatched: true });
      expect(harness.calls[0].options).toEqual(expect.objectContaining({ origin: 'replay' }));
      expect(harness.ingestion.getActivityMeta(sessionId)).toEqual(expect.objectContaining({
        totalEventsSeen: 1,
        parentEventCount: 1,
      }));
    });

    test('returns 200 and records arrival when body is non-empty', async () => {
      const arrivals: Array<{ tmux: string; body: string }> = [];
      const httpPushTracker = {
        recordHttpArrival: (tmux: string, body: string) => {
          arrivals.push({ tmux, body });
        },
      };
      const res = await mkApp({ httpPushTracker: httpPushTracker as never })
        .request('/api/hook-event/kookr-abc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hook_event_name: 'PreToolUse' }),
        });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'received' });
      expect(arrivals).toHaveLength(1);
      expect(arrivals[0].tmux).toBe('kookr-abc');
    });

    test('returns 400 with {status:"empty"} when body is blank', async () => {
      const res = await mkApp({}).request('/api/hook-event/kookr-abc', {
        method: 'POST',
        body: '   \n',
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ status: 'empty' });
    });

    test('rejects unsafe session ids before ingestion', async () => {
      const ingestFromHttp = vi.fn();
      const res = await mkApp({ hookIngestion: { ingestFromHttp } as never })
        .request('/api/hook-event/..%2Fescape', {
          method: 'POST',
          body: JSON.stringify({ hook_event_name: 'PreToolUse' }),
        });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid session id' });
      expect(ingestFromHttp).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/shadow-report
  // ---------------------------------------------------------------------------
  describe('GET /api/shadow-report', () => {
    test('returns 404 when shadowRegistry is not wired', async () => {
      const res = await mkApp({}).request('/api/shadow-report');
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Shadow detection not configured' });
    });

    test('returns a JSON report when the shadow log exists', async () => {
      const logPath = join(tempDir, 'shadow.jsonl');
      writeFileSync(logPath, ''); // empty but readable
      const registry = new ShadowDetectorRegistry(logPath);

      const res = await mkApp({ shadowRegistry: registry }).request('/api/shadow-report');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual(expect.objectContaining({
        generatedAt: expect.any(String),
        strategies: expect.any(Array),
        totalEntries: expect.any(Number),
        parseErrors: expect.any(Number),
      }));
    });

    test('returns text/plain when ?format=text is passed', async () => {
      const logPath = join(tempDir, 'shadow.jsonl');
      writeFileSync(logPath, '');
      const registry = new ShadowDetectorRegistry(logPath);

      const res = await mkApp({ shadowRegistry: registry }).request('/api/shadow-report?format=text');
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('Shadow Detection Report');
    });

    test('serves a cached report on the second request within the TTL (issue #1764)', async () => {
      const logPath = join(tempDir, 'shadow-cache.jsonl');
      writeFileSync(
        logPath,
        JSON.stringify({
          kind: 'heartbeat',
          timestamp: '2026-03-28T12:00:00.000Z',
          agentId: 'a1',
          source: 'pane_semantics',
          shadowState: null,
          realState: null,
        }) + '\n',
      );
      const registry = new ShadowDetectorRegistry(logPath);
      // Cache is per registerDiagnosticsRoutes invocation (per app instance).
      const app = mkApp({ shadowRegistry: registry });

      const first = await app.request('/api/shadow-report');
      expect(first.status).toBe(200);
      const body1 = await first.json() as { generatedAt: string; totalEntries: number };

      // Mutate the log — a cache hit must still return the first snapshot.
      writeFileSync(logPath, '');

      const second = await app.request('/api/shadow-report');
      expect(second.status).toBe(200);
      const body2 = await second.json() as { generatedAt: string; totalEntries: number };
      expect(body2.generatedAt).toBe(body1.generatedAt);
      expect(body2.totalEntries).toBe(body1.totalEntries);
      expect(body2.totalEntries).toBe(1);
    });

    test('concurrent cold requests share a single in-flight parse (issue #1764)', async () => {
      const logPath = join(tempDir, 'shadow-concurrent.jsonl');
      writeFileSync(
        logPath,
        JSON.stringify({
          kind: 'heartbeat',
          timestamp: '2026-03-28T12:00:00.000Z',
          agentId: 'a1',
          source: 'pane_semantics',
          shadowState: null,
          realState: null,
        }) + '\n',
      );
      const registry = new ShadowDetectorRegistry(logPath);
      const app = mkApp({ shadowRegistry: registry });

      const [a, b, c] = await Promise.all([
        app.request('/api/shadow-report'),
        app.request('/api/shadow-report'),
        app.request('/api/shadow-report'),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(c.status).toBe(200);
      const bodies = await Promise.all([a.json(), b.json(), c.json()]) as Array<{ generatedAt: string }>;
      // Same generatedAt means one scan served all concurrent waiters.
      expect(bodies[0]!.generatedAt).toBe(bodies[1]!.generatedAt);
      expect(bodies[1]!.generatedAt).toBe(bodies[2]!.generatedAt);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/telemetry/report
  // ---------------------------------------------------------------------------
  describe('GET /api/telemetry/report', () => {
    test('returns an empty report when interactionLog has no file yet', async () => {
      const interactionLog = { getFilePath: () => null };
      const res = await mkApp({ interactionLog: interactionLog as never })
        .request('/api/telemetry/report');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual(expect.objectContaining({
        totalEvents: 0,
        timeRange: null,
        eventCounts: expect.any(Object),
        reconstructStats: expect.objectContaining({
          busySkipped: expect.any(Number),
          budgetExceeded: expect.any(Number),
        }),
        absoluteTuiRecoveryStats: expect.objectContaining({
          started: expect.any(Number),
          ctrlLInjected: expect.any(Number),
        }),
        terminalSwitchLatencyMetrics: expect.objectContaining({
          byClass: [],
          recoveryRate: null,
        }),
      }));
    });

    test('reads the telemetry file next to the interaction log', async () => {
      const sessionDir = join(tempDir, 'session-1');
      mkdirSync(sessionDir, { recursive: true });
      const interactionsPath = join(sessionDir, 'interactions.jsonl');
      const telemetryPath = join(sessionDir, 'telemetry.jsonl');
      writeFileSync(interactionsPath, ''); // presence is enough
      writeFileSync(telemetryPath, JSON.stringify({
        type: 'tab_switched',
        timestamp: '2026-04-06T09:00:00.000Z',
        data: { from: 'a', to: 'b' },
      }) + '\n');

      const interactionLog = { getFilePath: () => interactionsPath };
      const res = await mkApp({ interactionLog: interactionLog as never })
        .request('/api/telemetry/report');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalEvents).toBe(1);
      expect(body.eventCounts.tab_switched).toBe(1);
    });

    test('exposes stratified attach latency and reconstruct counters', async () => {
      const sessionDir = join(tempDir, 'session-attach');
      mkdirSync(sessionDir, { recursive: true });
      const interactionsPath = join(sessionDir, 'interactions.jsonl');
      const telemetryPath = join(sessionDir, 'telemetry.jsonl');
      writeFileSync(interactionsPath, '');
      const events = [
        {
          type: 'terminal_switch_latency',
          timestamp: '2026-08-03T10:00:00.000Z',
          sessionId: 's',
          platform: 'linux',
          selectionToFirstPaintMs: 50,
          warmLabel: 'warm',
          agentType: 'claude-code',
          serverStrategy: 'seed-cache',
          seedCacheHit: true,
          recoveryUsed: false,
        },
        {
          type: 'terminal_switch_latency',
          timestamp: '2026-08-03T10:00:01.000Z',
          sessionId: 's',
          platform: 'linux',
          selectionToFirstPaintMs: 800,
          warmLabel: 'cold',
          agentType: 'grok-build',
          serverStrategy: 'absolute-snapshot',
          recoveryUsed: true,
        },
      ];
      writeFileSync(telemetryPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

      const interactionLog = { getFilePath: () => interactionsPath };
      const res = await mkApp({ interactionLog: interactionLog as never })
        .request('/api/telemetry/report');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.terminalSwitchLatencyMetrics.sampleCount).toBe(2);
      expect(body.terminalSwitchLatencyMetrics.recoveryRate).toBe(0.5);
      expect(body.terminalSwitchLatencyMetrics.byClass).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: 'warm|claude-code|seed-cache',
            sampleCount: 1,
            p50FirstPaintMs: 50,
          }),
          expect.objectContaining({
            key: 'cold|grok-build|absolute-snapshot',
            sampleCount: 1,
            p50FirstPaintMs: 800,
          }),
        ]),
      );
      expect(body.reconstructStats).toEqual(expect.objectContaining({
        busySkipped: expect.any(Number),
        budgetExceeded: expect.any(Number),
        completed: expect.any(Number),
      }));
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/github/status (issue #1947)
  // ---------------------------------------------------------------------------
  describe('GET /api/github/status', () => {
    test('returns the enriched scanner snapshot while keeping active', async () => {
      const snapshot = {
        active: true,
        stateFetchBackoffMs: 1200,
        repoHealthBackoffMs: 0,
        trackedRefCount: 3,
      };
      const githubScanner = { getStatusSnapshot: vi.fn(() => snapshot) };
      const res = await mkApp({ githubScanner: githubScanner as never }).request('/api/github/status');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(snapshot);
      expect(githubScanner.getStatusSnapshot).toHaveBeenCalledOnce();
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/github/:taskId and GET /api/github
  // ---------------------------------------------------------------------------
  describe('GET /api/github/:taskId', () => {
    test('returns 404 when the task is unknown', async () => {
      const taskStore = new TaskStore();
      const githubStateStore = new GitHubStateStore();
      const res = await mkApp({ taskStore, githubStateStore })
        .request('/api/github/does-not-exist');
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Task not found' });
    });

    test('returns the task state when the task exists', async () => {
      const taskStore = new TaskStore();
      const task = taskStore.createTask('Known task', '/tmp');
      const githubStateStore = new GitHubStateStore();
      const res = await mkApp({ taskStore, githubStateStore })
        .request(`/api/github/${task.id}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.taskId).toBe(task.id);
      expect(body.prs).toEqual([]);
      expect(body.issues).toEqual([]);
    });
  });

  describe('GET /api/github (all)', () => {
    test('returns [] when no references have been detected', async () => {
      const taskStore = new TaskStore();
      const githubStateStore = new GitHubStateStore();
      const res = await mkApp({ taskStore, githubStateStore }).request('/api/github');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    test('returns one entry per task that has references', async () => {
      const taskStore = new TaskStore();
      const githubStateStore = new GitHubStateStore();
      githubStateStore.addReference({
        type: 'pr',
        owner: 'kookr-ai',
        repo: 'kookr',
        number: 1,
        url: 'https://github.com/kookr-ai/kookr/pull/1',
        detectedAt: new Date(),
        detectedFrom: 'kookr-abc',
        taskId: 'task-xyz',
      });

      const res = await mkApp({ taskStore, githubStateStore }).request('/api/github');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].taskId).toBe('task-xyz');
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/diagnostic and POST /api/diagnostic/run
  // ---------------------------------------------------------------------------
  describe('GET /api/diagnostic', () => {
    test('returns {report:null, lastError:null} when runner is not wired', async () => {
      const res = await mkApp({}).request('/api/diagnostic');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ report: null, lastError: null });
    });

    test('returns the runner status when wired', async () => {
      const helperLlm = helperLlmSnapshot({
        generatedAt: 123,
        totals: helperLlmCounters({ requestCount: 1, successCount: 1 }),
        byUseCase: [{ useCase: 'task_naming', ...helperLlmCounters({ requestCount: 1, successCount: 1 }) }],
      });
      const diagnosticRunner = {
        getStatus: () => ({ report: { findings: [], helperLlm }, lastError: null }),
      };
      const res = await mkApp({ diagnosticRunner: diagnosticRunner as never })
        .request('/api/diagnostic');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.report).toEqual({ findings: [], helperLlm });
      expect(body.lastError).toBeNull();
    });
  });

  describe('POST /api/diagnostic/run', () => {
    test('returns 503 when runner is not wired', async () => {
      const res = await mkApp({}).request('/api/diagnostic/run', { method: 'POST' });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Diagnostic runner not available' });
    });

    test('invokes runNow and returns the report', async () => {
      let called = 0;
      const helperLlm = helperLlmSnapshot({
        generatedAt: 456,
        totals: helperLlmCounters({ requestCount: 2, successCount: 2 }),
        byProvider: [{ provider: 'groq', model: 'groq-model', ...helperLlmCounters({ requestCount: 2, successCount: 2 }) }],
      });
      const diagnosticRunner = {
        getStatus: () => ({ report: null, lastError: null }),
        runNow: () => {
          called++;
          return { findings: [{ type: 'slow-route', severity: 'warn' }], helperLlm };
        },
      };
      const res = await mkApp({ diagnosticRunner: diagnosticRunner as never })
        .request('/api/diagnostic/run', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(called).toBe(1);
      const body = await res.json();
      expect(body.report.findings).toHaveLength(1);
      expect(body.report.helperLlm).toEqual(helperLlm);
    });
  });

});

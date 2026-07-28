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
import { extractRawHookHeader, HookParseError, parseHookEvent } from '../../core/hook-parser.js';
import { Monitor } from '../../core/monitor.js';
import { Watchdog } from '../../core/watchdog.js';
import { registerDiagnosticsRoutes } from './diagnostics-routes.js';
import { RequestDurationMetrics } from '../request-duration-metrics.js';
import { AuthThrottle } from '../auth-throttle.js';
import { ViewerGrantStore } from '../../core/viewer-grants.js';
import { ViewerConnectionRegistry } from '../viewer-connection-registry.js';
import { CollaborationAuditLog } from '../collaboration-audit-log.js';
import { DrainController } from '../drain-state.js';
import { DeliveryTraceBuffer } from '../../core/delivery-trace.js';
import { HookIngestion, REPLAY_SESSION_PREFIX, type HookEventInjector } from '../hook-ingestion.js';
import type { RouteDeps } from './shared.js';
import type { AgentEvent, Anomaly, InjectHookEventResult } from '../../core/types.js';
import type { LlmClient } from '../../core/llm-client.js';
import type { HelperLlmDiagnosticsCounters, HelperLlmDiagnosticsSnapshot } from '../../shared/contracts/diagnostic.js';

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
      lastError: { kind: string } | null;
      errorCount: number;
    }>) {
      return {
        getStats: () => ({
          attachedSessions: 0,
          reattachCounts: {},
          pendingWriters: 0,
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

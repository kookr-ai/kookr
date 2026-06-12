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
import { registerDiagnosticsRoutes } from './diagnostics-routes.js';
import { RequestDurationMetrics } from '../request-duration-metrics.js';
import { AuthThrottle } from '../auth-throttle.js';
import { ViewerGrantStore } from '../../core/viewer-grants.js';
import { ViewerConnectionRegistry } from '../viewer-connection-registry.js';
import { CollaborationAuditLog } from '../collaboration-audit-log.js';
import type { RouteDeps } from './shared.js';
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
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.KOOKR_FINDING_REVIEW_ENABLED;
    delete process.env.KOOKR_FINDING_REVIEW_DAILY_COST_CENTS;
    delete process.env.KOOKR_FINDING_REVIEW_TOKEN;
    delete process.env.KOOKR_FINDING_REVIEW_ADMIN_TOKEN;
    resetDetectionStats();
  });

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
  // GET /api/health — viewerBroadcaster block (#808 / R10)
  // ---------------------------------------------------------------------------
  describe('GET /api/health viewerBroadcaster block', () => {
    test('omits the block when the share feature is not wired', async () => {
      const res = await mkApp({ taskStore: new TaskStore(), buildInfo: {} as never }).request('/api/health');
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

    test('rejects missing or wrong review CSRF token when configured', async () => {
      process.env.KOOKR_FINDING_REVIEW_ENABLED = 'true';
      process.env.KOOKR_FINDING_REVIEW_ADMIN_TOKEN = 'admin-secret';
      process.env.KOOKR_FINDING_REVIEW_TOKEN = 'csrf-secret';

      const missing = await mkApp(reviewDeps()).request('http://example.com/api/finding-evidence-review', {
        method: 'POST',
        headers: { 'x-kookr-admin-token': 'admin-secret' },
      });
      expect(missing.status).toBe(403);
      expect(await missing.json()).toEqual({ error: 'invalid-finding-review-token' });

      const wrong = await mkApp(reviewDeps()).request('http://example.com/api/finding-evidence-review', {
        method: 'POST',
        headers: {
          'x-kookr-admin-token': 'admin-secret',
          'x-kookr-finding-review-token': 'wrong',
        },
      });
      expect(wrong.status).toBe(403);
      expect(await wrong.json()).toEqual({ error: 'invalid-finding-review-token' });
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

import type { Context, Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { accessSync, constants as fsConstants } from 'node:fs';
import { readInteractionLog } from '../../core/interaction-log.js';
import { readTelemetryLog } from '../../core/telemetry.js';
import { analyzeSession } from '../../core/friction-analyzer.js';
import { buildLiveFrictionCalibrationSnapshot } from '../../core/live-friction-calibration.js';
import { getDetectionStats } from '../../core/detection-stats.js';
import { generateReportFromFile, formatReport } from '../../core/shadow-report.js';
import { getSnapshotAgentsRaw } from '../use-cases/get-snapshot.js';
import { buildReflectionRecommendationResponse } from '../reflection-task.js';
import {
  FindingEvidenceReviewService,
  FindingEvidenceReviewServiceError,
  getOrCreateFindingEvidenceReviewHmacKey,
  readFindingEvidenceReviewConfigFromEnv,
  type FindingEvidenceReviewMode,
  type FindingEvidenceReviewServiceConfig,
} from '../finding-evidence-review-service.js';
import { ReviewLogStore } from '../review-log-store.js';
import { buildDetectorProposalReportResponseV1 } from '../detector-proposal-report.js';
import { REQUEST_LATENCIES_ROUTE } from '../request-duration-metrics.js';
import type { BackendStats } from '../../adapters/terminal-backend.js';
import type { RouteDeps } from './shared.js';

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const REVIEW_ADMIN_TOKEN_HEADER = 'x-kookr-admin-token';
const REVIEW_CSRF_HEADER = 'x-kookr-finding-review-token';

export function registerDiagnosticsRoutes(app: Hono, deps: RouteDeps): void {
  const { taskStore, queue, adapter, interactionLog, githubScanner, githubStateStore, buildInfo, serverStartedAt } = deps;
  let findingEvidenceReviewService: FindingEvidenceReviewService | undefined;
  let findingEvidenceReviewConfig: FindingEvidenceReviewServiceConfig | undefined;
  let findingEvidenceReviewLogStore: ReviewLogStore | undefined;

  app.get('/api/health', (c) => {
    const terminalBackend = deps.terminalBackend;
    let terminalBackendBlock: object | undefined;
    if (terminalBackend) {
      const stats = terminalBackend.getStats();
      terminalBackendBlock = {
        status: deriveTerminalBackendStatus(stats),
        attachedSessions: stats.attachedSessions,
        reattachCounts: stats.reattachCounts,
        pendingWriters: stats.pendingWriters,
        lastError: stats.lastError,
        errorCount: stats.errorCount,
      };
    }
    return c.json({
      status: 'ok',
      agents: taskStore.listTasks().length,
      build: buildInfo,
      serverStartedAt,
      ...(terminalBackendBlock ? { terminalBackend: terminalBackendBlock } : {}),
      ...(deps.scheduleService ? { schedules: deps.scheduleService.getStatusSnapshot() } : {}),
    });
  });

  // Machine-readable readiness verdict for orchestrators / load balancers
  // (issue #660). Unlike /api/health — which always returns 200 so the
  // dashboard never sees a hard error — /api/ready turns 503 when a *critical*
  // subsystem is down: the terminal/dtach backend in `error`
  // (manifest-corrupt / dtach-unavailable) or the persistence directory
  // unwritable. Non-critical degradation (terminal `degraded`) stays
  // 200/ready so transient blips do not cordon a node out of rotation.
  // Read-only and unauthenticated by design: probes must reach it without an
  // admin token.
  app.get('/api/ready', (c) => {
    const checks: Record<string, ReadinessCheck> = {};

    const terminalBackend = deps.terminalBackend;
    if (terminalBackend) {
      const status = deriveTerminalBackendStatus(terminalBackend.getStats());
      checks.terminalBackend = { critical: true, ready: status !== 'error', status };
    }

    checks.persistence = checkPersistenceWritable(deps.kookrDir);

    // Fail-open: a check only flips readiness when it is both critical and
    // not-ready. Non-critical checks are reported for visibility only.
    const ready = Object.values(checks).every((check) => check.ready || !check.critical);
    return c.json({ ready, checks }, ready ? 200 : 503);
  });

  app.get('/api/health/stt', async (c) => {
    if (!deps.sttUrl) return c.json({ status: 'disabled' }, 200);
    try {
      const httpUrl = deps.sttUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
      const res = await fetch(`${httpUrl}/health`, { signal: AbortSignal.timeout(3000) });
      return c.json(await res.json());
    } catch {
      // Polling endpoint: frontend polls this and reads `status` from the body.
      // Returning 200 with status:'unavailable' lets the UI render a soft warning
      // without firing fetch() error handlers. Do not change to non-2xx.
      return c.json({ status: 'unavailable' }, 200);
    }
  });

  // Debug endpoint: full fidelity (not projected). Operators need the raw
  // toolResponse / toolInput / lastMessage for incident investigation.
  app.get('/api/snapshot', (c) => c.json(getSnapshotAgentsRaw({ monitor: deps.monitor })));

  app.get('/api/queue', (c) => c.json(queue.getAll()));

  app.get('/api/anomaly-stats', (c) => c.json(getDetectionStats()));

  app.get(REQUEST_LATENCIES_ROUTE, (c) => {
    if (!deps.requestDurationMetrics) {
      // Direct diagnostics-route tests may register this module without the
      // createRoutes middleware that wires the live metrics instance.
      return c.json({
        schemaVersion: 'request-duration-metrics.v1',
        maxRoutes: 0,
        maxSamplesPerRoute: 0,
        routeCount: 0,
        droppedRouteCount: 0,
        routes: [],
      });
    }
    return c.json(deps.requestDurationMetrics.snapshot());
  });

  app.get('/api/live-friction-calibration', async (c) => {
    try {
      const logPath = interactionLog.getFilePath();
      const events = logPath ? await readInteractionLog(logPath) : [];
      const activeFindings = queue.inspectActive().map((entry) => ({
        agentId: entry.agentId,
        anomalyType: entry.anomaly.type,
      }));
      return c.json(buildLiveFrictionCalibrationSnapshot(events, activeFindings));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get('/api/finding-evidence-audit', (c) => c.json({
    records: deps.monitor.getFindingEvidenceAuditRecords(),
    reviewCandidates: deps.monitor.getFindingEvidenceReviewCandidates(20),
  }));

  app.get('/api/finding-evidence-operations-diagnostics', async (c) => {
    const auditRecords = deps.monitor.getFindingEvidenceAuditRecords();
    const reviewCandidates = deps.monitor.getFindingEvidenceReviewCandidates(20);
    const reviewLog = await getFindingEvidenceReviewLogStore().readAll();
    const proposalResponse = buildDetectorProposalReportResponseV1(reviewLog.records, reviewLog.diagnostics);
    let sampler:
      | { status: 'available'; value: Awaited<ReturnType<NonNullable<typeof deps.findingEvidenceReviewSampler>['getStatus']>> }
      | { status: 'unavailable'; error: string };
    if (!deps.findingEvidenceReviewSampler) {
      sampler = { status: 'unavailable', error: 'finding-review-sampler-unavailable' };
    } else {
      try {
        sampler = { status: 'available', value: await deps.findingEvidenceReviewSampler.getStatus() };
      } catch {
        sampler = { status: 'unavailable', error: 'finding-review-sampler-unavailable' };
      }
    }

    return c.json({
      schemaVersion: 'finding-evidence-operations-diagnostics.v1',
      audit: {
        recordsCount: auditRecords.length,
        reviewCandidatesCount: reviewCandidates.length,
      },
      reviewLog: buildReviewLogOperationsSummary(reviewLog.records, reviewLog.diagnostics),
      sampler,
      proposals: {
        reports: proposalResponse.reports.slice(0, 20).map((report) => ({
          detectorTarget: report.detectorTarget,
          candidateKind: report.candidateKind,
          reviewCounts: report.reviewCounts,
          proposal: {
            status: report.proposal.status,
            summary: report.proposal.summary,
          },
        })),
        diagnosticsCount: proposalResponse.diagnostics.length,
      },
    });
  });

  app.post('/api/finding-evidence-review', async (c) => {
    if (process.env.KOOKR_FINDING_REVIEW_ENABLED !== 'true') return c.json({ error: 'finding-review-disabled' }, 404);
    if (!deps.llmClient) return c.json({ error: 'finding-review-llm-unavailable' }, 503);
    if (!isAuthorizedFindingReviewRequest(getRemoteAddress(c), c.req.header(REVIEW_ADMIN_TOKEN_HEADER))) {
      return c.json({ error: 'finding-review-forbidden' }, 403);
    }
    const requiredToken = process.env.KOOKR_FINDING_REVIEW_TOKEN?.trim();
    if (requiredToken && c.req.header(REVIEW_CSRF_HEADER) !== requiredToken) {
      return c.json({ error: 'invalid-finding-review-token' }, 403);
    }

    let body: { mode?: unknown; limit?: unknown } = {};
    const text = await c.req.text();
    if (text.trim()) {
      try {
        body = JSON.parse(text) as { mode?: unknown; limit?: unknown };
      } catch {
        return c.json({ error: 'invalid-json' }, 400);
      }
    }

    const { service: reviewService, config: reviewConfig } = getFindingEvidenceReviewService();
    const mode = body.mode ?? 'estimate_only';
    if (mode !== 'estimate_only' && mode !== 'model_review' && mode !== 'persisted_review') {
      return c.json({ error: 'invalid-mode' }, 400);
    }
    if (mode !== 'estimate_only' && reviewConfig.dailyCostCents <= 0) {
      return c.json({ error: 'finding-review-budget-required' }, 403);
    }

    try {
      return c.json(await reviewService.review({
        mode: mode as FindingEvidenceReviewMode,
        limit: typeof body.limit === 'number' ? body.limit : undefined,
      }));
    } catch (err) {
      if (err instanceof FindingEvidenceReviewServiceError) {
        return c.json({ error: err.code, message: err.message }, err.status);
      }
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get('/api/finding-evidence-review-log', async (c) => {
    if (!isAuthorizedFindingReviewRequest(getRemoteAddress(c), c.req.header(REVIEW_ADMIN_TOKEN_HEADER))) {
      return c.json({ error: 'finding-review-forbidden' }, 403);
    }

    const limitParam = c.req.query('limit');
    const limit = limitParam ? Number.parseInt(limitParam, 10) : 100;
    const read = await getFindingEvidenceReviewLogStore().readAll();
    const boundedLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 100;
    return c.json({
      schemaVersion: 'finding-evidence-review-log-read.v1',
      records: read.records.slice(-boundedLimit),
      diagnostics: read.diagnostics,
    });
  });

  app.get('/api/finding-evidence-review-detector-proposals', async (c) => {
    if (!isAuthorizedFindingReviewRequest(getRemoteAddress(c), c.req.header(REVIEW_ADMIN_TOKEN_HEADER))) {
      return c.json({ error: 'finding-review-forbidden' }, 403);
    }

    const minReviewsParam = c.req.query('minReviews');
    const maxEvidenceParam = c.req.query('maxEvidence');
    const read = await getFindingEvidenceReviewLogStore().readAll();
    return c.json(buildDetectorProposalReportResponseV1(read.records, read.diagnostics, {
      minPopulationReviews: readPositiveIntQuery(minReviewsParam, 2, 100),
      maxEvidencePerReport: readPositiveIntQuery(maxEvidenceParam, 5, 50),
    }));
  });

  app.get('/api/finding-evidence-review-sampler', async (c) => {
    if (!isAuthorizedFindingReviewRequest(getRemoteAddress(c), c.req.header(REVIEW_ADMIN_TOKEN_HEADER))) {
      return c.json({ error: 'finding-review-forbidden' }, 403);
    }
    if (!deps.findingEvidenceReviewSampler) return c.json({ error: 'finding-review-sampler-unavailable' }, 503);
    return c.json(await deps.findingEvidenceReviewSampler.getStatus());
  });

  function getFindingEvidenceReviewService(): {
    service: FindingEvidenceReviewService;
    config: FindingEvidenceReviewServiceConfig;
  } {
    if (!findingEvidenceReviewService || !findingEvidenceReviewConfig) {
      findingEvidenceReviewConfig = readFindingEvidenceReviewConfigFromEnv(
        process.env,
        deps.findingEvidenceReviewHmacKey ?? (deps.kookrDir ? getOrCreateFindingEvidenceReviewHmacKey(deps.kookrDir) : Buffer.alloc(32, 0)),
        buildInfo?.commitHash,
      );
      findingEvidenceReviewService = new FindingEvidenceReviewService({
        candidateReader: {
          listReviewCandidates: (limit) => deps.monitor.getFindingEvidenceReviewCandidates(limit),
        },
        llmClient: deps.llmClient ?? null,
        config: findingEvidenceReviewConfig,
        reviewLogStore: getFindingEvidenceReviewLogStore(),
      });
    }
    return { service: findingEvidenceReviewService, config: findingEvidenceReviewConfig };
  }

  function getFindingEvidenceReviewLogStore(): ReviewLogStore {
    if (!findingEvidenceReviewLogStore) {
      findingEvidenceReviewLogStore = ReviewLogStore.forKookrDir(deps.kookrDir);
    }
    return findingEvidenceReviewLogStore;
  }

  app.get('/api/circuit-breakers', (c) => {
    if (!deps.circuitBreakerRegistry) return c.json([]);
    return c.json(deps.circuitBreakerRegistry.getAllSnapshots());
  });

  app.get('/api/tasks/:taskId/activity-diagnostics', async (c) => {
    const taskId = c.req.param('taskId');
    const task = taskStore.getTask(taskId);
    if (!task) return c.json({ error: 'Task not found' }, 404);

    const kookrSessions = [];
    for (const session of task.sessions) {
      const kookrSessionId = session.tmuxSession;
      const monitorWindowSize = deps.monitor.getAgentEvents(kookrSessionId).length;
      const ledgerStats = deps.activityLedger
        ? await deps.activityLedger.stats(kookrSessionId)
        : undefined;
      const memMeta = deps.hookIngestion?.getActivityMeta(kookrSessionId);
      // Ledger is source of truth for durable counts; in-memory counters fill
      // gaps when the ledger is not configured.
      kookrSessions.push({
        kookrSessionId,
        parentSessionId: session.claudeSessionId,
        childSessionIds: Object.keys(session.childSessionIds ?? {}),
        rawRecordCount: ledgerStats?.rawRecordCount ?? memMeta?.totalEventsSeen ?? 0,
        parsedRecordCount: ledgerStats?.parsedRecordCount
          ?? ((memMeta?.parentEventCount ?? 0) + (memMeta?.childEventCount ?? 0)
              + (memMeta?.foreignEventCount ?? 0) + (memMeta?.unknownParentageCount ?? 0)),
        malformedRecordCount: ledgerStats?.malformedRecordCount ?? memMeta?.malformedRecordCount ?? 0,
        duplicateRecordCount: ledgerStats?.duplicateRecordCount ?? memMeta?.duplicateRecordCount ?? 0,
        unknownParentageCount: ledgerStats?.unknownParentageCount ?? memMeta?.unknownParentageCount ?? 0,
        droppedRecordCount: ledgerStats?.droppedRecordCount ?? memMeta?.droppedRecordCount ?? 0,
        monitorWindowSize,
        totalActivityEvents: ledgerStats?.rawRecordCount ?? memMeta?.totalEventsSeen ?? 0,
      });
    }

    return c.json({ taskId, kookrSessions });
  });

  app.post('/api/hook-event/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId');
    if (!SESSION_ID_RE.test(sessionId)) {
      return c.json({ error: 'Invalid session id' }, 400);
    }
    const body = await c.req.text();
    if (!body.trim()) return c.json({ status: 'empty' }, 400);

    if (deps.hookIngestion) {
      // Active fast path: feed the body into the same ingestion service the
      // file watcher uses. Dedup by content hash keeps a single record from
      // reaching the adapter twice when the file watcher also delivers it.
      // See rfc-activity-log-reliability §5.
      const result = deps.hookIngestion.ingestFromHttp(sessionId, body);
      return c.json({ status: 'received', dispatched: result.dispatched });
    }

    // Fallback: timing-only — shadow-detection era behavior.
    if (deps.httpPushTracker) {
      deps.httpPushTracker.recordHttpArrival(sessionId, body);
    }
    return c.json({ status: 'received' });
  });

  app.get('/api/shadow-report', async (c) => {
    const shadowLogPath = deps.shadowRegistry?.getLogFilePath();
    if (!shadowLogPath) return c.json({ error: 'Shadow detection not configured' }, 404);
    const format = c.req.query('format');
    const report = await generateReportFromFile(shadowLogPath);
    if (format === 'text') {
      return c.text(formatReport(report));
    }
    return c.json(report);
  });

  app.get('/api/reflect', async (c) => {
    try {
      const logPath = interactionLog.getFilePath();
      const events = logPath ? await readInteractionLog(logPath) : [];
      const report = analyzeSession(events);
      return c.json(report);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get('/api/reflect/recommendation', async (c) => {
    try {
      const logPath = interactionLog.getFilePath();
      const events = logPath ? await readInteractionLog(logPath) : [];
      const report = analyzeSession(events);
      return c.json(buildReflectionRecommendationResponse(logPath, report));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get('/api/telemetry/report', async (c) => {
    try {
      const logPath = interactionLog.getFilePath();
      if (!logPath) {
        const { generateTelemetryReport } = await import('../../core/telemetry-report.js');
        return c.json(generateTelemetryReport([]));
      }

      const telemetryPath = logPath.replace('interactions.jsonl', 'telemetry.jsonl');
      const events = await readTelemetryLog(telemetryPath);
      const { generateTelemetryReport } = await import('../../core/telemetry-report.js');
      const report = generateTelemetryReport(events);
      return c.json(report);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get('/api/github/status', (c) => c.json({ active: githubScanner.isActive() }));

  app.get('/api/github/:taskId', (c) => {
    const taskId = c.req.param('taskId');
    if (!taskStore.getTask(taskId)) {
      return c.json({ error: 'Task not found' }, 404);
    }
    const state = githubStateStore.getTaskState(taskId);
    return c.json(state);
  });

  app.get('/api/github', (c) => {
    const taskIds = githubStateStore.getTaskIdsWithReferences();
    const states = taskIds.map((id) => githubStateStore.getTaskState(id));
    return c.json(states);
  });

  // --- Self-diagnostic ---

  app.get('/api/diagnostic', (c) => {
    if (!deps.diagnosticRunner) return c.json({ report: null, lastError: null });
    return c.json(deps.diagnosticRunner.getStatus());
  });

  app.post('/api/diagnostic/run', (c) => {
    if (!deps.diagnosticRunner) return c.json({ error: 'Diagnostic runner not available' }, 503);
    console.log('[self-diagnostic] on-demand run triggered');
    const report = deps.diagnosticRunner.runNow();
    console.log(`[self-diagnostic] on-demand run complete, ${report.findings.length} findings`);
    return c.json({ report });
  });

  // Crash recovery startup summary endpoint (fetched once by frontend on mount)
  app.get('/api/startup-summary', (c) => c.json(deps.startupRecoverySummary ?? null));

  app.get('/api/capture/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId');
    try {
      const output = await adapter.captureDisplay(sessionId);
      return c.json({ sessionId, output });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message, sessionId }, 404);
    }
  });
}

/**
 * Derive the terminal backend health status from its raw stats.
 * Per rfc-v8-tmux-removal.md §/api/health:
 *   - 'error'    on manifest-corrupt or dtach-unavailable (last error)
 *   - 'degraded' if there are pending writers or a recent last error
 *   - 'ok'       otherwise
 * Shared by GET /api/health (reporting) and GET /api/ready (verdict, #660).
 */
function deriveTerminalBackendStatus(stats: BackendStats): 'ok' | 'degraded' | 'error' {
  if (
    stats.lastError &&
    (stats.lastError.kind === 'manifest-corrupt' || stats.lastError.kind === 'dtach-unavailable')
  ) {
    return 'error';
  }
  if (stats.pendingWriters > 0 || stats.lastError) return 'degraded';
  return 'ok';
}

/** One subsystem entry in the GET /api/ready verdict (#660). */
interface ReadinessCheck {
  /** When true, a not-ready result flips the overall verdict to 503. */
  critical: boolean;
  ready: boolean;
  status: string;
  /** Machine-readable cause when not ready (e.g. errno code, error kind). */
  reason?: string;
}

/**
 * Cheap, non-flapping persistence writability probe for GET /api/ready:
 * a single access(2) on the state directory Kookr persists into — no agent
 * spawn, no file write. When the directory is not wired (tests / non-server
 * contexts) the check fails open so it never cordons a node it cannot assess.
 */
function checkPersistenceWritable(kookrDir: string | undefined): ReadinessCheck {
  if (!kookrDir) {
    return { critical: true, ready: true, status: 'unknown', reason: 'kookr-dir-unset' };
  }
  try {
    accessSync(kookrDir, fsConstants.W_OK);
    return { critical: true, ready: true, status: 'ok' };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return { critical: true, ready: false, status: 'error', reason: typeof code === 'string' ? code : 'unwritable' };
  }
}

function isAuthorizedFindingReviewRequest(remoteAddress: string | undefined, adminTokenHeader: string | undefined): boolean {
  const configuredAdminToken = process.env.KOOKR_FINDING_REVIEW_ADMIN_TOKEN?.trim();
  if (configuredAdminToken && adminTokenHeader === configuredAdminToken) return true;
  return remoteAddress !== undefined && isLoopbackAddress(remoteAddress);
}

function getRemoteAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === '::1'
    || normalized === '0:0:0:0:0:0:0:1'
    || normalized === '::ffff:127.0.0.1'
    || normalized === '127.0.0.1'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

function buildReviewLogOperationsSummary(
  records: Awaited<ReturnType<ReviewLogStore['readAll']>>['records'],
  diagnostics: Awaited<ReturnType<ReviewLogStore['readAll']>>['diagnostics'],
): {
  recordsCount: number;
  validReviews: number;
  invalidAttempts: number;
  diagnosticsCount: number;
  verdictCounts: Record<string, number>;
} {
  const verdictCounts: Record<string, number> = {};
  let validReviews = 0;
  let invalidAttempts = 0;
  for (const record of records) {
    if (record.kind === 'valid_review') {
      validReviews += 1;
      verdictCounts[record.review.verdict] = (verdictCounts[record.review.verdict] ?? 0) + 1;
    } else {
      invalidAttempts += 1;
    }
  }
  return {
    recordsCount: records.length,
    validReviews,
    invalidAttempts,
    diagnosticsCount: diagnostics.length,
    verdictCounts,
  };
}

function readPositiveIntQuery(value: string | undefined, fallback: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

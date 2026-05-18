import type { Context, Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { readInteractionLog } from '../../core/interaction-log.js';
import { readTelemetryLog } from '../../core/telemetry.js';
import { analyzeSession } from '../../core/friction-analyzer.js';
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
      // Status derivation per rfc-v8-tmux-removal.md §/api/health:
      //   - 'error'    on manifest-corrupt or dtach-unavailable (last error)
      //   - 'degraded' if there are pending writers or a recent last error
      //   - 'ok'       otherwise
      let status: 'ok' | 'degraded' | 'error' = 'ok';
      if (
        stats.lastError &&
        (stats.lastError.kind === 'manifest-corrupt' ||
          stats.lastError.kind === 'dtach-unavailable')
      ) {
        status = 'error';
      } else if (stats.pendingWriters > 0 || stats.lastError) {
        status = 'degraded';
      }
      terminalBackendBlock = {
        status,
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

  app.get('/api/finding-evidence-audit', (c) => c.json({
    records: deps.monitor.getFindingEvidenceAuditRecords(),
    reviewCandidates: deps.monitor.getFindingEvidenceReviewCandidates(20),
  }));

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

import type { Hono } from 'hono';
import { readInteractionLog } from '../../core/interaction-log.js';
import { readTelemetryLog } from '../../core/telemetry.js';
import { analyzeSession } from '../../core/friction-analyzer.js';
import { getDetectionStats } from '../../core/detection-stats.js';
import { generateReportFromFile, formatReport } from '../../core/shadow-report.js';
import { getSnapshotAgentsRaw } from '../use-cases/get-snapshot.js';
import { buildReflectionRecommendationResponse } from '../reflection-task.js';
import type { RouteDeps } from './shared.js';

export function registerDiagnosticsRoutes(app: Hono, deps: RouteDeps): void {
  const { taskStore, queue, adapter, interactionLog, githubScanner, githubStateStore, buildInfo, serverStartedAt } = deps;

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

  app.get('/api/circuit-breakers', (c) => {
    if (!deps.circuitBreakerRegistry) return c.json([]);
    return c.json(deps.circuitBreakerRegistry.getAllSnapshots());
  });

  app.post('/api/hook-event/:tmuxName', async (c) => {
    const tmuxName = c.req.param('tmuxName');
    const body = await c.req.text();
    if (!body.trim()) return c.json({ status: 'empty' }, 400);

    if (deps.httpPushTracker) {
      deps.httpPushTracker.recordHttpArrival(tmuxName, body);
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

  app.get('/api/capture/:tmuxName', async (c) => {
    const tmuxName = c.req.param('tmuxName');
    try {
      const output = await adapter.captureDisplay(tmuxName);
      return c.json({ tmuxName, output });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message, tmuxName }, 404);
    }
  });
}

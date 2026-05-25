import type { Context, Hono } from 'hono';
import type { RouteDeps } from './shared.js';
import { FindingSummaryCache } from '../finding-summary-cache.js';
import { TaskSpeechSummaryCache } from '../task-speech-summary-cache.js';
import { buildTaskSpeechSubject } from '../use-cases/task-speech-summary-input.js';
import { TTSClientError } from '../../adapters/tts-client.js';
import type { SpeakFindingErrorResponse, SpeakFindingResponse, SpeakTaskSummaryResponse } from '../../shared/contracts/speech.js';

export interface SpeechRouteOptions {
  /** Surgical kill-switch independent of KOOKR_TTS. */
  enabled: boolean;
  /** Bound when ttsUrl is set; null otherwise. */
  cache: FindingSummaryCache | null;
  /** Bound when ttsUrl is set; null otherwise. */
  taskCache?: TaskSpeechSummaryCache | null;
  /** Same value the server passes to other consumers. */
  ttsUrl?: string;
}

function jsonError(c: Context, status: 400 | 404 | 409 | 500 | 503, body: SpeakFindingErrorResponse) {
  return c.json(body, status);
}

export function registerSpeechRoutes(app: Hono, deps: RouteDeps, options: SpeechRouteOptions): void {
  app.post('/api/tasks/:taskId/speak-summary', async (c) => {
    if (!options.enabled) {
      return jsonError(c, 503, { error: 'feature-disabled' });
    }
    if (!options.taskCache || !options.ttsUrl) {
      return jsonError(c, 503, { error: 'tts-not-configured' });
    }

    const taskId = c.req.param('taskId');
    const collectStart = Date.now();
    const subject = buildTaskSpeechSubject({
      taskId,
      agents: deps.monitor.getSnapshot(),
      task: deps.taskStore.getTask(taskId),
    });
    const collectMs = Date.now() - collectStart;
    if (!subject) {
      return jsonError(c, 404, { error: 'task-not-found' });
    }

    const requestSignal = c.req.raw.signal;
    try {
      const startedAt = Date.now();
      const result = await options.taskCache.get(subject.input, requestSignal);
      const response: SpeakTaskSummaryResponse = result;
      console.log(
        `[task-speak] task=${taskId} agent=${subject.agentState?.agentId ?? 'none'} status=${subject.input.taskStatus ?? 'unknown'} cached=${result.cached} usedFallback=${result.usedFallback} collectMs=${collectMs} llmMs=${result.llmMs} ttsMs=${result.ttsMs} totalMs=${Date.now() - startedAt + collectMs}`,
      );
      return c.json(response, 200);
    } catch (err) {
      if (requestSignal.aborted) {
        return jsonError(c, 503, { error: 'aborted' });
      }
      const reason = err instanceof Error ? err.message : String(err);
      const kind = err instanceof TTSClientError ? err.kind : 'unknown';
      console.warn(`[task-speak] failed task=${taskId} kind=${kind} reason=${reason}`);
      return jsonError(c, 500, { error: 'tts-error', reason: reason.slice(0, 200) });
    }
  });

  app.post('/api/findings/:agentId/speak', async (c) => {
    if (!options.enabled) {
      return jsonError(c, 503, { error: 'feature-disabled' });
    }
    if (!options.cache || !options.ttsUrl) {
      return jsonError(c, 503, { error: 'tts-not-configured' });
    }

    const agentId = c.req.param('agentId');
    const agent = deps.monitor.getSnapshot().find((candidate) => candidate.agentId === agentId);
    if (!agent) {
      return jsonError(c, 404, { error: 'agent-not-found' });
    }
    if (!agent.anomaly) {
      return jsonError(c, 409, { error: 'no-finding' });
    }

    const anomaly = agent.anomaly;
    const requestSignal = c.req.raw.signal;

    try {
      const result = await options.cache.get(
        {
          agentId: agent.agentId,
          anomalyType: anomaly.type,
          severity: anomaly.severity,
          explanation: anomaly.explanation,
          detectedAt: anomaly.detectedAt,
          taskName: agent.taskName,
          // `explanation + detectedAt` already identifies a finding. We pass a
          // constant freshness here so cache hits aren't busted by unrelated
          // event accumulation on the agent (events grow continuously while a
          // task runs). The finding identity itself changes when the anomaly is
          // re-fired with a new detectedAt.
          freshness: 'finding',
        },
        {
          taskName: agent.taskName,
          anomalyType: anomaly.type,
          anomalySeverity: anomaly.severity,
          explanation: anomaly.explanation,
        },
        requestSignal,
      );

      const response: SpeakFindingResponse = result;
      console.log(
        `[finding-speak] agent=${agent.agentId} anomaly=${anomaly.type} cached=${result.cached} usedFallback=${result.usedFallback} llmMs=${result.llmMs} ttsMs=${result.ttsMs}`,
      );
      return c.json(response, 200);
    } catch (err) {
      if (requestSignal.aborted) {
        // 503 with `error:'aborted'` keeps the response inside Hono's typed
        // status set while still signaling "client gave up; do not show as a
        // hard error to the user." The frontend hook already short-circuits
        // when its own AbortController fired, so this body is rarely read.
        return jsonError(c, 503, { error: 'aborted' });
      }
      const reason = err instanceof Error ? err.message : String(err);
      const kind = err instanceof TTSClientError ? err.kind : 'unknown';
      console.warn(`[finding-speak] failed agent=${agent.agentId} kind=${kind} reason=${reason}`);
      return jsonError(c, 500, { error: 'tts-error', reason: reason.slice(0, 200) });
    }
  });
}

import type { Context, Hono } from 'hono';
import type { RouteDeps } from './shared.js';
import { FindingSummaryCache } from '../finding-summary-cache.js';
import { TTSClientError } from '../../adapters/tts-client.js';
import type { SpeakFindingErrorResponse, SpeakFindingResponse } from '../../shared/contracts/speech.js';

export interface SpeechRouteOptions {
  /** Surgical kill-switch independent of KOOKR_TTS. */
  enabled: boolean;
  /** Bound when ttsUrl is set; null otherwise. */
  cache: FindingSummaryCache | null;
  /** Same value the server passes to other consumers. */
  ttsUrl?: string;
}

function jsonError(c: Context, status: 400 | 404 | 409 | 500 | 503, body: SpeakFindingErrorResponse) {
  return c.json(body, status);
}

export function registerSpeechRoutes(app: Hono, deps: RouteDeps, options: SpeechRouteOptions): void {
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

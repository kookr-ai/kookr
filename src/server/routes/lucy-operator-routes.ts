import type { Context, Hono } from 'hono';
import { stream } from 'hono/streaming';
import {
  LUCY_CONVERSATION_ID_RE,
  LUCY_TURN_CONTENT_TYPE,
  LUCY_TURN_PATH,
  MAX_LUCY_TURN_TEXT_CHARS,
  type LucyTurnErrorCode,
  type LucyTurnEvent,
} from '../../shared/contracts/lucy-turn.js';
import { randomUUID } from 'node:crypto';
import { synthesize as synthesizeSpeech, TTSClientError } from '../../adapters/tts-client.js';
import type { SpeakAudioResponse } from '../../shared/contracts/speech.js';
import { countSpokenWords } from '../lucy-interaction-log.js';
import type { AskSpeechDeps } from './ask-routes.js';
import { ASK_SPEECH_TIMEOUT_MS } from './ask-routes.js';
import {
  LUCY_LAUNCH_REPORT_SPEAK_PATH,
  LUCY_LAUNCH_CANCEL_PATH,
  LUCY_LAUNCH_CONFIRM_PATH,
  LUCY_LAUNCH_DECLINE_PATH,
} from '../../shared/contracts/lucy-launch.js';
import type { LucyOperatorService } from '../lucy-operator/service.js';

export interface LucyOperatorRouteDeps {
  /**
   * Absent when the setting `KOOKR_LUCY_OPERATOR` is off: the route then answers 404
   * and no model is ever called. Present without a `service` when the setting is on
   * but something is missing (for example the OpenRouter key): the route answers 503
   * with `unavailableReason`.
   */
  lucyOperator?: { service?: LucyOperatorService; unavailableReason?: string };
  /** The speech service and voice, as the ask routes use them; absent means the report cannot be voiced (503). */
  speech?: AskSpeechDeps;
}

function refuse(code: LucyTurnErrorCode, message: string): { error: LucyTurnErrorCode; message: string } {
  return { error: code, message };
}

/**
 * POST /api/lucy/turn: one sentence from the operator in, Lucy's reply out as a stream
 * of newline-delimited JSON events (see `shared/contracts/lucy-turn.ts`).
 *
 * Owner only: like every route except `/api/auth/session`, it is denied to viewers by
 * the API auth middleware. That matters here because her answers draw on every task.
 */
export function registerLucyOperatorRoutes(app: Hono, deps: LucyOperatorRouteDeps): void {
  app.post(LUCY_TURN_PATH, async (c) => {
    if (!deps.lucyOperator) {
      return c.json(refuse('lucy_operator_disabled', 'Lucy\'s conversation is switched off on this server (set KOOKR_LUCY_OPERATOR=true to enable it).'), 404);
    }
    const service = deps.lucyOperator.service;
    if (!service) {
      return c.json(refuse('lucy_operator_unavailable', deps.lucyOperator.unavailableReason ?? 'Lucy\'s conversation is not available on this server.'), 503);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(refuse('bad_request', 'The request body must be JSON: { "text": string, "conversationId": string }.'), 400);
    }
    const { text: rawText, conversationId, input: rawInput, overlapsReadBack } = (typeof body === 'object' && body !== null ? body : {}) as {
      text?: unknown; conversationId?: unknown; input?: unknown; overlapsReadBack?: unknown;
    };
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    if (!text) return c.json(refuse('bad_request', '"text" must be a non-empty string.'), 400);
    if (text.length > MAX_LUCY_TURN_TEXT_CHARS) {
      return c.json(refuse('bad_request', `"text" must be at most ${MAX_LUCY_TURN_TEXT_CHARS} characters.`), 400);
    }
    if (typeof conversationId !== 'string' || !LUCY_CONVERSATION_ID_RE.test(conversationId)) {
      return c.json(refuse('bad_request', '"conversationId" must be 1 to 64 letters, digits, "_" or "-".'), 400);
    }
    if (service.isBusy(conversationId)) {
      return c.json(refuse('turn_in_progress', 'A turn of this conversation is still running. Wait for it to end, or use another conversation id.'), 409);
    }

    if (service.atCapacity()) {
      return c.json(refuse('too_many_turns', 'Too many turns are running at once. Try again in a moment.'), 429);
    }

    // Aborted when the client goes away, so the model call stops instead of running (and costing) to the end.
    const gone = new AbortController();
    c.header('Content-Type', LUCY_TURN_CONTENT_TYPE);
    c.header('Cache-Control', 'no-store');
    // Tells a reverse proxy not to hold the lines back until the response is complete.
    c.header('X-Accel-Buffering', 'no');
    return stream(c, async (out) => {
      out.onAbort(() => gone.abort());
      const events: AsyncGenerator<LucyTurnEvent, void, void> = service.runTurn(
        {
          text,
          conversationId,
          ...(rawInput === 'voice' || rawInput === 'typed' ? { input: rawInput } : {}),
          ...(overlapsReadBack === true ? { overlapsReadBack: true } : {}),
        },
        gone.signal,
      );
      try {
        for await (const event of events) {
          if (gone.signal.aborted) break;
          await out.write(`${JSON.stringify(event)}\n`);
        }
      } finally {
        // Leaving the loop early must still release the conversation and record the turn.
        await events.return(undefined).catch(() => undefined);
      }
    });
  });

  // Confirm, decline or cancel a launch proposal (issue #3676). The body names the conversation and the
  // proposal and nothing else: the level that decides how the task runs is read by the server when it launches.
  // Each route is registered with its own named constant: the route-documentation check reads route paths by name.
  const launchHandler = (act: 'confirm' | 'decline' | 'cancel') =>
    async (c: Context) => {
      const controller = deps.lucyOperator?.service?.launch;
      if (!controller) {
        return c.json(refuse('lucy_operator_disabled', 'Launching tasks by voice or text is switched off on this server (set KOOKR_LUCY_LAUNCH=true to enable it).'), 404);
      }
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json(refuse('bad_request', 'The request body must be JSON: { "conversationId": string, "proposalId": string }.'), 400);
      }
      const { conversationId, proposalId, via } = (typeof body === 'object' && body !== null ? body : {}) as { conversationId?: unknown; proposalId?: unknown; via?: unknown };
      if (typeof conversationId !== 'string' || !LUCY_CONVERSATION_ID_RE.test(conversationId) || typeof proposalId !== 'string' || !proposalId || proposalId.length > 80) {
        return c.json(refuse('bad_request', '"conversationId" and "proposalId" are required.'), 400);
      }
      if (act === 'confirm') return c.json(await controller.confirm(conversationId, proposalId, via === 'enter' ? 'enter' : 'click'));
      return c.json(act === 'decline' ? controller.decline(conversationId, proposalId) : controller.cancel(conversationId, proposalId));
    };
  app.post(LUCY_LAUNCH_CONFIRM_PATH, launchHandler('confirm'));
  app.post(LUCY_LAUNCH_DECLINE_PATH, launchHandler('decline'));
  app.post(LUCY_LAUNCH_CANCEL_PATH, launchHandler('cancel'));

  // Lucy's voice for the end of a task she launched (issue #3676). Like the ask route, the text is
  // the server's own sentence for that task; nothing the browser sends is spoken.
  app.post(LUCY_LAUNCH_REPORT_SPEAK_PATH, async (c) => {
    const controller = deps.lucyOperator?.service?.launch;
    if (!controller) {
      return c.json(refuse('lucy_operator_disabled', 'Launching tasks by voice or text is switched off on this server (set KOOKR_LUCY_LAUNCH=true to enable it).'), 404);
    }
    const body = (await c.req.json().catch(() => null)) as { taskId?: unknown } | null;
    const taskId = typeof body?.taskId === 'string' ? body.taskId : '';
    const text = taskId ? controller.reportText(taskId) : undefined;
    if (!text) return c.json({ error: 'no_report', message: 'Lucy has nothing to say about that task.' }, 404);
    const speech = deps.speech;
    if (!speech?.ttsUrl) return c.json({ error: 'tts_not_configured', message: 'The speech service is not configured.' }, 503);

    const voice = speech.getVoice();
    const startedAt = Date.now();
    const synthesize = speech.synthesize ?? synthesizeSpeech;
    const request = { ttsUrl: speech.ttsUrl, text, voice, timeoutMs: ASK_SPEECH_TIMEOUT_MS, signal: c.req.raw.signal };
    try {
      // A voice is loaded on first use, which can take longer than one attempt: one more try finds it loaded.
      const audio = await synthesize(request).catch((err: unknown) => {
        if (err instanceof TTSClientError && err.kind === 'timeout' && !c.req.raw.signal.aborted) return synthesize(request);
        throw err;
      });
      const ttsMs = Date.now() - startedAt;
      const clipId = randomUUID();
      try {
        speech.lucyLog?.recordSaid({
          clipId, source: 'task_summary', taskId, text, usedFallback: false, cached: false, voice,
          llmMs: 0, ttsMs, durationMs: audio.durationMs, words: countSpokenWords(text),
        });
      } catch {
        // Recording must not stop her from speaking.
      }
      const response: SpeakAudioResponse = {
        text, audioBase64: audio.audioBase64, mimeType: 'audio/wav', durationMs: audio.durationMs,
        usedFallback: false, llmMs: 0, ttsMs, cached: false, clipId,
      };
      return c.json(response);
    } catch (err) {
      const kind = err instanceof TTSClientError ? err.kind : 'unknown';
      console.warn(`[lucy-launch] report speech failed task=${taskId} kind=${kind}`);
      return c.json({ error: 'tts_failed', message: 'The speech service failed.' }, 502);
    }
  });
}

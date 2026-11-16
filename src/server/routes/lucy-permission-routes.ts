/**
 * POST /api/lucy/permission-notice/speak: Lucy's voice for a permission notice (issue #3932).
 *
 * The browser sends only the notice id it was given in a `lucyPermissionCards` message; the
 * sentence is the one the server wrote for it, so nothing the browser or an agent supplies is
 * spoken. 409 once every prompt the notice is about has been answered: a sentence about prompts
 * that are gone would only mislead. Each clip made here is one line in `lucy-interactions.jsonl`.
 */
import type { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { synthesize as synthesizeSpeech, TTSClientError } from '../../adapters/tts-client.js';
import { LUCY_PERMISSION_NOTICE_SPEAK_PATH } from '../../shared/contracts/lucy-permission.js';
import type { SpeakAudioResponse } from '../../shared/contracts/speech.js';
import { countSpokenWords } from '../lucy-interaction-log.js';
import type { LucyPermissionNotifier } from '../lucy-permission-notice.js';
import { ASK_SPEECH_TIMEOUT_MS, type AskSpeechDeps } from './ask-routes.js';

export interface LucyPermissionRouteDeps {
  /** Absent in route-only harnesses: the route then answers 404. */
  notices?: Pick<LucyPermissionNotifier, 'notice'>;
  /** The speech service and voice, as the ask routes use them; no `ttsUrl` means 503. */
  speech?: AskSpeechDeps;
}

export function registerLucyPermissionRoutes(app: Hono, deps: LucyPermissionRouteDeps): void {
  app.post(LUCY_PERMISSION_NOTICE_SPEAK_PATH, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { noticeId?: unknown } | null;
    const noticeId = typeof body?.noticeId === 'string' && body.noticeId.length <= 80 ? body.noticeId : '';
    const notice = noticeId ? deps.notices?.notice(noticeId) : undefined;
    if (!notice) return c.json({ error: 'no_notice', message: 'Lucy has nothing to say about that.' }, 404);
    if (!notice.open) return c.json({ error: 'answered', message: 'Those prompts have been answered.' }, 409);
    const speech = deps.speech;
    if (!speech?.ttsUrl) return c.json({ error: 'tts_not_configured', message: 'The speech service is not configured.' }, 503);

    const text = notice.text;
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
          clipId, source: 'permission_notice', text, usedFallback: false, cached: false, voice,
          llmMs: 0, ttsMs, durationMs: audio.durationMs, words: countSpokenWords(text),
          ...(notice.taskId ? { taskId: notice.taskId } : {}),
          ...(notice.taskName ? { taskName: notice.taskName } : {}),
        });
      } catch (err) {
        console.warn(`[lucy-log] recordSaid threw: ${err instanceof Error ? err.message : String(err)}`);
      }
      const response: SpeakAudioResponse = {
        text, audioBase64: audio.audioBase64, mimeType: 'audio/wav', durationMs: audio.durationMs,
        usedFallback: false, llmMs: 0, ttsMs, cached: false, clipId,
        ...(notice.taskName ? { subject: notice.taskName } : {}),
      };
      return c.json(response);
    } catch (err) {
      const kind = err instanceof TTSClientError ? err.kind : 'unknown';
      console.warn(`[lucy-permission] notice speech failed notice=${noticeId} kind=${kind}`);
      return c.json({ error: 'tts_failed', message: 'The speech service failed.' }, 502);
    }
  });
}

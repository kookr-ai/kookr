/**
 * Builds the real Lucy live service: wires the speech recogniser, the Baseten stream,
 * the speech service, the live task list and the interaction log into the ports of
 * {@link LucyLiveSession}, and returns the connection handler the HTTP server calls
 * for each authenticated `/ws/lucy-live` upgrade.
 */

import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import type { SileroVad } from '../../adapters/lucy-live/silero-vad.js';
import { openEarsTurn, transcribeOnce } from '../../adapters/lucy-live/ears-client.js';
import { streamBasetenChat } from '../../adapters/llm/baseten-stream.js';
import { synthesize } from '../../adapters/tts-client.js';
import { buildLucyLiveBriefing, type BriefingTask } from '../../core/lucy-live/briefing.js';
import { redactSpeechSecrets } from '../../core/task-speech-summary.js';
import { countSpokenWords, DISABLED_LUCY_INTERACTION_LOG, type LucyInteractionLog } from '../lucy-interaction-log.js';
import type { LucyLiveConfig } from './config.js';
import { LucyLiveSession, type LucyLivePorts } from './session.js';
import { bindLucyLiveSocket } from './ws-handler.js';

export interface LucyLiveDeps {
  config: LucyLiveConfig;
  /** Silero speech detector; null or absent when it could not be loaded (interruptions are then not confirmed). */
  vad?: SileroVad | null;
  /** Live task list; read fresh for every turn. */
  getTasks: () => readonly BriefingTask[];
  /** Voice resolved at call time, like the speech routes (settings first, then the install default). */
  getVoice: () => string;
  log?: LucyInteractionLog;
  warn?: (message: string) => void;
  now?: () => number;
}

export interface LucyLiveService {
  handleConnection(ws: WebSocket, req: IncomingMessage): void;
}

export function createLucyLive(deps: LucyLiveDeps): LucyLiveService {
  const log = deps.log ?? DISABLED_LUCY_INTERACTION_LOG;
  const warn = deps.warn ?? ((m: string) => console.warn(`[lucy-live] ${m}`));
  const now = deps.now ?? Date.now;
  const { earsUrl, brain, ttsUrl } = deps.config;

  return {
    handleConnection(ws) {
      bindLucyLiveSocket(ws, (send) => {
        const ports: LucyLivePorts = {
          send,
          openEars: (language) => openEarsTurn({ url: earsUrl, language }),
          transcribeDraft: (pcm, language, signal) => transcribeOnce({ url: earsUrl, language, pcm, signal }),
          streamAnswer: ({ system, history, user, signal }) => streamBasetenChat(brain, {
            messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: user }],
            signal,
            maxTokens: 200,
            temperature: 0.3,
            reasoningEffort: 'none',
          }),
          openVad: deps.vad ? () => deps.vad!.openTurn() : undefined,
          synthesize: async (text, signal) => {
            const result = await synthesize({ ttsUrl, text, voice: deps.getVoice(), signal });
            return { wavBase64: result.audioBase64, durationMs: result.durationMs };
          },
          buildBriefing: () => buildLucyLiveBriefing(deps.getTasks(), now()),
          now,
          warn,
          recordTurn: (r) => {
            const transcript = r.transcript === undefined ? undefined : redactSpeechSecrets(r.transcript);
            log.recordLiveTurn({
              turnId: r.turnId,
              language: r.language,
              end: r.end,
              reason: r.reason,
              transcript,
              answer: r.answer,
              voice: deps.getVoice(),
              asrMs: r.asrMs,
              firstSentenceMs: r.firstSentenceMs,
              firstAudioMs: r.firstAudioMs,
              sentences: r.sentences,
              transcriptWords: transcript ? countSpokenWords(transcript) : 0,
              answerWords: r.answer ? countSpokenWords(r.answer) : 0,
            });
          },
        };
        return new LucyLiveSession(ports);
      }, warn);
    },
  };
}

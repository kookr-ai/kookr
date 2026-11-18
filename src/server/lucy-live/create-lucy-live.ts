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
import { BasetenStreamError, streamBasetenChat, type BasetenStreamConfig, type StreamChatRequest } from '../../adapters/llm/baseten-stream.js';
import { synthesize } from '../../adapters/tts-client.js';
import { randomUUID } from 'node:crypto';
import type { LucyOperatorService } from '../lucy-operator/service.js';
import { buildLucyLiveBriefing, type BriefingNeed, type BriefingTask, type BriefingTrainHealth } from '../../core/lucy-live/briefing.js';
import { createBasetenLlmClientFromEnv } from '../../adapters/llm/baseten-client.js';
import { buildAnswerMatchPrompt, parseAnswerMatch, pendingVoiceAsks, type AnswerMatch, type VoiceAskChoice } from '../../core/lucy-live/voice-answer.js';
import { openableVoiceAsks } from '../../core/lucy-live/open-intent.js';
import { buildAskSpeech } from '../../core/operator-asks.js';
import { redactSpeechSecrets } from '../../core/task-speech-summary.js';
import { countSpokenWords, DISABLED_LUCY_INTERACTION_LOG, type LucyInteractionLog } from '../lucy-interaction-log.js';
import type { LucyUnpromptedLog } from '../lucy-unprompted.js';
import type { AnswerResult, DashboardAnswerInput, OperatorAskView } from '../../shared/contracts/asks.js';
import type { LucyLiveConfig } from './config.js';
import { LucyLiveSession, type LucyLivePorts } from './session.js';
import { bindLucyLiveSocket } from './ws-handler.js';

export interface LucyLiveDeps {
  config: LucyLiveConfig;
  /** Silero speech detector; null or absent when it could not be loaded (interruptions are then not confirmed). */
  vad?: SileroVad | null;
  /** Live task list; read fresh for every turn. */
  getTasks: () => readonly BriefingTask[];
  /** Questions tasks asked the operator (`kookr ask`): pending and recently closed. Read fresh for every turn. */
  getAsks?: () => readonly OperatorAskView[];
  /** The live tasks waiting on the operator and why (issue #3927), built like the board's. Read fresh for every turn. */
  getNeedsOperator?: () => readonly BriefingNeed[];
  /** The integration train's state; null when this server does not watch a train. Read fresh for every turn. */
  getTrainHealth?: () => BriefingTrainHealth | null;
  /**
   * Record an answer to a question (the audited dashboard entry point). Without it, and without
   * `getAsks`, a question can be read and discussed by voice but not answered.
   */
  answerAsk?: (input: DashboardAnswerInput) => Promise<AnswerResult>;
  /** Test seam: the non-streaming call that maps spoken words to a choice. Default: the Baseten helper model. */
  matchAnswer?: (req: { transcript: string; asks: readonly VoiceAskChoice[]; signal: AbortSignal }) => Promise<AnswerMatch>;
  /** Voice resolved at call time, like the speech routes (settings first, then the install default). */
  getVoice: () => string;
  /**
   * Lucy's operator conversation, when launching is switched on (issue #3676). Talk turns are then
   * answered by it instead of the helper model, so a spoken request can become a launch proposal.
   * Read when each turn starts, because the service is built after Lucy live.
   */
  getOperator?: () => LucyOperatorService | undefined;
  /**
   * The server's record of what Lucy said unprompted (issue #4143). A question Talk reads out goes in
   * as soon as the browser reports playing it, so a typed turn that follows knows about it too.
   */
  unprompted?: Pick<LucyUnpromptedLog, 'record'>;
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
  // One per service, so every connection learns from the first refusal.
  const streamHelperAnswer = helperAnswerStream(brain, warn);

  return {
    handleConnection(ws) {
      bindLucyLiveSocket(ws, (send) => {
        // One conversation per connection: the proposals she makes by voice are held against it.
        const conversationId = `live-${randomUUID()}`;
        // A tab closed during a read-back must not leave a hands-off launch counting down.
        ws.once('close', () => {
          try { deps.getOperator?.()?.closeConversation(conversationId); } catch { /* shutting down */ }
        });
        const ports: LucyLivePorts = {
          send,
          openEars: (language) => openEarsTurn({ url: earsUrl, language }),
          transcribeDraft: (pcm, language, signal) => transcribeOnce({ url: earsUrl, language, pcm, signal }),
          streamAnswer: ({ system, history, user, signal, speechStartedAt, stayQuiet, overlapsAudio }) => {
            const operator = deps.getOperator?.();
            if (operator?.launch) return streamFromOperator(operator, { conversationId, text: user, signal, speechStartedAt, stayQuiet, overlapsAudio });
            return streamHelperAnswer({
              messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: user }],
              signal,
              maxTokens: 200,
              temperature: 0.3,
            });
          },
          noteAudible: (until) => deps.getOperator?.()?.noteSpeaking(conversationId, until),
          openVad: deps.vad ? () => deps.vad!.openTurn() : undefined,
          synthesize: async (text, signal) => {
            const result = await synthesize({ ttsUrl, text, voice: deps.getVoice(), signal });
            return { wavBase64: result.audioBase64, durationMs: result.durationMs };
          },
          ...(deps.getAsks && deps.answerAsk ? {
            pendingAsks: () => pendingVoiceAsks(deps.getAsks!()),
            matchAnswer: deps.matchAnswer ?? matchWithHelperModel,
            answerAsk: (askId: string, optionIndex: number) => deps.answerAsk!({ askId, optionIndex }),
          } : {}),
          ...(deps.getAsks ? {
            openableAsks: () => openableVoiceAsks(deps.getAsks!()),
            // The same sentence the clip route says (`POST /api/asks/:id/speak`), for a question still waiting.
            askSpeech: (askId: string) => {
              const ask = deps.getAsks!().find((a) => a.id === askId && a.state === 'pending');
              return ask ? buildAskSpeech(ask, ask.taskName) : undefined;
            },
          } : {}),
          noteUnprompted: (note, said) => deps.getOperator?.()?.rememberSaid?.(conversationId, note, said),
          // The same question also goes into the record every conversation reads. It is marked as held by
          // this conversation, whose history gets it through `noteUnprompted`, so it is not shown here twice.
          ...(deps.unprompted && deps.getAsks ? {
            heardUnprompted: (askId: string) => {
              const ask = deps.getAsks!().find((a) => a.id === askId);
              if (!ask) return;
              deps.unprompted!.record({
                key: `ask:${askId}`,
                sameSaying: true,
                text: buildAskSpeech(ask, ask.taskName),
                tasks: [{ id: ask.taskId, ...(ask.taskName ? { name: ask.taskName } : {}) }],
                stillOpen: () => deps.getAsks!().some((a) => a.id === askId && a.state === 'pending'),
                inConversation: conversationId,
              });
            },
          } : {}),
          // A "yes" answers the one proposal on screen, whichever conversation made it: a question waits for any.
          // Her answer, reply and close cards are confirmed the same way, so a question waits for one of those too.
          launchPendingUntil: () => {
            const operator = deps.getOperator?.();
            const launch = operator?.launch?.pending();
            const launchUntil = launch ? (launch.launchesAt ?? launch.expiresAt) : undefined;
            const actionUntil = operator?.actions?.pending()?.expiresAt;
            if (launchUntil === undefined || actionUntil === undefined) return launchUntil ?? actionUntil;
            return Math.max(launchUntil, actionUntil);
          },
          buildBriefing: () => buildLucyLiveBriefing(deps.getTasks(), now(), deps.getAsks?.() ?? [], {
            ...(deps.getNeedsOperator ? { needs: deps.getNeedsOperator() } : {}),
            ...(deps.getTrainHealth ? { train: deps.getTrainHealth() } : {}),
          }),
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

/**
 * The helper model's answer, streamed. It is asked not to reason first, so she can start speaking at
 * once. A model that refuses that setting (HTTP 400, for example a custom `KOOKR_BASETEN_MODEL`) is
 * asked again without it. Once a request without it is accepted, the setting is left out for the
 * rest of this run; a 400 that the retry does not cure had another cause, so nothing is remembered.
 */
function helperAnswerStream(
  brain: BasetenStreamConfig,
  warn: (message: string) => void,
): (req: Omit<StreamChatRequest, 'reasoningEffort'>) => AsyncGenerator<string, void, void> {
  let omitReasoningEffort = false;
  return async function* stream(req) {
    if (omitReasoningEffort) {
      yield* streamBasetenChat(brain, { ...req, reasoningEffort: null });
      return;
    }
    let spoke = false;
    try {
      for await (const delta of streamBasetenChat(brain, { ...req, reasoningEffort: 'none' })) {
        spoke = true;
        yield delta;
      }
      return;
    } catch (err) {
      if (spoke || !(err instanceof BasetenStreamError && err.status === 400)) throw err;
    }
    const remember = (): void => {
      if (omitReasoningEffort) return;
      omitReasoningEffort = true;
      warn(`the helper model (${brain.model}) refused reasoning_effort "none" with HTTP 400; it is now asked without that setting, so her answers may start later.`);
    };
    for await (const delta of streamBasetenChat(brain, { ...req, reasoningEffort: null })) {
      remember();
      yield delta;
    }
    remember();
  };
}

/**
 * A spoken request answered by the operator conversation: her text goes to the speech service as it
 * arrives. The proposal card itself reaches the dashboard through the launch controller's broadcast.
 * Words that began while she was reading a proposal aloud come back as `ignored`: she stays quiet.
 */
async function* streamFromOperator(
  operator: LucyOperatorService,
  req: { conversationId: string; text: string; signal: AbortSignal; speechStartedAt: number; stayQuiet: () => void; overlapsAudio: boolean },
): AsyncGenerator<string, void, void> {
  for await (const event of operator.runTurn({ text: req.text, conversationId: req.conversationId, input: 'voice', ...(req.overlapsAudio ? { overlapsReadBack: true } : {}) }, req.signal, { speechStartedAt: req.speechStartedAt })) {
    if (event.type === 'text') yield event.delta;
    else if (event.type === 'done') {
      if (event.end === 'ignored') req.stayQuiet();
      else if (event.end === 'error') throw new Error(event.reason ?? 'The operator conversation failed.');
    }
  }
}

/** The mapping call: one non-streaming completion, no reasoning, JSON out. A failure is reported to the caller, who then sends nothing. */
async function matchWithHelperModel(req: { transcript: string; asks: readonly VoiceAskChoice[]; signal: AbortSignal }): Promise<AnswerMatch> {
  const client = createBasetenLlmClientFromEnv({ ...process.env, KOOKR_BASETEN_REASONING_EFFORT: 'none' });
  if (!client) throw new Error('no Baseten key is configured');
  const { system, user } = buildAnswerMatchPrompt(req.transcript, req.asks);
  const raw = await client.complete({
    system,
    userMessage: user,
    maxTokens: 60,
    timeoutMs: 6000,
    signal: req.signal,
    responseFormat: { type: 'json_object' },
  });
  return parseAnswerMatch(raw, req.asks);
}

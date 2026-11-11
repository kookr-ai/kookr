/**
 * One Lucy live conversation: the state machine behind a single browser connection.
 *
 * It owns no I/O of its own. Everything outside (the speech recogniser, the helper
 * model, the speech synthesiser, the clock, the log and the socket) comes in as a
 * "port" so the whole flow can be tested with fakes.
 *
 * One turn at a time, in this order:
 *   speech_start -> listening (ears session opens, audio is forwarded, drafts every ~1 s)
 *   speech_end   -> transcribing (final transcript) -> thinking (model streams the answer)
 *                -> speaking (each sentence is spoken and sent in order) -> turn_done
 * A new `speech_start` or a `barge_in` while the turn is past `listening` cancels the
 * model stream and pending speech at once and ends the turn as `interrupted`.
 *
 * Conversation memory is plain text, the last {@link MAX_HISTORY_EXCHANGES} exchanges.
 * For Lucy's side it keeps only what the operator heard: the sentences the browser
 * reported as `played`, or, if the browser never reported, the sentences sent. An
 * interrupted answer is kept truncated and marked, so the model knows it was cut off.
 */

import {
  LUCY_LIVE_MAX_TURN_SECONDS,
  LUCY_LIVE_SAMPLE_RATE,
  type LucyLiveClientMessage,
  type LucyLiveLanguage,
  type LucyLiveServerMessage,
  type LucyLiveState,
  type LucyLiveTurnEnd,
} from '../../shared/contracts/lucy-live.js';
import { buildLucyLivePersona } from '../../core/lucy-live/persona.js';
import { SentenceSplitter } from '../../core/lucy-live/sentence-splitter.js';
import { isEmptyTranscript } from '../../core/lucy-live/transcript-filter.js';
import { makeSpeakable } from '../../core/speakable-text.js';
import { redactSpeechSecrets } from '../../core/task-speech-summary.js';

export const MAX_HISTORY_EXCHANGES = 8;
/** New audio (in bytes of PCM16) that must arrive before another draft transcript is attempted: 1 s. */
export const DRAFT_INTERVAL_BYTES = LUCY_LIVE_SAMPLE_RATE * 2;
const MAX_TURN_BYTES = LUCY_LIVE_MAX_TURN_SECONDS * LUCY_LIVE_SAMPLE_RATE * 2;
const INTERRUPTED_MARKER = '(interrupted)';

export interface EarsTurnPort {
  append(pcm: Buffer): void;
  finish(): Promise<string>;
  abort(): void;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface SpokenSentence {
  wavBase64: string;
  durationMs: number;
}

export interface LiveTurnRecord {
  turnId: string;
  language: LucyLiveLanguage;
  end: LucyLiveTurnEnd;
  reason?: string;
  transcript?: string;
  answer?: string;
  /** speech_end to final transcript. */
  asrMs?: number;
  /** speech_end to the first sentence's text being ready. */
  firstSentenceMs?: number;
  /** speech_end to the first `sentence` message being sent. */
  firstAudioMs?: number;
  sentences: number;
}

export interface LucyLivePorts {
  send(message: LucyLiveServerMessage): void;
  /** Open a fresh recogniser session for one turn. Never throws; failures surface from `finish`. */
  openEars(language: LucyLiveLanguage): EarsTurnPort;
  /** Transcribe the audio so far in its own session (an improving draft). */
  transcribeDraft(pcm: Buffer, language: LucyLiveLanguage, signal: AbortSignal): Promise<string>;
  /** Stream the answer text. Must stop and throw when `signal` aborts. */
  streamAnswer(req: { system: string; history: readonly ChatTurn[]; user: string; signal: AbortSignal }): AsyncIterable<string>;
  synthesize(text: string, signal: AbortSignal): Promise<SpokenSentence>;
  /** Fresh task status text, built for every turn. */
  buildBriefing(): string;
  now(): number;
  warn(message: string): void;
  recordTurn(record: LiveTurnRecord): void;
}

interface ExchangeMemory {
  turnId: string;
  user: string;
  sentences: string[];
  /** seq -> whether the browser played that sentence to its end. Empty until a `played` arrives. */
  played: Map<number, boolean>;
  interrupted: boolean;
}

interface Turn {
  id: string;
  language: LucyLiveLanguage;
  phase: 'listening' | 'transcribing' | 'thinking' | 'speaking';
  closed: boolean;
  abort: AbortController;
  ears: EarsTurnPort;
  chunks: Buffer[];
  bytes: number;
  bytesAtLastDraft: number;
  draftAbort: AbortController | null;
  speechEndAt?: number;
  transcript?: string;
  sentences: string[];
  asrMs?: number;
  firstSentenceMs?: number;
  firstAudioMs?: number;
  memory?: ExchangeMemory;
}

class TurnAbandoned extends Error {}

function describeFailure(stage: 'ears' | 'brain' | 'mouth', err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  switch (stage) {
    case 'ears': return `I could not hear that: the speech recogniser failed (${detail}).`;
    case 'brain': return `I could not think of an answer: the helper model failed (${detail}).`;
    case 'mouth': return `I could not speak the answer: the speech service failed (${detail}).`;
  }
}

export class LucyLiveSession {
  private language: LucyLiveLanguage = 'en';
  private state: LucyLiveState = 'idle';
  private turn: Turn | null = null;
  private readonly memory: ExchangeMemory[] = [];
  private closedForGood = false;

  constructor(private readonly ports: LucyLivePorts) {}

  /** True between `speech_start` and `speech_end`: the only time audio frames are accepted. */
  get acceptingAudio(): boolean {
    return this.turn?.phase === 'listening';
  }

  handleMessage(msg: LucyLiveClientMessage): void {
    if (this.closedForGood) return;
    switch (msg.type) {
      case 'hello':
        this.language = msg.language;
        this.ports.send({ type: 'ready' });
        return;
      case 'speech_start':
        this.onSpeechStart(msg.turnId);
        return;
      case 'speech_end':
        this.onSpeechEnd(msg.turnId);
        return;
      case 'speech_cancel':
        this.onSpeechCancel(msg.turnId);
        return;
      case 'barge_in':
        this.onBargeIn();
        return;
      case 'played':
        this.onPlayed(msg.turnId, msg.seq, msg.complete);
        return;
    }
  }

  /** A binary frame of PCM16 audio from the browser. Ignored outside a listening turn. */
  handleAudio(pcm: Buffer): void {
    const turn = this.turn;
    if (this.closedForGood || !turn || turn.phase !== 'listening') return;
    const room = MAX_TURN_BYTES - turn.bytes;
    if (room <= 0) return; // audio beyond the cap is cut off
    const chunk = pcm.length > room ? pcm.subarray(0, room) : pcm;
    turn.chunks.push(chunk);
    turn.bytes += chunk.length;
    turn.ears.append(chunk);
    this.maybeStartDraft(turn);
  }

  /** The socket went away: stop everything silently. */
  close(): void {
    if (this.closedForGood) return;
    this.closedForGood = true;
    const turn = this.turn;
    if (turn) this.discard(turn);
  }

  // -- message handlers ------------------------------------------------------

  private onSpeechStart(turnId: string): void {
    const previous = this.turn;
    if (previous) {
      if (previous.phase === 'listening') this.discard(previous);
      else this.endTurn(previous, 'interrupted', undefined, false);
    }
    const turn: Turn = {
      id: turnId,
      language: this.language,
      phase: 'listening',
      closed: false,
      abort: new AbortController(),
      ears: this.ports.openEars(this.language),
      chunks: [],
      bytes: 0,
      bytesAtLastDraft: 0,
      draftAbort: null,
      sentences: [],
    };
    this.turn = turn;
    this.setState('listening');
  }

  private onSpeechCancel(turnId: string): void {
    const turn = this.turn;
    if (!turn || turn.id !== turnId || turn.phase !== 'listening') return;
    this.discard(turn);
    this.setState('idle');
  }

  private onBargeIn(): void {
    const turn = this.turn;
    if (!turn || turn.phase === 'listening') return; // a speech_start follows and handles it
    this.endTurn(turn, 'interrupted');
  }

  private onPlayed(turnId: string, seq: number, complete: boolean): void {
    const entry = this.memory.find((m) => m.turnId === turnId);
    if (entry) entry.played.set(seq, complete);
  }

  private onSpeechEnd(turnId: string): void {
    const turn = this.turn;
    if (!turn || turn.id !== turnId || turn.phase !== 'listening') return;
    turn.speechEndAt = this.ports.now();
    turn.phase = 'transcribing';
    // Drafts must never delay the final transcript: stop waiting for one and drop its result.
    turn.draftAbort?.abort();
    turn.draftAbort = null;
    this.setState('transcribing');
    void this.runTurn(turn);
  }

  // -- drafts ----------------------------------------------------------------

  private maybeStartDraft(turn: Turn): void {
    if (turn.draftAbort || turn.bytes - turn.bytesAtLastDraft < DRAFT_INTERVAL_BYTES) return;
    turn.bytesAtLastDraft = turn.bytes;
    const abort = new AbortController();
    turn.draftAbort = abort;
    const pcm = Buffer.concat(turn.chunks);
    this.ports.transcribeDraft(pcm, turn.language, abort.signal).then(
      (text) => {
        if (turn.draftAbort === abort) turn.draftAbort = null;
        if (abort.signal.aborted || turn.closed || turn.phase !== 'listening') return;
        if (isEmptyTranscript(text)) return;
        this.ports.send({ type: 'transcript', turnId: turn.id, text, final: false });
      },
      () => {
        // A failed draft is only a missed preview; the final transcript decides.
        if (turn.draftAbort === abort) turn.draftAbort = null;
      },
    );
  }

  // -- the turn pipeline -----------------------------------------------------

  private async runTurn(turn: Turn): Promise<void> {
    try {
      const transcript = await this.transcribe(turn);
      if (turn.closed) return;
      if (isEmptyTranscript(transcript)) {
        this.endTurn(turn, 'empty');
        return;
      }
      turn.transcript = transcript;
      this.ports.send({ type: 'transcript', turnId: turn.id, text: transcript, final: true });
      turn.phase = 'thinking';
      this.setState('thinking');
      await this.answer(turn, transcript);
    } catch (err) {
      if (turn.closed) return;
      if (err instanceof StageError) this.endTurn(turn, 'error', describeFailure(err.stage, err.cause));
      else this.endTurn(turn, 'error', `Something went wrong: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async transcribe(turn: Turn): Promise<string> {
    let text: string;
    try {
      text = await turn.ears.finish();
    } catch (err) {
      throw new StageError('ears', err);
    }
    turn.asrMs = this.ports.now() - (turn.speechEndAt ?? this.ports.now());
    return text;
  }

  private async answer(turn: Turn, transcript: string): Promise<void> {
    const signal = turn.abort.signal;
    const history = this.historyMessages();
    const memory: ExchangeMemory = {
      turnId: turn.id, user: transcript, sentences: turn.sentences, played: new Map(), interrupted: false,
    };
    turn.memory = memory;
    this.memory.push(memory);
    if (this.memory.length > MAX_HISTORY_EXCHANGES) this.memory.shift();

    const splitter = new SentenceSplitter();
    let seq = 0;
    // Sentences are synthesised as soon as they exist (so N+1 renders while N plays) but
    // sent strictly in order: each send waits for the previous one.
    let sendChain: Promise<void> = Promise.resolve();
    // When a sentence cannot be spoken the answer is lost anyway, so stop the model
    // stream at once instead of reading it to the end.
    const brainAbort = new AbortController();
    const stopBrain = (): void => brainAbort.abort();
    signal.addEventListener('abort', stopBrain, { once: true });
    let mouthFailure: unknown;

    const speak = (raw: string): void => {
      const text = makeSpeakable(redactSpeechSecrets(raw)).trim();
      if (!/[\p{L}\p{N}]/u.test(text)) return;
      const mySeq = seq++;
      if (turn.firstSentenceMs === undefined) turn.firstSentenceMs = this.elapsed(turn);
      const spoken = this.ports.synthesize(text, signal);
      spoken.catch(() => {}); // surfaced through sendChain; avoid an unhandled-rejection window
      sendChain = sendChain.then(async () => {
        let audio: SpokenSentence;
        try {
          audio = await spoken;
        } catch (err) {
          if (turn.closed) throw new TurnAbandoned();
          mouthFailure = err;
          brainAbort.abort();
          throw new StageError('mouth', err);
        }
        if (turn.closed) throw new TurnAbandoned();
        if (turn.firstAudioMs === undefined) turn.firstAudioMs = this.elapsed(turn);
        turn.sentences.push(text);
        if (turn.phase === 'thinking') {
          turn.phase = 'speaking';
          this.setState('speaking');
        }
        this.ports.send({
          type: 'sentence', turnId: turn.id, seq: mySeq, text,
          wavBase64: audio.wavBase64, durationMs: audio.durationMs,
        });
      });
      sendChain.catch(() => {}); // the final await below reports it
    };

    try {
      try {
        for await (const delta of this.ports.streamAnswer({ system: buildLucyLivePersona(this.ports.buildBriefing()), history, user: transcript, signal: brainAbort.signal })) {
          if (turn.closed) return;
          if (mouthFailure !== undefined) break;
          for (const sentence of splitter.push(delta)) speak(sentence);
        }
      } catch (err) {
        if (turn.closed) return;
        if (mouthFailure !== undefined) throw new StageError('mouth', mouthFailure);
        throw new StageError('brain', err);
      } finally {
        signal.removeEventListener('abort', stopBrain);
      }
      if (mouthFailure !== undefined) throw new StageError('mouth', mouthFailure);
      const rest = splitter.flush();
      if (rest) speak(rest);
      await sendChain;
    } catch (err) {
      if (err instanceof TurnAbandoned || turn.closed) return;
      throw err;
    }
    if (turn.closed) return;
    if (turn.sentences.length === 0) {
      this.endTurn(turn, 'error', 'The helper model returned no answer.');
      return;
    }
    this.endTurn(turn, 'answered');
  }

  // -- ending and bookkeeping ------------------------------------------------

  /** Drop a turn that never reached a transcript request: no message, no history. */
  private discard(turn: Turn): void {
    turn.closed = true;
    turn.abort.abort();
    turn.draftAbort?.abort();
    turn.ears.abort();
    if (this.turn === turn) this.turn = null;
  }

  private endTurn(turn: Turn, end: LucyLiveTurnEnd, reason?: string, settleToIdle = true): void {
    if (turn.closed) return;
    turn.closed = true;
    turn.abort.abort();
    turn.draftAbort?.abort();
    turn.ears.abort();
    if (this.turn === turn) this.turn = null;
    if (turn.memory) {
      turn.memory.interrupted = end === 'interrupted';
      if (end === 'error' && turn.sentences.length === 0) {
        const at = this.memory.indexOf(turn.memory);
        if (at >= 0) this.memory.splice(at, 1);
      }
    }
    this.ports.send({ type: 'turn_done', turnId: turn.id, end, ...(reason ? { reason } : {}) });
    if (settleToIdle) this.setState('idle');
    try {
      this.ports.recordTurn({
        turnId: turn.id,
        language: turn.language,
        end,
        reason,
        transcript: turn.transcript,
        answer: turn.sentences.length > 0 ? turn.sentences.join(' ') : undefined,
        asrMs: turn.asrMs,
        firstSentenceMs: turn.firstSentenceMs,
        firstAudioMs: turn.firstAudioMs,
        sentences: turn.sentences.length,
      });
    } catch (err) {
      this.ports.warn(`lucy-live: recording the turn failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private elapsed(turn: Turn): number {
    return this.ports.now() - (turn.speechEndAt ?? this.ports.now());
  }

  private setState(state: LucyLiveState): void {
    if (this.state === state) return;
    this.state = state;
    this.ports.send({ type: 'state', state });
  }

  /** Last exchanges as chat messages, in what the operator heard. */
  private historyMessages(): ChatTurn[] {
    const out: ChatTurn[] = [];
    for (const entry of this.memory) {
      out.push({ role: 'user', content: entry.user });
      out.push({ role: 'assistant', content: this.heardText(entry) });
    }
    return out;
  }

  private heardText(entry: ExchangeMemory): string {
    let spoken: string[];
    let cutShort = entry.interrupted;
    if (entry.played.size > 0) {
      const seqs = [...entry.played.keys()].sort((a, b) => a - b);
      spoken = seqs.flatMap((s) => (entry.sentences[s] !== undefined ? [entry.sentences[s]] : []));
      if (seqs.some((s) => entry.played.get(s) === false)) cutShort = true;
      // Sentences that were sent but never reported played were not heard.
      if (seqs.length < entry.sentences.length) cutShort = true;
    } else {
      spoken = entry.sentences;
    }
    const text = spoken.join(' ');
    if (!cutShort) return text || INTERRUPTED_MARKER;
    return text ? `${text} ${INTERRUPTED_MARKER}` : INTERRUPTED_MARKER;
  }
}

class StageError extends Error {
  constructor(readonly stage: 'ears' | 'brain' | 'mouth', readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

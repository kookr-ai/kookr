/**
 * One hands-free conversation with Lucy, from microphone to speakers, with no React in it.
 * `useLucyLive.ts` wraps it for the avatar panel; the wire format is documented in
 * `src/shared/contracts/lucy-live.ts`.
 *
 * What it does, in the order a turn happens:
 * 1. Listens to the microphone (16 kHz frames of about 32 ms) and runs each frame through
 *    the voice detector.
 * 2. When the detector says the operator started speaking, it tells the server
 *    (`speech_start`) and streams the audio until the detector says they stopped
 *    (`speech_end`). A sound too short to be speech is withdrawn (`speech_cancel`).
 * 3. Plays the answer sentence by sentence as the server delivers it, scheduling each one
 *    to begin exactly when the previous one ends, and announces it on the speech bus so
 *    the avatar's mouth moves.
 * 4. If the operator starts speaking while Lucy is thinking or talking, stops her audio in
 *    the same moment, before any network round trip, then tells the server.
 */
import {
  LUCY_LIVE_SAMPLE_RATE,
  LUCY_LIVE_WS_PATH,
  type LucyLiveClientMessage,
  type LucyLiveLanguage,
  type LucyLiveServerMessage,
  type LucyLiveState,
  type LucyLiveTurnEnd,
} from '../../shared/contracts/lucy-live.js';
import { createScriptProcessorFallback, tryCreateWorkletNode } from '../audio/pcm-capture.js';
import { emitSpeechGenerating, emitSpeechIdle, emitSpeechPlaying } from '../audio/speech-bus.js';
import { track } from '../telemetry.js';
import { createVoiceDetector, type VoiceDetector } from './voice-detector.js';

export type LucyLiveStatusKind = 'off' | 'connecting' | 'unavailable' | 'ready' | 'error';

export interface LucyLiveTimings {
  /** From the operator falling silent (the detector's `end`) to the first sentence of the answer starting to play. */
  endToFirstAudioMs: number | null;
  /** From the detector noticing the operator talking over Lucy to every one of her sounds being stopped. */
  bargeInStopMs: number | null;
}

/** Everything the panel shows; the session reports changes to it piece by piece. */
export interface LucyLiveView {
  status: LucyLiveStatusKind;
  lucyState: LucyLiveState;
  /** The latest transcript of what the operator said; `operatorFinal` tells whether it can still change. */
  operatorText: string;
  operatorFinal: boolean;
  /** The sentences of Lucy's current answer received so far. */
  lucyText: string;
  lastTurnEnd: LucyLiveTurnEnd | null;
  timings: LucyLiveTimings;
  /** Microphone loudness, 0..1, for a level indicator. */
  micLevel: number;
  /** A problem worth showing, if any. */
  errorMessage: string | null;
}

export const INITIAL_VIEW: LucyLiveView = {
  status: 'off',
  lucyState: 'idle',
  operatorText: '',
  operatorFinal: false,
  lucyText: '',
  lastTurnEnd: null,
  timings: { endToFirstAudioMs: null, bargeInStopMs: null },
  micLevel: 0,
  errorMessage: null,
};

export interface LucyLiveSessionOptions {
  language: LucyLiveLanguage;
  onView: (patch: Partial<LucyLiveView>) => void;
  /** The session cannot continue; the caller should drop it. */
  onFatal: (status: 'unavailable' | 'error', message: string) => void;
}

/** Microphone samples delivered per chunk, at the capture rate. Small, so a barge-in is noticed within a few tens of milliseconds. */
const CAPTURE_CHUNK_SAMPLES = 1024;
/** Samples per detector frame at 16 kHz (32 ms). */
const FRAME_SAMPLES = 512;
/** Head start given to a sentence's first sound so scheduling cannot land in the past, in seconds. */
const START_LEAD_S = 0.02;
/** Wait before the one automatic reconnect, in milliseconds. */
const RECONNECT_DELAY_MS = 500;
/** A connection that stayed up this long earns a fresh reconnect attempt when it later drops. */
const STABLE_CONNECTION_MS = 30_000;
/** Do not report the microphone level more often than this, in milliseconds. */
const LEVEL_REPORT_INTERVAL_MS = 80;
const WS_OPEN = 1;

/** Server error codes that spoil one turn but not the session. */
const PER_TURN_ERRORS = new Set(['recogniser_failed', 'model_failed', 'speech_failed']);

let turnCounter = 0;
function newTurnId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `turn-${Date.now().toString(36)}-${(turnCounter++).toString(36)}`;
}

/** Resample mono audio to 16 kHz with linear interpolation. */
export function resampleTo16k(input: Float32Array, sourceRate: number): Float32Array {
  if (sourceRate === LUCY_LIVE_SAMPLE_RATE) return input;
  const ratio = sourceRate / LUCY_LIVE_SAMPLE_RATE;
  const length = Math.floor(input.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    out[i] = index + 1 < input.length ? input[index] * (1 - fraction) + input[index + 1] * fraction : input[index];
  }
  return out;
}

/** Signed 16-bit little-endian PCM, as the server expects. */
export function toPcm16(frame: Float32Array): ArrayBuffer {
  const out = new Int16Array(frame.length);
  for (let i = 0; i < frame.length; i++) {
    out[i] = Math.max(-32768, Math.min(32767, Math.round(frame[i] * 32767)));
  }
  return out.buffer as ArrayBuffer;
}

function base64ToBytes(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer as ArrayBuffer;
}

/** A sentence that has been handed to the audio engine. */
interface ScheduledSentence {
  turnId: string;
  seq: number;
  source: AudioBufferSourceNode;
  /** True once the bus knows it is the one playing (it is the head of the queue). */
  announced: boolean;
}

export class LucyLiveSession {
  private readonly detector: VoiceDetector = createVoiceDetector();
  /** Identity under which this session speaks on the speech bus. */
  private readonly busOwner = { name: 'lucy live' };

  private stopped = false;
  private ready = false;
  private ws: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private captureContext: AudioContext | null = null;
  private captureNode: AudioNode | null = null;
  private playContext: AudioContext | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectsUsed = 0;
  private readyAt = 0;

  private lucyState: LucyLiveState = 'idle';
  private currentTurnId: string | null = null;
  /** True between `speech_start` and `speech_end`/`speech_cancel`: microphone audio is being sent. */
  private sending = false;
  private endedAt: number | null = null;
  private firstAudioSeen = false;
  private lucyText = '';

  private leftover = new Float32Array(0);
  private lastLevelReport = 0;
  private lastLevel = 0;

  // Playback
  private active: ScheduledSentence[] = [];
  private pending = new Map<number, AudioBuffer | null>();
  private nextSeq = 0;
  private playHead = 0;
  /** Bumped whenever playback is cut or a new turn begins, so sentences still being decoded are dropped. */
  private playGeneration = 0;

  private timings: LucyLiveTimings = { ...INITIAL_VIEW.timings };

  constructor(private readonly options: LucyLiveSessionOptions) {}

  /** Open the microphone and the socket. Failures are reported through `onFatal`. */
  async start(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (this.stopped) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      this.stream = stream;
      const sourceRate = stream.getAudioTracks()[0]?.getSettings().sampleRate ?? 48_000;
      const context = new AudioContext({ sampleRate: sourceRate });
      this.captureContext = context;
      const source = context.createMediaStreamSource(stream);
      const onChunk = (chunk: Float32Array): void => this.onChunk(chunk, sourceRate);
      const worklet = await tryCreateWorkletNode(context, source, onChunk, () => !this.stopped, () => undefined, CAPTURE_CHUNK_SAMPLES);
      if (this.stopped) {
        worklet?.disconnect();
        return;
      }
      this.captureNode = worklet ?? createScriptProcessorFallback(context, source, onChunk, CAPTURE_CHUNK_SAMPLES);
    } catch (err) {
      if (this.stopped) return;
      const denied = err instanceof DOMException && err.name === 'NotAllowedError';
      this.options.onFatal('error', denied ? 'Microphone permission denied' : 'Could not access the microphone');
      return;
    }
    this.openSocket();
  }

  /** Release the microphone, the socket and all audio. Safe to call more than once. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.ready = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.cutPlayback();
    emitSpeechIdle(this.busOwner);
    this.captureNode?.disconnect();
    this.captureNode = null;
    if (this.captureContext) void this.captureContext.close().catch(() => undefined);
    this.captureContext = null;
    if (this.playContext) void this.playContext.close().catch(() => undefined);
    this.playContext = null;
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    this.detachSocket();
  }

  // -------------------------------------------------------------------------
  // Socket
  // -------------------------------------------------------------------------

  private openSocket(): void {
    if (this.stopped) return;
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${scheme}//${location.host}${LUCY_LIVE_WS_PATH}`);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      if (this.ws === ws) this.send({ type: 'hello', language: this.options.language });
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws || typeof event.data !== 'string') return;
      let message: LucyLiveServerMessage;
      try {
        message = JSON.parse(event.data) as LucyLiveServerMessage;
      } catch {
        return;
      }
      this.onServerMessage(message);
    };
    ws.onclose = () => {
      if (this.ws === ws && !this.stopped) this.onUnexpectedClose();
    };
  }

  private detachSocket(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      // Already closed.
    }
  }

  private send(message: LucyLiveClientMessage): void {
    if (this.ws?.readyState === WS_OPEN) this.ws.send(JSON.stringify(message));
  }

  private sendPcm(frame: Float32Array): void {
    if (this.ws?.readyState === WS_OPEN) this.ws.send(toPcm16(frame));
  }

  /** The connection dropped: reconnect once (again after a long-lived connection), then give up. */
  private onUnexpectedClose(): void {
    const wasStable = this.readyAt > 0 && performance.now() - this.readyAt >= STABLE_CONNECTION_MS;
    if (wasStable) this.reconnectsUsed = 0;
    this.ready = false;
    this.sending = false;
    this.detector.reset();
    this.leftover = new Float32Array(0);
    this.cutPlayback();
    this.settleBus();
    this.ws = null;
    this.lucyState = 'idle';
    if (this.reconnectsUsed >= 1) {
      this.options.onFatal('error', 'Lost the connection to Lucy. Turn hands-free off and on to try again.');
      return;
    }
    this.reconnectsUsed += 1;
    this.options.onView({ status: 'connecting', lucyState: 'idle', micLevel: 0 });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, RECONNECT_DELAY_MS);
  }

  private onServerMessage(message: LucyLiveServerMessage): void {
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.readyAt = performance.now();
        this.options.onView({ status: 'ready', errorMessage: null });
        break;
      case 'state':
        this.lucyState = message.state;
        this.options.onView({ lucyState: message.state });
        if (message.state === 'thinking') {
          if (this.active.length === 0) emitSpeechGenerating(this.busOwner);
        } else if (message.state !== 'speaking') {
          this.settleBus();
        }
        break;
      case 'transcript':
        if (message.turnId !== this.currentTurnId) break;
        this.options.onView({ operatorText: message.text, operatorFinal: message.final });
        break;
      case 'sentence':
        this.onSentence(message);
        break;
      case 'turn_done':
        if (message.turnId !== this.currentTurnId) break;
        // A sentence that never arrived must not hold back the ones behind it.
        if (this.pending.size > 0 && !this.pending.has(this.nextSeq)) {
          this.nextSeq = Math.min(...this.pending.keys());
          this.pump();
        }
        this.options.onView({ lastTurnEnd: message.end });
        this.settleBus();
        break;
      case 'error':
        if (PER_TURN_ERRORS.has(message.code)) {
          this.options.onView({ errorMessage: message.message });
        } else {
          this.options.onFatal(message.code === 'unavailable' ? 'unavailable' : 'error', message.message);
        }
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Microphone and voice detection
  // -------------------------------------------------------------------------

  private onChunk(chunk: Float32Array, sourceRate: number): void {
    if (this.stopped || !this.ready || chunk.length === 0) return;
    const resampled = resampleTo16k(chunk, sourceRate);
    const joined = new Float32Array(this.leftover.length + resampled.length);
    joined.set(this.leftover, 0);
    joined.set(resampled, this.leftover.length);
    let offset = 0;
    while (joined.length - offset >= FRAME_SAMPLES) {
      // A copy: the detector keeps frames for its pre-roll.
      this.onFrame(joined.slice(offset, offset + FRAME_SAMPLES));
      offset += FRAME_SAMPLES;
    }
    this.leftover = joined.slice(offset);
  }

  /** Lucy is thinking, talking, or has sound queued: the operator speaking now means "stop". */
  private lucyBusy(): boolean {
    return this.lucyState === 'thinking' || this.lucyState === 'speaking' || this.active.length > 0 || this.pending.size > 0;
  }

  private onFrame(frame: Float32Array): void {
    const events = this.detector.push(frame, this.lucyBusy() ? 'guarded' : 'normal');
    this.reportLevel();
    for (const event of events) {
      switch (event.type) {
        case 'start':
          this.onSpeechStart(event.preRoll);
          break;
        case 'frame':
          if (this.sending) this.sendPcm(event.frame);
          break;
        case 'end':
          this.onSpeechEnd();
          break;
        case 'misfire':
          this.onMisfire();
          break;
      }
    }
  }

  private reportLevel(): void {
    const now = performance.now();
    if (now - this.lastLevelReport < LEVEL_REPORT_INTERVAL_MS) return;
    const level = Math.min(1, Math.max(0, (this.detector.levelDb + 60) / 60));
    if (Math.abs(level - this.lastLevel) < 0.03) return;
    this.lastLevelReport = now;
    this.lastLevel = level;
    this.options.onView({ micLevel: level });
  }

  private onSpeechStart(preRoll: Float32Array[]): void {
    const detectedAt = performance.now();
    if (this.lucyBusy()) {
      // Everything audible stops in this same call stack; nothing below waits for the server.
      const cut = this.cutPlayback();
      emitSpeechIdle(this.busOwner);
      const stopMs = performance.now() - detectedAt;
      for (const sentence of cut) {
        this.send({ type: 'played', turnId: sentence.turnId, seq: sentence.seq, complete: false });
      }
      this.send({ type: 'barge_in' });
      this.lucyText = '';
      this.timings = { ...this.timings, bargeInStopMs: stopMs };
      this.options.onView({ lucyText: '', timings: this.timings, lastTurnEnd: 'interrupted' });
      track({ type: 'lucy_live_timing', kind: 'barge_in_stop', ms: Math.round(stopMs * 10) / 10 });
    }
    const turnId = newTurnId();
    this.currentTurnId = turnId;
    this.sending = true;
    this.endedAt = null;
    this.firstAudioSeen = false;
    // A new turn starts a fresh answer; sentences still decoding for the last one are dropped.
    this.playGeneration += 1;
    this.pending.clear();
    this.nextSeq = 0;
    this.send({ type: 'speech_start', turnId });
    for (const frame of preRoll) this.sendPcm(frame);
  }

  private onSpeechEnd(): void {
    if (!this.sending || !this.currentTurnId) return;
    this.sending = false;
    this.endedAt = performance.now();
    this.lucyText = '';
    this.send({ type: 'speech_end', turnId: this.currentTurnId });
    this.options.onView({ lucyText: '', operatorText: '', operatorFinal: false });
  }

  private onMisfire(): void {
    if (!this.sending || !this.currentTurnId) return;
    this.sending = false;
    this.send({ type: 'speech_cancel', turnId: this.currentTurnId });
  }

  // -------------------------------------------------------------------------
  // Playback
  // -------------------------------------------------------------------------

  private audioContext(): AudioContext {
    if (!this.playContext) this.playContext = new AudioContext();
    return this.playContext;
  }

  private onSentence(message: Extract<LucyLiveServerMessage, { type: 'sentence' }>): void {
    // Sentences of an earlier turn (still in flight when the operator interrupted) are not played.
    if (message.turnId !== this.currentTurnId || this.sending) return;
    this.lucyText = this.lucyText ? `${this.lucyText} ${message.text}` : message.text;
    this.options.onView({ lucyText: this.lucyText });
    const generation = this.playGeneration;
    const context = this.audioContext();
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
    let bytes: ArrayBuffer;
    try {
      bytes = base64ToBytes(message.wavBase64);
    } catch {
      this.pending.set(message.seq, null);
      this.pump();
      return;
    }
    context.decodeAudioData(bytes).then(
      (buffer) => this.onDecoded(generation, message.seq, buffer),
      () => this.onDecoded(generation, message.seq, null),
    );
  }

  private onDecoded(generation: number, seq: number, buffer: AudioBuffer | null): void {
    if (this.stopped || generation !== this.playGeneration) return;
    this.pending.set(seq, buffer);
    this.pump();
  }

  /** Schedule every decoded sentence that is next in `seq` order. */
  private pump(): void {
    while (this.pending.has(this.nextSeq)) {
      const buffer = this.pending.get(this.nextSeq) ?? null;
      this.pending.delete(this.nextSeq);
      const seq = this.nextSeq;
      this.nextSeq += 1;
      if (buffer && this.currentTurnId) this.schedule(this.currentTurnId, seq, buffer);
    }
  }

  private schedule(turnId: string, seq: number, buffer: AudioBuffer): void {
    const context = this.audioContext();
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const now = context.currentTime;
    // Back to back with the previous sentence when it is still playing, so there is no audible gap.
    const startAt = Math.max(now + START_LEAD_S, this.playHead);
    this.playHead = startAt + buffer.duration;
    const sentence: ScheduledSentence = { turnId, seq, source, announced: false };
    const wasIdle = this.active.length === 0;
    this.active.push(sentence);
    source.onended = () => this.onSentenceEnded(sentence);
    source.start(startAt);
    if (!this.firstAudioSeen && this.endedAt !== null) {
      this.firstAudioSeen = true;
      const ms = performance.now() - this.endedAt;
      this.timings = { ...this.timings, endToFirstAudioMs: ms };
      this.options.onView({ timings: this.timings });
      track({ type: 'lucy_live_timing', kind: 'end_to_first_audio', ms: Math.round(ms) });
    }
    if (wasIdle) this.announce(sentence);
  }

  /** Tell the speech bus this sentence is the one being heard, so the avatar's mouth follows its loudness. */
  private announce(sentence: ScheduledSentence): void {
    sentence.announced = true;
    emitSpeechPlaying(this.busOwner, this.audioContext(), sentence.source);
  }

  private onSentenceEnded(sentence: ScheduledSentence): void {
    const index = this.active.indexOf(sentence);
    if (index < 0) return;
    this.active.splice(index, 1);
    this.send({ type: 'played', turnId: sentence.turnId, seq: sentence.seq, complete: true });
    const next = this.active[0];
    if (next && !next.announced) this.announce(next);
    else if (!next) this.settleBus();
  }

  /**
   * Stop every sound now and forget what was queued. Returns the sentences that had begun
   * playing, so the caller can report them as heard only in part.
   */
  private cutPlayback(): ScheduledSentence[] {
    const heard = this.active.filter((s) => s.announced);
    for (const sentence of this.active) {
      sentence.source.onended = null;
      try {
        sentence.source.stop();
      } catch {
        // Not started yet or already stopped.
      }
      try {
        sentence.source.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    this.active = [];
    this.pending.clear();
    this.playHead = 0;
    this.playGeneration += 1;
    return heard;
  }

  /** Bring the speech bus in line with what is audible: "preparing" while Lucy thinks, otherwise idle. */
  private settleBus(): void {
    if (this.active.length > 0 || this.pending.size > 0) return;
    if (this.lucyState === 'thinking') emitSpeechGenerating(this.busOwner);
    else emitSpeechIdle(this.busOwner);
  }
}

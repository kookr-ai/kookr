/**
 * Lucy live: a hands-free spoken conversation with Lucy, the avatar panel's character.
 *
 * How a turn works. The browser listens to the microphone and decides, with a simple
 * voice detector, when the operator starts and stops speaking. While the operator
 * speaks, it streams the audio to the Kookr server over one WebSocket
 * (`/ws/lucy-live`). The server forwards that audio to a local speech recogniser
 * (the LFM3-Omni model in a llama.cpp sidecar, used only to transcribe), asks the
 * helper language model for an answer with the current task status as context, and
 * sends the answer back one sentence at a time, each already turned into speech by
 * Kookr's speech service (Kokoro, the operator's chosen voice). The first sentence
 * plays while the rest is still being written.
 *
 * Interrupting. If the operator starts speaking while Lucy is thinking or speaking,
 * the browser stops her audio at once and sends `barge_in`; the server abandons the
 * answer in progress.
 *
 * Wire format. Text frames are JSON matching the unions below. Binary frames, sent
 * only by the browser between `speech_start` and `speech_end`, are raw PCM: signed
 * 16-bit little-endian, mono, at `LUCY_LIVE_SAMPLE_RATE`.
 */

/** Sample rate of the microphone audio the browser sends, in Hz. */
export const LUCY_LIVE_SAMPLE_RATE = 16_000;

/** WebSocket path on the Kookr server. Authenticated like the dashboard socket. */
export const LUCY_LIVE_WS_PATH = '/ws/lucy-live';

/** HTTP route that tells the dashboard whether Lucy live can be switched on. */
export const LUCY_LIVE_STATUS_PATH = '/api/lucy-live/status';

/** Longest single operator turn the server accepts, in seconds of audio. Longer audio is cut there. */
export const LUCY_LIVE_MAX_TURN_SECONDS = 30;

/** Languages the operator can speak to Lucy in. Lucy always answers in English for now (her voice is English-only). */
export type LucyLiveLanguage = 'en' | 'fr';

export interface LucyLiveStatus {
  /** True when every part is configured: speech recogniser, helper model and speech service. */
  available: boolean;
  /** Why it is unavailable, in words the operator can act on. Absent when available. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Browser -> server
// ---------------------------------------------------------------------------

export type LucyLiveClientMessage =
  /** First message after the socket opens. */
  | { type: 'hello'; language: LucyLiveLanguage }
  /**
   * The operator started speaking. Binary audio frames follow, starting with a short
   * stretch from just before speech was detected so the first syllable is not lost.
   * If Lucy is thinking or speaking, this also interrupts her (the browser has already
   * stopped her audio).
   */
  | { type: 'speech_start'; turnId: string }
  /** The operator stopped speaking: transcribe and answer. */
  | { type: 'speech_end'; turnId: string }
  /**
   * The voice detector fired but the sound was too short to be speech (a cough, a
   * click). Drop the audio of this turn without answering.
   */
  | { type: 'speech_cancel'; turnId: string }
  /** The operator talked over Lucy. Abandon the current answer; a `speech_start` may follow. */
  | { type: 'barge_in' }
  /**
   * The browser finished playing an answer sentence (or cut it short). Lets the server
   * record what the operator actually heard, so the conversation history stays honest.
   */
  | { type: 'played'; turnId: string; seq: number; complete: boolean };

// ---------------------------------------------------------------------------
// Server -> browser
// ---------------------------------------------------------------------------

/** What Lucy is doing, for the avatar's state label and animation. */
export type LucyLiveState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking';

/** Why a turn ended. */
export type LucyLiveTurnEnd =
  | 'answered'
  /** The operator talked over her. */
  | 'interrupted'
  /** Nothing intelligible was heard; no answer was given. */
  | 'empty'
  | 'error';

export type LucyLiveServerMessage =
  | { type: 'ready' }
  | { type: 'state'; state: LucyLiveState }
  /**
   * What the operator said. `final: false` is a draft that may still change while they
   * talk (it is re-transcribed as more audio arrives); `final: true` is what Lucy answers.
   */
  | { type: 'transcript'; turnId: string; text: string; final: boolean }
  /**
   * One spoken sentence of Lucy's answer, ready to play. `seq` counts from 0 within the
   * turn; the browser plays sentences in `seq` order. `wavBase64` is a complete WAV file.
   */
  | { type: 'sentence'; turnId: string; seq: number; text: string; wavBase64: string; durationMs: number }
  | { type: 'turn_done'; turnId: string; end: LucyLiveTurnEnd; reason?: string }
  /** A problem with the session as a whole; the browser shows `message` and may reconnect. */
  | { type: 'error'; code: LucyLiveErrorCode; message: string };

export type LucyLiveErrorCode =
  | 'unavailable'
  | 'recogniser_failed'
  | 'model_failed'
  | 'speech_failed'
  | 'bad_message'
  | 'internal';

export function isLucyLiveClientMessage(value: unknown): value is LucyLiveClientMessage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case 'hello':
      return v.language === 'en' || v.language === 'fr';
    case 'speech_start':
    case 'speech_end':
    case 'speech_cancel':
      return typeof v.turnId === 'string' && v.turnId.length > 0 && v.turnId.length <= 64;
    case 'barge_in':
      return true;
    case 'played':
      return typeof v.turnId === 'string' && v.turnId.length > 0 && v.turnId.length <= 64
        && typeof v.seq === 'number' && Number.isInteger(v.seq) && v.seq >= 0
        && typeof v.complete === 'boolean';
    default:
      return false;
  }
}

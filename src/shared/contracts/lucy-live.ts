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
 * Interrupting. A loud sound is not always speech (a cough, a door), so Lucy is not cut
 * off on loudness alone. When the operator starts speaking while Lucy is thinking or
 * speaking, the browser lowers her volume ("ducks" it) and sends `speech_start` with the
 * audio as usual; the server treats it as a candidate interruption and runs the audio
 * through Silero, a small speech detector, without touching the answer in progress.
 * If Silero hears real speech the server replies `speech_confirmed`, abandons the answer
 * and starts listening to that audio as a new turn; the browser then stops her audio. If
 * it was not speech the server replies `speech_rejected`, discards the audio, and the
 * browser restores her volume. When the server has no Silero (`bargeInConfirmation: 'off'`
 * in the status), the older behaviour applies: the browser stops her audio at once and
 * sends `barge_in`, then `speech_start`.
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
  /**
   * How an interruption is decided. `silero`: the server confirms that the operator really
   * spoke before Lucy stops. `off`: it cannot, so the browser stops her at once. Absent on
   * older servers, which the browser treats as `off`.
   */
  bargeInConfirmation?: 'silero' | 'off';
  /**
   * True while Kookr is still bringing up the speech recogniser it manages (`KOOKR_LUCY_EARS=true`;
   * the first start downloads about 2.4 GB). `available` is false and `reason` says so; Lucy live
   * switches on by itself when the recogniser is healthy, so the dashboard can show "starting"
   * instead of "unavailable" and poll again.
   */
  starting?: boolean;
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
   *
   * If the browser says Lucy is audible or busy (`lucyAudible` true; when an older client
   * omits it, the server falls back to whether it is itself answering) and the server has
   * Silero, this is only a candidate interruption: the server answers with `speech_confirmed` or
   * `speech_rejected`, and the answer in progress is left alone until then. Without
   * Silero it interrupts her at once, as the browser has already stopped her audio.
   */
  | { type: 'speech_start'; turnId: string; lucyAudible?: boolean }
  /** The operator stopped speaking: transcribe and answer. */
  | { type: 'speech_end'; turnId: string }
  /**
   * The voice detector fired but the sound was too short to be speech (a cough, a
   * click). Drop the audio of this turn without answering.
   */
  | { type: 'speech_cancel'; turnId: string }
  /**
   * The operator talked over Lucy. Abandon the current answer; a `speech_start` may follow.
   * If a candidate interruption is still undecided (the browser gave up waiting for a
   * verdict and keeps streaming that audio), it is treated as confirmed: the server
   * answers `speech_confirmed`, abandons the answer and listens to the candidate's audio
   * as a normal turn, so the operator's words are not lost.
   */
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
  /**
   * Silero heard real speech in the candidate interruption `turnId`: stop Lucy now. The
   * server has already abandoned her answer (`turn_done` with `interrupted` follows) and
   * is listening to that audio as the turn `turnId`.
   */
  | { type: 'speech_confirmed'; turnId: string }
  /**
   * The candidate interruption `turnId` was not speech (too short, or Silero heard only
   * noise): restore Lucy's volume and carry on. The server dropped that audio and her
   * answer continues untouched.
   */
  | { type: 'speech_rejected'; turnId: string }
  /**
   * A problem with the session as a whole (not with one turn: a failed recogniser, model or
   * speech service is reported as `turn_done` with `end: 'error'` and a `reason`, and the
   * session carries on). The browser shows `message`. Only `unavailable` ends the session;
   * with the socket still open, `bad_message` and `internal` are shown and the conversation continues.
   */
  | { type: 'error'; code: LucyLiveErrorCode; message: string };

/**
 * `bad_message`: a frame was malformed, unknown or too large. `internal`: the server failed
 * while handling a message. `unavailable` is reserved for a server that cannot run Lucy live
 * at all (today that is reported by the status route and the upgrade refusal instead).
 */
export type LucyLiveErrorCode = 'unavailable' | 'bad_message' | 'internal';

export function isLucyLiveClientMessage(value: unknown): value is LucyLiveClientMessage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case 'hello':
      return v.language === 'en' || v.language === 'fr';
    case 'speech_start':
      return typeof v.turnId === 'string' && v.turnId.length > 0 && v.turnId.length <= 64
        && (v.lucyAudible === undefined || typeof v.lucyAudible === 'boolean');
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

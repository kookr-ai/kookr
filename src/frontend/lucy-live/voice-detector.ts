/**
 * A small voice detector for hands-free talk with Lucy.
 *
 * It answers one question over and over: "is the operator speaking right now?".
 * It does so from loudness alone, with no model: it keeps an estimate of the
 * room's background loudness (the "noise floor") and calls a stretch of audio
 * speech when it stays clearly above that floor for long enough. A cough or a
 * click is loud but too short; a fan is steady and gets absorbed into the floor.
 *
 * Two features keep it from misfiring:
 * - Hysteresis. Starting needs a high bar held for a while; staying in speech
 *   needs a lower bar, and ending needs a sustained stretch below it. So the
 *   short dips between words do not chop one sentence into several turns.
 * - A guarded mode, used while Lucy is thinking or speaking. Her own voice can
 *   leak into the microphone and a small noise should not cut her off, so
 *   interrupting her needs a louder, longer sound than starting a conversation.
 *
 * The detector is pure: feed it frames, it returns events. It never touches the
 * microphone, the clock or the network, which keeps it easy to test.
 */

/** Sample rate the detector expects, in Hz. Frame durations are derived from it. */
export const DETECTOR_SAMPLE_RATE = 16_000;

/** Level reported for digital silence, in dB relative to full scale. */
const SILENCE_DB = -100;

/** Starting estimate of the room's background loudness, in dBFS, before any audio has been heard. */
export const INITIAL_NOISE_FLOOR_DB = -55;
/** The noise floor is never allowed outside this range, so a dead-silent or very noisy input cannot break the thresholds. */
export const MIN_NOISE_FLOOR_DB = -70;
export const MAX_NOISE_FLOOR_DB = -35;
/** Speech is never reported below this level, whatever the floor says (guards against hiss on a nearly silent input). */
export const ABSOLUTE_MIN_SPEECH_DB = -50;

/** How far above the noise floor a frame must be to count as loud when starting a normal turn, in dB. */
export const START_MARGIN_DB = 12;
/** The higher bar while Lucy is thinking or speaking (guarded mode), in dB above the floor. */
export const GUARDED_START_MARGIN_DB = 20;
/** Once speech has started, a frame this far above the floor still counts as speech (lower than the start bar: hysteresis). */
export const STAY_MARGIN_DB = 8;

/** Loud for this long in a row starts a normal turn. */
export const START_MS = 150;
/** Guarded mode: loud for this long in a row before Lucy is interrupted. The long wait is the only protection when nothing else checks the sound. */
export const GUARDED_START_MS = 300;
/**
 * Guarded mode when the server confirms interruptions with Silero (a speech detector): loud
 * for this long in a row starts a *candidate* interruption. A cough or click that gets this
 * far only ducks Lucy for a moment and is then rejected by Silero, so the wait can be as short
 * as a normal start; the shorter wait makes real interruptions feel quicker.
 */
export const CONFIRMED_GUARDED_START_MS = 150;
/** Below the stay bar for this long ends the turn. */
export const END_SILENCE_MS = 600;
/** Audio kept from before the detector fired, so the first syllable is not lost. */
export const PRE_ROLL_MS = 300;
/** A turn with less actual speech than this is a misfire (a click, a cough), not something to answer. */
export const MIN_SPEECH_MS = 250;
/** A turn is ended by force after this long (the server accepts about this much audio per turn). */
export const MAX_TURN_MS = 30_000;

/** How fast the noise floor follows a quieter room (per frame, 0..1): it falls readily. */
const FLOOR_FALL_RATE = 0.05;
/** How fast it follows a louder room: slowly, so speech onsets are not absorbed into it. */
const FLOOR_RISE_RATE = 0.005;
/** How fast the "recent loudness" used to absorb a rejected sound follows the latest frames (per frame, 0..1). */
const RECENT_LEVEL_RATE = 0.25;

/** `normal` when nobody else is talking, `guarded` while Lucy thinks or speaks. */
export type DetectorMode = 'normal' | 'guarded';

export type VoiceEvent =
  /** Speech began. `preRoll` is the audio from just before it (oldest first), including the frames that triggered it. */
  | { type: 'start'; preRoll: Float32Array[] }
  /** One frame of audio while speech is ongoing (including the quiet tail before the end). */
  | { type: 'frame'; frame: Float32Array }
  /** The operator finished speaking; `speechMs` is how much of the turn was actual speech. */
  | { type: 'end'; speechMs: number }
  /** The turn was too short to be speech. Drop what was sent. */
  | { type: 'misfire' };

export interface VoiceDetector {
  /**
   * Feed one frame of 16 kHz mono audio (about 20-32 ms). The detector keeps a
   * reference to the frame, so pass a fresh array each time. Returns what
   * happened because of this frame, in order.
   */
  push(frame: Float32Array, mode: DetectorMode): VoiceEvent[];
  /** Forget any turn in progress (the caller dropped the connection, say). The noise floor is kept. */
  reset(): void;
  /**
   * The sound that is going on right now was judged not to be speech (the server rejected it).
   * Forget the turn and raise the noise floor to that sound's level, so a steady loud noise
   * (a drone, a fan switched on) is absorbed instead of starting a new candidate over and over.
   * Real speech louder than the new floor plus the usual margin is still detected, and the
   * floor falls back on its own once the room is quieter.
   */
  absorbRejectedSound(): void;
  /** Current noise floor estimate, dBFS. */
  readonly noiseFloorDb: number;
  /** Level of the latest frame, dBFS. */
  readonly levelDb: number;
  readonly speaking: boolean;
}

/** Loudness of a frame as RMS in dB relative to full scale. */
export function frameLevelDb(frame: Float32Array): number {
  if (frame.length === 0) return SILENCE_DB;
  let energy = 0;
  for (let i = 0; i < frame.length; i++) energy += frame[i] * frame[i];
  const rms = Math.sqrt(energy / frame.length);
  return rms <= 1e-5 ? SILENCE_DB : 20 * Math.log10(rms);
}

export interface VoiceDetectorOptions {
  /** How long a loud sound must last to start in guarded mode. Default {@link GUARDED_START_MS}. */
  guardedStartMs?: number;
}

export function createVoiceDetector(options: VoiceDetectorOptions = {}): VoiceDetector {
  const guardedStartMs = options.guardedStartMs ?? GUARDED_START_MS;
  let floorDb = INITIAL_NOISE_FLOOR_DB;
  let lastLevelDb = SILENCE_DB;
  let speaking = false;
  // Frames recently heard while not in speech, oldest first, for the pre-roll.
  let ring: Float32Array[] = [];
  let ringMs = 0;
  // Length of the unbroken loud stretch that may become a start.
  let loudRunMs = 0;
  let speechMs = 0;
  let turnMs = 0;
  let quietRunMs = 0;

  // Smoothed loudness of the latest frames, for absorbRejectedSound().
  let recentLevelDb: number | null = null;

  const clampFloor = (db: number): number => Math.min(MAX_NOISE_FLOOR_DB, Math.max(MIN_NOISE_FLOOR_DB, db));

  function resetTurn(): void {
    speaking = false;
    ring = [];
    ringMs = 0;
    loudRunMs = 0;
    speechMs = 0;
    turnMs = 0;
    quietRunMs = 0;
  }

  function push(frame: Float32Array, mode: DetectorMode): VoiceEvent[] {
    const frameMs = (frame.length / DETECTOR_SAMPLE_RATE) * 1000;
    const level = frameLevelDb(frame);
    lastLevelDb = level;
    recentLevelDb = recentLevelDb === null ? level : recentLevelDb + (level - recentLevelDb) * RECENT_LEVEL_RATE;
    const events: VoiceEvent[] = [];

    if (!speaking) {
      const margin = mode === 'guarded' ? GUARDED_START_MARGIN_DB : START_MARGIN_DB;
      const loud = level >= Math.max(floorDb + margin, ABSOLUTE_MIN_SPEECH_DB);
      // The floor follows quiet frames only; a loud frame might be the start of speech.
      if (!loud) {
        const rate = level < floorDb ? FLOOR_FALL_RATE : FLOOR_RISE_RATE;
        floorDb = clampFloor(floorDb + (level - floorDb) * rate);
      }
      ring.push(frame);
      ringMs += frameMs;
      loudRunMs = loud ? loudRunMs + frameMs : 0;
      // Keep the loud run plus the pre-roll that precedes it, and no more.
      while (ring.length > 1 && ringMs - ring[0].length / DETECTOR_SAMPLE_RATE * 1000 >= loudRunMs + PRE_ROLL_MS) {
        ringMs -= (ring.shift() as Float32Array).length / DETECTOR_SAMPLE_RATE * 1000;
      }
      const needMs = mode === 'guarded' ? guardedStartMs : START_MS;
      if (loudRunMs >= needMs) {
        speaking = true;
        speechMs = loudRunMs;
        turnMs = ringMs;
        quietRunMs = 0;
        events.push({ type: 'start', preRoll: ring });
        ring = [];
        ringMs = 0;
        loudRunMs = 0;
      }
      return events;
    }

    turnMs += frameMs;
    events.push({ type: 'frame', frame });
    if (level >= Math.max(floorDb + STAY_MARGIN_DB, ABSOLUTE_MIN_SPEECH_DB)) {
      speechMs += frameMs;
      quietRunMs = 0;
    } else {
      quietRunMs += frameMs;
    }

    const silenceEnded = quietRunMs >= END_SILENCE_MS;
    const tooLong = turnMs >= MAX_TURN_MS;
    if (silenceEnded || tooLong) {
      const spoken = speechMs;
      // A turn cut for length is a long request, not a noisy room: leave the floor alone, or the
      // operator's own voice becomes the floor and the words that follow need to be louder.
      resetTurn();
      events.push(spoken >= MIN_SPEECH_MS ? { type: 'end', speechMs: spoken } : { type: 'misfire' });
    }
    return events;
  }

  return {
    push,
    reset: resetTurn,
    absorbRejectedSound() {
      resetTurn();
      if (recentLevelDb !== null) floorDb = Math.max(floorDb, clampFloor(recentLevelDb));
    },
    get noiseFloorDb() { return floorDb; },
    get levelDb() { return lastLevelDb; },
    get speaking() { return speaking; },
  };
}

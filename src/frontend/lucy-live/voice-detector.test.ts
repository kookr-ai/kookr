import { describe, expect, test } from 'vitest';
import {
  ABSOLUTE_MIN_SPEECH_DB,
  DETECTOR_SAMPLE_RATE,
  END_SILENCE_MS,
  CONFIRMED_GUARDED_START_MS,
  GUARDED_START_MS,
  INITIAL_NOISE_FLOOR_DB,
  MAX_TURN_MS,
  MIN_SPEECH_MS,
  PRE_ROLL_MS,
  START_MS,
  createVoiceDetector,
  frameLevelDb,
  type DetectorMode,
  type VoiceEvent,
} from './voice-detector.js';

const FRAME_SAMPLES = 512; // 32 ms
const FRAME_MS = (FRAME_SAMPLES / DETECTOR_SAMPLE_RATE) * 1000;

/** A frame of constant amplitude square wave: its RMS equals `amplitude`. */
function frameAt(db: number): Float32Array {
  const amplitude = 10 ** (db / 20);
  const frame = new Float32Array(FRAME_SAMPLES);
  for (let i = 0; i < FRAME_SAMPLES; i++) frame[i] = i % 2 === 0 ? amplitude : -amplitude;
  return frame;
}

const QUIET_DB = -65;
const SPEECH_DB = -25; // 40 dB over the quiet room
const LOUD_DB = -10;

/** Feed `ms` of audio at `db`; returns every event emitted. */
function feed(detector: ReturnType<typeof createVoiceDetector>, db: number, ms: number, mode: DetectorMode = 'normal'): VoiceEvent[] {
  const events: VoiceEvent[] = [];
  for (let t = 0; t < ms; t += FRAME_MS) events.push(...detector.push(frameAt(db), mode));
  return events;
}
const types = (events: VoiceEvent[]): string[] => events.map((e) => e.type);
const firstOf = (events: VoiceEvent[], type: VoiceEvent['type']): VoiceEvent | undefined => events.find((e) => e.type === type);

describe('frameLevelDb', () => {
  test('reports RMS in dBFS and floors digital silence', () => {
    expect(frameLevelDb(frameAt(-20))).toBeCloseTo(-20, 1);
    expect(frameLevelDb(new Float32Array(512))).toBe(-100);
    expect(frameLevelDb(new Float32Array(0))).toBe(-100);
  });
});

describe('createVoiceDetector', () => {
  test('starts after sustained speech and not before', () => {
    const d = createVoiceDetector();
    feed(d, QUIET_DB, 1000);
    const early = feed(d, SPEECH_DB, START_MS - 2 * FRAME_MS);
    expect(types(early)).not.toContain('start');
    const rest = feed(d, SPEECH_DB, 3 * FRAME_MS);
    expect(types(rest)).toContain('start');
    expect(d.speaking).toBe(true);
  });

  test('a short click does not start a turn and leaves no misfire to cancel', () => {
    const d = createVoiceDetector();
    feed(d, QUIET_DB, 500);
    const events = [...feed(d, LOUD_DB, 2 * FRAME_MS), ...feed(d, QUIET_DB, 1500)];
    expect(events).toEqual([]);
    expect(d.speaking).toBe(false);
  });

  test('a loud run broken by silence starts over', () => {
    const d = createVoiceDetector();
    const events = [
      ...feed(d, SPEECH_DB, START_MS - 2 * FRAME_MS),
      ...feed(d, QUIET_DB, FRAME_MS),
      ...feed(d, SPEECH_DB, START_MS - 2 * FRAME_MS),
    ];
    expect(types(events)).not.toContain('start');
  });

  test('guarded mode ignores a sound that would start a normal turn', () => {
    const d = createVoiceDetector();
    feed(d, QUIET_DB, 1000);
    // Long enough for normal mode but shorter than the guarded delay.
    const events = feed(d, SPEECH_DB, GUARDED_START_MS - 2 * FRAME_MS, 'guarded');
    expect(types(events)).not.toContain('start');
    const more = feed(d, SPEECH_DB, 3 * FRAME_MS, 'guarded');
    expect(types(more)).toContain('start');
  });

  test('with a server check behind it, guarded mode starts after the shorter confirmed delay', () => {
    const d = createVoiceDetector({ guardedStartMs: CONFIRMED_GUARDED_START_MS });
    feed(d, QUIET_DB, 1000);
    expect(CONFIRMED_GUARDED_START_MS).toBeLessThan(GUARDED_START_MS);
    expect(types(feed(d, SPEECH_DB, CONFIRMED_GUARDED_START_MS - 2 * FRAME_MS, 'guarded'))).not.toContain('start');
    expect(types(feed(d, SPEECH_DB, 3 * FRAME_MS, 'guarded'))).toContain('start');
  });

  test('guarded mode ignores a moderately loud sound that normal mode accepts', () => {
    // 18 dB over the floor: above the normal bar (12), below the guarded bar (20).
    const level = QUIET_DB + 18;
    const normal = createVoiceDetector();
    feed(normal, QUIET_DB, 1000);
    expect(types(feed(normal, level, 1000))).toContain('start');
    const guarded = createVoiceDetector();
    feed(guarded, QUIET_DB, 1000);
    expect(types(feed(guarded, level, 1000, 'guarded'))).not.toContain('start');
  });

  test('ends after sustained silence, not after a short pause', () => {
    const d = createVoiceDetector();
    feed(d, QUIET_DB, 500);
    feed(d, SPEECH_DB, 800);
    const pause = feed(d, QUIET_DB, END_SILENCE_MS - 3 * FRAME_MS);
    expect(types(pause)).not.toContain('end');
    const resume = feed(d, SPEECH_DB, 200);
    expect(types(resume)).not.toContain('end');
    const silence = feed(d, QUIET_DB, END_SILENCE_MS + 2 * FRAME_MS);
    const end = firstOf(silence, 'end');
    expect(end).toBeDefined();
    expect(d.speaking).toBe(false);
  });

  test('emits every frame after the start, including the quiet tail up to the end', () => {
    const d = createVoiceDetector();
    feed(d, QUIET_DB, 500);
    const events = [...feed(d, SPEECH_DB, 800), ...feed(d, QUIET_DB, END_SILENCE_MS + 100)];
    expect(types(events).indexOf('start')).toBeLessThan(types(events).indexOf('frame'));
    expect(types(events).at(-1)).toBe('end');
    const frames = events.filter((e) => e.type === 'frame').length;
    // Everything after the triggering frames is forwarded: the rest of the speech and the whole silent tail.
    const expected = (800 - START_MS + END_SILENCE_MS) / FRAME_MS;
    expect(frames).toBeGreaterThanOrEqual(expected - 2);
  });

  test('start carries the pre-roll plus the frames that triggered it', () => {
    const d = createVoiceDetector();
    feed(d, QUIET_DB, 2000);
    const events = feed(d, SPEECH_DB, 600);
    const start = firstOf(events, 'start') as Extract<VoiceEvent, { type: 'start' }>;
    const ms = (start.preRoll.length * FRAME_SAMPLES * 1000) / DETECTOR_SAMPLE_RATE;
    // Loud run (>= START_MS, up to one frame over) plus about PRE_ROLL_MS of earlier audio.
    expect(ms).toBeGreaterThanOrEqual(PRE_ROLL_MS + START_MS);
    expect(ms).toBeLessThanOrEqual(PRE_ROLL_MS + START_MS + 2 * FRAME_MS);
    // The oldest pre-roll frame is quiet, the newest is speech.
    expect(frameLevelDb(start.preRoll[0])).toBeLessThan(-60);
    expect(frameLevelDb(start.preRoll[start.preRoll.length - 1])).toBeGreaterThan(-30);
  });

  test('pre-roll is shorter when little audio has been heard yet', () => {
    const d = createVoiceDetector();
    const events = feed(d, SPEECH_DB, 400);
    // Initial floor is -55, speech at -25 clears it; no earlier audio exists.
    const start = firstOf(events, 'start') as Extract<VoiceEvent, { type: 'start' }>;
    expect(start).toBeDefined();
    expect(start.preRoll.length * FRAME_MS).toBeLessThan(START_MS + 2 * FRAME_MS);
  });

  test('speech shorter than the minimum is a misfire', () => {
    const d = createVoiceDetector();
    feed(d, QUIET_DB, 500);
    // Just over the start delay, well under MIN_SPEECH_MS.
    expect(START_MS + 2 * FRAME_MS).toBeLessThan(MIN_SPEECH_MS);
    const events = [...feed(d, SPEECH_DB, START_MS + FRAME_MS), ...feed(d, QUIET_DB, END_SILENCE_MS + 100)];
    expect(types(events)).toContain('start');
    expect(types(events)).toContain('misfire');
    expect(types(events)).not.toContain('end');
    expect(d.speaking).toBe(false);
  });

  test('speech of the minimum length or more is an end, with its speech duration', () => {
    const d = createVoiceDetector();
    feed(d, QUIET_DB, 500);
    const events = [...feed(d, SPEECH_DB, MIN_SPEECH_MS + 100), ...feed(d, QUIET_DB, END_SILENCE_MS + 100)];
    const end = firstOf(events, 'end') as Extract<VoiceEvent, { type: 'end' }>;
    expect(end).toBeDefined();
    expect(end.speechMs).toBeGreaterThanOrEqual(MIN_SPEECH_MS);
  });

  test('the noise floor falls toward a quiet room and rises slowly toward a noisy one', () => {
    const d = createVoiceDetector();
    expect(d.noiseFloorDb).toBe(INITIAL_NOISE_FLOOR_DB);
    feed(d, -68, 3000);
    const quiet = d.noiseFloorDb;
    expect(quiet).toBeLessThan(INITIAL_NOISE_FLOOR_DB - 5);
    // Constant hum 8 dB above the floor: below the start bar, so the floor creeps up to it.
    feed(d, quiet + 8, 20_000);
    expect(d.noiseFloorDb).toBeGreaterThan(quiet + 4);
  });

  test('does not adapt to speech while a turn is in progress', () => {
    const d = createVoiceDetector();
    feed(d, QUIET_DB, 3000);
    const before = d.noiseFloorDb;
    feed(d, SPEECH_DB, 5000);
    expect(d.noiseFloorDb).toBe(before);
  });

  test('a louder floor raises the bar: steady noise is not speech once absorbed', () => {
    const d = createVoiceDetector();
    // A fan at -45 dB is above the initial floor + margin only marginally; after adapting it must not trigger.
    feed(d, -45, 30_000);
    expect(d.speaking).toBe(false);
    expect(types(feed(d, -45, 2000))).not.toContain('start');
    // Speech 25 dB above the fan still gets through.
    expect(types(feed(d, -20, 600))).toContain('start');
  });

  test('never reports speech below the absolute minimum level', () => {
    const d = createVoiceDetector();
    feed(d, -90, 3000);
    expect(types(feed(d, ABSOLUTE_MIN_SPEECH_DB - 3, 2000))).not.toContain('start');
  });

  test('a turn that never ends is cut at the maximum length and counts as speech', () => {
    const d = createVoiceDetector();
    feed(d, QUIET_DB, 500);
    const events = feed(d, SPEECH_DB, MAX_TURN_MS + 1000);
    expect(types(events)).toContain('end');
    expect(d.speaking).toBe(false);
  });

  test('reset drops a turn in progress but keeps the noise floor', () => {
    const d = createVoiceDetector();
    feed(d, QUIET_DB, 3000);
    const floor = d.noiseFloorDb;
    feed(d, SPEECH_DB, 500);
    expect(d.speaking).toBe(true);
    d.reset();
    expect(d.speaking).toBe(false);
    expect(d.noiseFloorDb).toBe(floor);
    expect(types(feed(d, QUIET_DB, 1500))).toEqual([]);
  });

  describe('absorbRejectedSound', () => {
    const DRONE_DB = -30;

    test('a steady drone that was rejected does not start again, in either mode', () => {
      const d = createVoiceDetector({ guardedStartMs: CONFIRMED_GUARDED_START_MS });
      feed(d, QUIET_DB, 1500);
      expect(types(feed(d, DRONE_DB, 600, 'guarded'))).toContain('start');
      d.absorbRejectedSound();
      expect(d.speaking).toBe(false);
      expect(d.noiseFloorDb).toBeGreaterThan(DRONE_DB - 6);
      expect(types(feed(d, DRONE_DB, 5000, 'guarded'))).not.toContain('start');
      expect(types(feed(d, DRONE_DB, 2000, 'normal'))).not.toContain('start');
    });

    test('without absorbing, the same drone restarts straight away (the problem being fixed)', () => {
      const d = createVoiceDetector({ guardedStartMs: CONFIRMED_GUARDED_START_MS });
      feed(d, QUIET_DB, 1500);
      feed(d, DRONE_DB, 600, 'guarded');
      d.reset();
      expect(types(feed(d, DRONE_DB, 600, 'guarded'))).toContain('start');
    });

    test('real speech louder than the new floor plus the margin is still detected over the drone', () => {
      const d = createVoiceDetector({ guardedStartMs: CONFIRMED_GUARDED_START_MS });
      feed(d, QUIET_DB, 1500);
      feed(d, DRONE_DB, 600, 'guarded');
      d.absorbRejectedSound();
      feed(d, DRONE_DB, 1000, 'guarded');
      expect(types(feed(d, -8, 600, 'guarded'))).toContain('start');
    });

    test('the floor falls back once the noise stops', () => {
      const d = createVoiceDetector({ guardedStartMs: CONFIRMED_GUARDED_START_MS });
      feed(d, QUIET_DB, 1500);
      feed(d, DRONE_DB, 600, 'guarded');
      d.absorbRejectedSound();
      const raised = d.noiseFloorDb;
      feed(d, QUIET_DB, 6000);
      expect(d.noiseFloorDb).toBeLessThan(raised - 15);
      expect(types(feed(d, SPEECH_DB, 600))).toContain('start');
    });
  });
});

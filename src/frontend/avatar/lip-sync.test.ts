import { describe, expect, test } from 'vitest';
import {
  SPEECH_VISEMES,
  createLipSyncState,
  createRng,
  damp,
  loudnessFromTimeDomain,
  stepLipSync,
} from './lip-sync.js';

const frame = (fill: (i: number) => number, n = 256) => Uint8Array.from({ length: n }, (_, i) => fill(i));

describe('loudnessFromTimeDomain', () => {
  test('silence (every sample at the midpoint) is zero', () => {
    expect(loudnessFromTimeDomain(frame(() => 128))).toBe(0);
  });

  test('an empty frame is zero rather than NaN', () => {
    expect(loudnessFromTimeDomain(new Uint8Array(0))).toBe(0);
  });

  test('a louder signal gives a larger value, capped at 1', () => {
    const quiet = loudnessFromTimeDomain(frame((i) => 128 + (i % 2 ? 4 : -4)));
    const loud = loudnessFromTimeDomain(frame((i) => 128 + (i % 2 ? 20 : -20)));
    const clipped = loudnessFromTimeDomain(frame((i) => (i % 2 ? 255 : 0)));
    expect(quiet).toBeGreaterThan(0);
    expect(loud).toBeGreaterThan(quiet);
    expect(clipped).toBe(1);
  });

  test('the value is the RMS times the gain', () => {
    // A square wave of +/-16 around 128 has RMS 16/128 = 0.125.
    expect(loudnessFromTimeDomain(frame((i) => 128 + (i % 2 ? 16 : -16)), 2)).toBeCloseTo(0.25, 5);
  });
});

describe('stepLipSync', () => {
  const run = (loudness: number, seconds: number, state = createLipSyncState(), rng = createRng(7)) => {
    for (let t = 0; t < seconds; t += 1 / 60) stepLipSync(state, loudness, 1 / 60, rng);
    return state;
  };

  test('in silence the mouth stays closed', () => {
    const state = run(0, 1);
    expect(state.amp).toBeCloseTo(0, 6);
    for (const v of SPEECH_VISEMES) expect(state.weights[v]).toBeCloseTo(0, 6);
  });

  test('background hiss below the speech threshold never picks a new mouth shape', () => {
    const state = createLipSyncState();
    const before = { viseme: state.viseme, syllableLeft: state.syllableLeft };
    run(0.03, 2, state);
    expect({ viseme: state.viseme, syllableLeft: state.syllableLeft }).toEqual(before);
    // Just above the threshold the rhythm starts.
    run(0.05, 0.1, state);
    expect(state.syllableLeft).toBeGreaterThan(0);
  });

  test('with sound, exactly one mouth shape opens toward the loudness', () => {
    const state = run(0.8, 0.07);
    expect(state.amp).toBeGreaterThan(0.4);
    const open = SPEECH_VISEMES.filter((v) => state.weights[v] > 0.2);
    expect(open).toEqual([state.viseme]);
  });

  test('the mouth shape changes at a syllable rhythm while sound continues', () => {
    const state = createLipSyncState();
    const rng = createRng(7);
    const shapes = new Set<string>();
    const holds: number[] = [];
    for (let i = 0; i < 120; i += 1) {
      const left = state.syllableLeft;
      stepLipSync(state, 0.7, 1 / 60, rng);
      // The countdown only ever goes up when a new shape was just picked.
      if (state.syllableLeft > left) holds.push(state.syllableLeft);
      shapes.add(state.viseme);
    }
    // Every shape is held for 80 to 200 ms.
    for (const hold of holds) {
      expect(hold).toBeGreaterThanOrEqual(0.08);
      expect(hold).toBeLessThanOrEqual(0.2);
    }
    // The length varies from one shape to the next, which is what makes it read as speech rather than a metronome.
    expect(Math.max(...holds) - Math.min(...holds)).toBeGreaterThan(0.03);
    // Two seconds of speech therefore holds 10 to 25 shapes; a hold ends on the next 60 Hz frame,
    // which can stretch each one by up to 17 ms, so 9 is the true lower bound.
    expect(holds.length).toBeGreaterThanOrEqual(9);
    expect(holds.length).toBeLessThanOrEqual(25);
    // And it is not the same shape over and over.
    expect(shapes.size).toBeGreaterThan(3);
  });

  test('when the sound stops the mouth relaxes back to closed', () => {
    const state = run(0.9, 0.5);
    run(0, 0.6, state);
    expect(state.amp).toBeLessThan(0.01);
    for (const v of SPEECH_VISEMES) expect(state.weights[v]).toBeLessThan(0.01);
  });

  test('weights never leave 0..1 even for out-of-range loudness', () => {
    const state = run(7, 1);
    run(-3, 0.2, state);
    for (const v of SPEECH_VISEMES) {
      expect(state.weights[v]).toBeGreaterThanOrEqual(0);
      expect(state.weights[v]).toBeLessThanOrEqual(1);
    }
  });

  test('the same seed gives the same sequence', () => {
    const a = run(0.6, 1, createLipSyncState(), createRng(3));
    const b = run(0.6, 1, createLipSyncState(), createRng(3));
    expect(a).toEqual(b);
  });
});

describe('helpers', () => {
  test('damp moves nothing in zero time and approaches 1 for long steps', () => {
    expect(damp(10, 0)).toBe(0);
    expect(damp(10, 10)).toBeCloseTo(1, 6);
  });

  test('createRng yields values in (0, 1) and tolerates a zero or negative seed', () => {
    for (const seed of [0, -5, 1, 2147483647]) {
      const rng = createRng(seed);
      for (let i = 0; i < 50; i += 1) {
        const v = rng();
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThan(1);
      }
    }
  });
});
